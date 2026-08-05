/**
 * Stdin chunk tokenizer — split a raw input chunk into complete input
 * events (pure leaf).
 *
 * Locally, raw mode fires one stdin 'data' event per keystroke, so the
 * input layer's whole-chunk exact matches (`data === '\x1b[B'`) work. Over
 * a network they break: SSH delivers autorepeat batched — one chunk can
 * carry `'jjjjj'`, `'\x1b[B\x1b[B\x1b[B'`, or keys interleaved with mouse
 * events — and TCP can split one escape sequence ACROSS chunks. Pre-fix,
 * a batched arrow chunk matched nothing exact and was dropped whole
 * (unknown-escape path), and a split `\x1b[` + `B` misparsed as
 * drop + plain 'B' (network-lag investigation, 2026-08-05).
 *
 * `tokenizeInput(input)` → `{ tokens, carry }`:
 *   - `tokens` — complete events, each an exact contiguous slice of the
 *     input (tokens.join('') + carry === input), in order:
 *       · CSI sequence  `\x1b[ params intermediates final`
 *         (params 0x30–0x3F — covers digits, `;`, and the SGR-mouse `<`;
 *         intermediates 0x20–0x2F; final 0x40–0x7E). Two legacy forms
 *         extend past their final byte so their payload can't dispatch
 *         as typed keys: X10 mouse `\x1b[M` takes 3 coordinate bytes,
 *         Linux-console F1–F5 `\x1b[[` takes its letter.
 *       · SS3 sequence  `\x1bO` + one byte (F1–F4 / keypad on some terms)
 *       · Alt chord     `\x1b` + one code point, or `\x1b` + a full
 *         CSI/SS3 sequence (`\x1b\x1b[A` alt-arrow form) — ONE token, so
 *         the dispatcher can drop it whole exactly as the pre-tokenizer
 *         code dropped the whole chunk (B14: never fire Esc for these)
 *       · Bare escape   `\x1b` at end-of-input, and the exact pair
 *         `\x1b\x1b` at end-of-input (the historical double-Esc form —
 *         one token, one Esc keypress)
 *       · Plain char    one code point (surrogate pairs stay together)
 *   - `carry` — an INCOMPLETE trailing CSI/SS3 (`\x1b[`, `\x1b[1;3`,
 *     `\x1bO`): the caller prepends it to the next chunk (and flushes it
 *     after a short timeout so a deliberate Esc-then-`[` doesn't wedge).
 *     A bare trailing `\x1b` is NEVER carried — it tokenizes as Esc
 *     immediately, keeping modal-close latency at zero.
 *
 * A pathological unterminated CSI (params past _CARRY_CAP bytes) is
 * emitted as-is instead of carried — the dispatcher's unknown-escape
 * path logs + drops it, same as the pre-tokenizer behavior.
 *
 * ESC and C0 controls TERMINATE a pending CSI/SS3 (the VT cancel rule):
 * the malformed head is emitted for the drop path and tokenizing resumes
 * at the terminator, so `\x1bO` + arrow can't eat the arrow's introducer
 * and `\x1b[1\x03` can't swallow a Ctrl-C.
 *
 * Pure: string in, {tokens, carry} out. No I/O, no module state.
 */
'use strict';

const ESC = '\x1b';
const _CARRY_CAP = 64;

// One complete CSI: `\x1b[` + params (0x30–0x3F) + intermediates
// (0x20–0x2F) + final (0x40–0x7E). Sticky — matched in place at `i`.
const _CSI_FULL = /\x1b\[[0-?]*[ -/]*[@-~]/y;
// An incomplete CSI that reaches end-of-input (carry candidate).
const _CSI_PARTIAL = /\x1b\[[0-?]*[ -/]*$/y;

/**
 * Consume ONE escape-initiated event at `input[i]` (input[i] === ESC).
 * Returns `{ tok, len }` for a complete event, `{ carry }` when the
 * tail is an incomplete CSI/SS3 at end-of-input.
 */
function _escEvent(input, i) {
  const next = input[i + 1];

  if (next === '[') {
    _CSI_FULL.lastIndex = i;
    const m = _CSI_FULL.exec(input);
    if (m) {
      // X10 mouse fallback: a terminal honoring DECSET 1000/1002 but not
      // SGR-1006 reports clicks as `\x1b[M` + 3 raw coordinate bytes
      // (btn+32, col+32, row+32). The grammar alone sees a complete
      // param-less CSI with final `M` and the coordinates would dispatch
      // as typed keys — a click at column 81 sends `q`. Take the
      // coordinates into the token so the whole report drops inert
      // (coords ≥ 96 arrive utf8-mangled, so parsing them is hopeless —
      // and SGR is the mode lazytui actually drives).
      if (m[0] === '\x1b[M') {
        // Real coordinates are ≥ 0x20 by encoding (value + 32) — an
        // ESC/C0 in their place is a terminator, not a coordinate, and
        // must never be absorbed.
        let end = i + 3;
        while (end < i + 6 && end < input.length && input[end] >= ' ') end++;
        if (end < i + 6 && end === input.length) return { carry: input.slice(i) };
        return { tok: input.slice(i, end), len: end - i };
      }
      // Linux-console (TERM=linux) F1–F5 arrive as `\x1b[[A`..`\x1b[[E`;
      // `[` is a valid final byte, so the grammar alone would drop
      // `\x1b[[` and TYPE the letter. Take it into the token instead
      // (any code point except an ESC/C0 terminator).
      if (m[0] === '\x1b[[') {
        if (i + 3 === input.length) return { carry: input.slice(i) };
        if (input[i + 3] < ' ') return { tok: m[0], len: 3 };
        const fch = String.fromCodePoint(input.codePointAt(i + 3));
        return { tok: input.slice(i, i + 3) + fch, len: 3 + fch.length };
      }
      return { tok: m[0], len: m[0].length };
    }
    _CSI_PARTIAL.lastIndex = i;
    const p = _CSI_PARTIAL.exec(input);
    // Partial only carries under the cap; an overlong param run is emitted
    // whole for the unknown-escape drop path (it can never complete into
    // anything we would dispatch differently).
    if (p && p[0].length <= _CARRY_CAP) return { carry: p[0] };
    // No final byte and no clean partial: a byte outside the CSI grammar
    // interrupted the sequence. ESC or a C0 control TERMINATES the pending
    // sequence (the VT cancel rule) — emit the malformed head for the drop
    // path and resume at the terminator, so `\x1b[` + a batched arrow
    // rejoins as ONE dropped head + a working arrow, and `\x1b[1\x03`
    // can't swallow a Ctrl-C. Anything else (an overlong param run, a
    // stray printable after intermediates) still drops to end-of-chunk.
    let stop = i + 2;
    while (stop < input.length && input[stop] >= ' ') stop++;
    const rest = input.slice(i, stop);
    return { tok: rest, len: rest.length };
  }

  if (next === 'O') {
    const third = input[i + 2];
    if (third === undefined) return { carry: input.slice(i) };  // `\x1bO` at end
    // ESC or a C0 control can't be an SS3 payload — it terminates the
    // sequence. Emit the orphan `\x1bO` for the drop path and resume at
    // the terminator, so `\x1bO` + arrow doesn't eat the arrow's
    // introducer and type its body as stray keys.
    if (third < ' ') return { tok: input.slice(i, i + 2), len: 2 };
    return { tok: input.slice(i, i + 3), len: 3 };              // \x1bO + one byte
  }

  if (next === ESC) {
    // A run of consecutive ESCs is an Alt/meta prefix stack on whatever
    // the LAST one introduces — kept as ONE token so the whole chord
    // drops together (never Esc + stray chars). `\x1b\x1b` exactly at
    // end-of-input = the historical double-Esc form (one Esc keypress);
    // longer runs at end drop whole. Walked ITERATIVELY — a recursive
    // walk overflowed the call stack on a pathological ESC flood and
    // killed the app via uncaughtException (review 2026-08-05).
    let j = i;
    while (input[j] === ESC) j++;
    if (j === input.length) return { tok: input.slice(i), len: j - i };
    const prefix = input.slice(i, j - 1);
    const base = _escEvent(input, j - 1);   // last ESC + its sequence; never recurses again
    if (base.carry !== undefined) {
      const c = prefix + base.carry;
      // The cap applies to the WHOLE carry — an ESC-flood prefix must not
      // ride into the next chunk; emit it for the drop path instead.
      if (c.length > _CARRY_CAP) return { tok: c, len: c.length };
      return { carry: c };
    }
    return { tok: prefix + base.tok, len: prefix.length + base.len };
  }

  if (next === undefined) return { tok: ESC, len: 1 };  // bare Esc — never carried

  // Alt chord: ESC + one plain code point.
  const cp = input.codePointAt(i + 1);
  const ch = String.fromCodePoint(cp);
  return { tok: ESC + ch, len: 1 + ch.length };
}

function tokenizeInput(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === ESC) {
      const ev = _escEvent(input, i);
      if (ev.carry !== undefined) return { tokens, carry: ev.carry };
      tokens.push(ev.tok);
      i += ev.len;
      continue;
    }
    const cp = input.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    tokens.push(ch);
    i += ch.length;
  }
  return { tokens, carry: '' };
}

module.exports = { tokenizeInput };
