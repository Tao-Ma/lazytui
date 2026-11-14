/**
 * Special keys on the wire — decode a host terminal's key sequence into a named
 * key, and encode a named key the way xterm sends it (pure leaf).
 *
 * Terminals disagree on how a key is sent. Home alone arrives as `CSI H`
 * (xterm, normal cursor mode), `SS3 H` (xterm, application cursor mode),
 * `CSI 1 ~` (VT220 — and what tmux and screen send to the program inside them),
 * `CSI 7 ~` (rxvt). Modifiers ride as a parameter: `CSI 1 ; 5 H` = Ctrl+Home,
 * `CSI 3 ; 2 ~` = Shift+Delete. `decodeKey` maps every form a terminal is likely
 * to send to one `{ key, shift, alt, ctrl }`; `encodeXtermKey` writes it back
 * the way xterm does.
 *
 * The embedded terminal pane needs both directions: it tells its program the
 * terminal is `xterm-256color`, so a key must reach the program in xterm's form
 * — for the cursor mode the program asked for — not in whatever form the host
 * (often tmux) used. nvim 0.12 ignores `CSI 1 ~` / `CSI 4 ~` as Home / End
 * under `TERM=xterm-256color` (measured 2026-11-14).
 *
 * Named keys: up down right left home end insert delete pageup pagedown
 * f1 … f12 backtab. Modifier parameter = 1 + (shift 1 | alt 2 | ctrl 4 |
 * meta 8); a modifier beyond shift/alt/ctrl makes the key undecodable here (the
 * caller passes the bytes through unchanged).
 */
'use strict';

const _CURSOR = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const _SS3_F = { P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };
// `CSI <n> ~` — VT220 editing keys, xterm/VT220 function keys, rxvt Home/End.
const _TILDE = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown',
  7: 'home', 8: 'end',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4',
  15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12',
};
// Linux console F1–F5: `CSI [ A` … `CSI [ E`.
const _CONSOLE_F = { A: 'f1', B: 'f2', C: 'f3', D: 'f4', E: 'f5' };

function _mods(param) {
  if (param === undefined || param === '') return { shift: false, alt: false, ctrl: false };
  const n = parseInt(param, 10) - 1;
  if (!Number.isFinite(n) || n < 0 || n > 7) return null;     // meta/super/…: not ours to name
  return { shift: !!(n & 1), alt: !!(n & 2), ctrl: !!(n & 4) };
}

/** One key token (as tokenizeInput splits input) → `{ key, shift, alt, ctrl }`,
 *  or null when it is not a special key this module names. */
function decodeKey(tok) {
  if (typeof tok !== 'string' || tok.length < 3 || tok.charCodeAt(0) !== 0x1b) return null;
  let m;
  if (tok[1] === 'O' && tok.length === 3) {                     // SS3 X
    const key = _CURSOR[tok[2]] || _SS3_F[tok[2]];
    return key ? { key, shift: false, alt: false, ctrl: false } : null;
  }
  if (tok[1] !== '[') return null;
  if (tok === '\x1b[Z') return { key: 'backtab', shift: false, alt: false, ctrl: false };
  if ((m = /^\x1b\[\[([A-E])$/.exec(tok))) return { key: _CONSOLE_F[m[1]], shift: false, alt: false, ctrl: false };
  if ((m = /^\x1b\[(?:1;(\d+))?([ABCDHFPQRS])$/.exec(tok))) {   // CSI [1;m] X
    const key = _CURSOR[m[2]] || _SS3_F[m[2]];
    const mods = _mods(m[1]);
    return mods ? { key, ...mods } : null;
  }
  if ((m = /^\x1b\[(\d+)(?:;(\d+))?~$/.exec(tok))) {           // CSI n [;m] ~
    const key = _TILDE[m[1]];
    const mods = key && _mods(m[2]);
    return mods ? { key, ...mods } : null;
  }
  return null;
}

const _FINAL = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F',
                 f1: 'P', f2: 'Q', f3: 'R', f4: 'S' };
const _NUM = { insert: 2, delete: 3, pageup: 5, pagedown: 6,
               f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24 };

/** A named key as xterm sends it. `appCursor` = the program set application
 *  cursor keys (DECCKM, `CSI ? 1 h`): unmodified arrows / Home / End use SS3.
 *  F1–F4 are SS3 unmodified in either mode. A modified key always uses the
 *  `CSI 1 ; m X` / `CSI n ; m ~` form. null for a name it doesn't know. */
function encodeXtermKey(ev, { appCursor = false } = {}) {
  if (!ev) return null;
  const m = 1 + (ev.shift ? 1 : 0) + (ev.alt ? 2 : 0) + (ev.ctrl ? 4 : 0);
  if (ev.key === 'backtab') return '\x1b[Z';
  const fin = _FINAL[ev.key];
  if (fin) {
    if (m > 1) return `\x1b[1;${m}${fin}`;
    const ss3 = appCursor || /^f[1-4]$/.test(ev.key);
    return ss3 ? `\x1bO${fin}` : `\x1b[${fin}`;
  }
  const n = _NUM[ev.key];
  if (n) return m > 1 ? `\x1b[${n};${m}~` : `\x1b[${n}~`;
  return null;
}

/** A host key token re-encoded as xterm would send it for the program's cursor
 *  mode, or the token unchanged when it is not a special key. */
function toXtermKey(tok, opts) {
  const enc = encodeXtermKey(decodeKey(tok), opts);
  return enc == null ? tok : enc;
}

module.exports = { decodeKey, encodeXtermKey, toXtermKey };
