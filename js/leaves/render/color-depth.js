/**
 * Color-depth detection + ANSI downgrade — pure leaf (truecolor arc 1b,
 * docs/truecolor.md P3).
 *
 * The render pipeline is CANONICALLY TRUECOLOR: markup hex atoms always
 * compile to 38;2/48;2 (leaves/text/ansi.js), frames and cells are
 * depth-independent, and device capability is adapted HERE, at the write
 * boundary only — `render/paint.js` routes every frame write through
 * `downgradeAnsi`. Truecolor terminals take the identity fast-path and pay
 * nothing; 256/16 terminals get extended colors quantized:
 *   - '256': 38;2;r;g;b → 38;5;n (6×6×6 cube + gray ramp, nearest of the
 *     two candidates); 48/58 likewise; 38;5 passes through.
 *   - '16':  38;2 and 38;5 both land on the nearest of the 16 base colors
 *     (fg → 30-37/90-97, bg → 40-47/100-107); underline color (58) has no
 *     16-color form and is dropped.
 * Malformed 38/48/58 tails are dropped when the pass runs, mirroring the
 * cell-grid H1 fold — re-emitting them inside a rebuilt param list could
 * misparse what follows. (A string whose ONLY extended params are malformed
 * has no well-formed marker, takes the fast-path, and passes through
 * unchanged — same as no downgrade at all.)
 *
 * The RGB tables below are the xterm DEVICE palette — quantization math,
 * not UI color choices; the slot-discipline tripwire allowlists this file
 * alongside themes.js (docs/truecolor.md P2).
 *
 * Pure: string/env in, string out. No I/O, no module state.
 */
'use strict';

// xterm's default 16-color palette (indices 0-15).
const _PALETTE16 = [
  [0x00, 0x00, 0x00], [0xcd, 0x00, 0x00], [0x00, 0xcd, 0x00], [0xcd, 0xcd, 0x00],
  [0x00, 0x00, 0xee], [0xcd, 0x00, 0xcd], [0x00, 0xcd, 0xcd], [0xe5, 0xe5, 0xe5],
  [0x7f, 0x7f, 0x7f], [0xff, 0x00, 0x00], [0x00, 0xff, 0x00], [0xff, 0xff, 0x00],
  [0x5c, 0x5c, 0xff], [0xff, 0x00, 0xff], [0x00, 0xff, 0xff], [0xff, 0xff, 0xff],
];
// The 256-color cube's six component levels.
const _CUBE = [0, 95, 135, 175, 215, 255];

/**
 * Resolve the device's color depth once at startup. LAZYTUI_COLOR wins
 * (explicit override, the LAZYTUI_CELL_DIFF class), then COLORTERM (the
 * truecolor convention), then TERM. Pure function of the passed env.
 * @returns {'truecolor'|'256'|'16'}
 */
function detectColorDepth(env) {
  const o = env.LAZYTUI_COLOR;
  if (o === 'truecolor' || o === '256' || o === '16') return o;
  const ct = env.COLORTERM || '';
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  const term = env.TERM || '';
  if (term.includes('direct') || term.includes('truecolor')) return 'truecolor';
  if (term.includes('256color')) return '256';
  return '16';
}

function _dist2(r, g, b, p) {
  const dr = r - p[0], dg = g - p[1], db = b - p[2];
  return dr * dr + dg * dg + db * db;
}

/** Nearest 256-palette index for an RGB triple (cube vs gray, closer wins). */
function _rgbTo256(r, g, b) {
  const ci = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, ((v - 35) / 40) | 0));
  const qr = ci(r), qg = ci(g), qb = ci(b);
  const cube = [_CUBE[qr], _CUBE[qg], _CUBE[qb]];
  const avg = (r + g + b) / 3;
  const gi = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + 10 * gi;
  return _dist2(r, g, b, cube) <= _dist2(r, g, b, [gv, gv, gv])
    ? 16 + 36 * qr + 6 * qg + qb
    : 232 + gi;
}

/** Nearest base-16 SGR param for an RGB triple. */
function _rgbTo16(r, g, b, isBg) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < 16; i++) {
    const d = _dist2(r, g, b, _PALETTE16[i]);
    if (d < bd) { bd = d; best = i; }
  }
  if (isBg) return best < 8 ? 40 + best : 100 + (best - 8);
  return best < 8 ? 30 + best : 90 + (best - 8);
}

/** RGB of a 256-palette index (for 38;5 → 16 requantization). */
function _c256ToRgb(n) {
  if (n < 16) return _PALETTE16[n];
  if (n < 232) {
    const i = n - 16;
    return [_CUBE[(i / 36) | 0], _CUBE[((i / 6) | 0) % 6], _CUBE[i % 6]];
  }
  const v = 8 + 10 * (n - 232);
  return [v, v, v];
}

const _SGR_RE = /\x1b\[([0-9;]*)m/g;

/**
 * Adapt an outgoing ANSI string to the device depth. Identity at
 * 'truecolor' (and on strings with no extended-color params — the cheap
 * indexOf pre-checks keep the 16/256 common case allocation-free).
 */
function downgradeAnsi(ansi, depth) {
  if (depth === 'truecolor') return ansi;
  if (ansi.indexOf('8;2;') < 0 && (depth !== '16' || ansi.indexOf('8;5;') < 0)) return ansi;
  return ansi.replace(_SGR_RE, (full, body) => {
    if (body.indexOf('8;') < 0) return full;
    const t = body.split(';');
    const out = [];
    for (let i = 0; i < t.length; i++) {
      const n = t[i] === '' ? 0 : parseInt(t[i], 10);
      if (n !== 38 && n !== 48 && n !== 58) { out.push(t[i]); continue; }
      const kind = t[i + 1] === undefined || t[i + 1] === '' ? 0 : parseInt(t[i + 1], 10);
      let r, g, b;
      if (kind === 2 && i + 4 < t.length) {
        r = +t[i + 2]; g = +t[i + 3]; b = +t[i + 4]; i += 4;
      } else if (kind === 5 && i + 2 < t.length) {
        if (depth === '256') { out.push(`${n};5;${+t[i + 2]}`); i += 2; continue; }
        [r, g, b] = _c256ToRgb(+t[i + 2]); i += 2;
      } else break;                              // malformed tail — drop
      if (n === 58) {                            // underline color
        if (depth === '256') out.push(`58;5;${_rgbTo256(r, g, b)}`);
        continue;                                // no 16-color form — drop
      }
      if (depth === '256') out.push(`${n};5;${_rgbTo256(r, g, b)}`);
      else out.push(String(_rgbTo16(r, g, b, n === 48)));
    }
    return out.length ? `\x1b[${out.join(';')}m` : '';
  });
}

module.exports = { detectColorDepth, downgradeAnsi };
