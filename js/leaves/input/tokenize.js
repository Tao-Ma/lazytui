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
 *         intermediates 0x20–0x2F; final 0x40–0x7E)
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
    if (m) return { tok: m[0], len: m[0].length };
    _CSI_PARTIAL.lastIndex = i;
    const p = _CSI_PARTIAL.exec(input);
    // Partial only carries under the cap; an overlong param run is emitted
    // whole for the unknown-escape drop path (it can never complete into
    // anything we would dispatch differently).
    if (p && p[0].length <= _CARRY_CAP) return { carry: p[0] };
    const rest = input.slice(i);
    return { tok: rest, len: rest.length };
  }

  if (next === 'O') {
    if (i + 2 < input.length) {
      return { tok: input.slice(i, i + 3), len: 3 };   // \x1bO + one byte
    }
    return { carry: input.slice(i) };                  // `\x1bO` at end
  }

  if (next === ESC) {
    // `\x1b\x1b` exactly at end-of-input = the historical double-Esc form
    // (one Esc keypress). Otherwise the second ESC starts a sequence and
    // the first is an Alt/meta prefix on it — keep them as ONE token so
    // the whole chord drops together (never Esc + stray chars).
    if (i + 2 === input.length) return { tok: ESC + ESC, len: 2 };
    const inner = _escEvent(input, i + 1);
    if (inner.carry !== undefined) return { carry: ESC + inner.carry };
    return { tok: ESC + inner.tok, len: 1 + inner.len };
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
