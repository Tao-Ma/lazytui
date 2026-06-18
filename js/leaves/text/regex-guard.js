/**
 * Defensive RegExp constructor — rejects patterns that are likely to
 * trigger catastrophic backtracking. Node has no native regex timeout,
 * so an unrestrained `new RegExp(userInput).test(longString)` can freeze
 * the event loop indefinitely (e.g. `(a+)+x` against a non-matching long
 * input). This guard is used in the `/`-filter (files panel) and the
 * `/`-search (detail panel) — both compile user-typed buffers.
 *
 * Strategy:
 *   1. Length cap. Filter/search patterns are interactive — there's no
 *      legitimate reason to type a >200-char regex. Bounding length
 *      bounds the worst-case product (pattern × input).
 *   2. Nested-quantifier heuristic. Catches the classic shapes:
 *        (a+)+   (.*)+   (.+)*   (\d+)+
 *      i.e. a parenthesised body that ends in `*`/`+` and is followed
 *      by `*`/`+`/`?`. Doesn't catch every adversarial pattern
 *      (e.g. `((a+))+` with intermediate parens) — but those are far
 *      less likely from a human typing in the filter buffer; the
 *      length cap is the failsafe.
 *   3. The usual try/catch around `new RegExp` — invalid syntax during
 *      mid-typing yields null, callers fall back to "show everything"
 *      (a friendlier UX than blinking-to-empty on every keystroke).
 *
 * Returns a RegExp on success or `null` on any rejection. Callers MUST
 * handle null explicitly (don't blindly invoke `.test` on the result).
 */
'use strict';

const MAX_PATTERN_LEN = 200;

// Two complementary heuristics for catastrophic-backtrack patterns.
//
// NESTED_QUANT (pre-T21) catches the no-intermediate-parens shape:
//   (a+)+   (.*)+   (.+)*   (\d+)+
// Inner unbounded quantifier (`*`/`+`) followed by closing `)` and an
// outer quantifier (`*`/`+`/`?`).
//
// NESTED_QUANT_OUTER (T21) catches the WITH-intermediate-parens shape
// that the round-5 audit bypassed:
//   ((a+))+   ((.*))+$
// Any pattern where a quantifier-followed-by-close-paren sits BEFORE
// an outer close-paren that's followed by a quantifier. Verified: pre-
// T21 the pattern `((a+))+$` passed the guard and froze Node for 83.5
// seconds matching against 31 `a` characters + a non-matching tail.
// This is a user-triggerable DoS: paste into the `/`-filter on a
// populated list, the input thread freezes for a minute+.
const NESTED_QUANT = /\([^()]*[*+][^()]*\)[*+?]/;
const NESTED_QUANT_OUTER = /[*+]\)[^)]*\)[*+?]/;

function safeRegex(pattern, flags) {
  if (typeof pattern !== 'string') return null;
  if (pattern.length === 0) return null;
  if (pattern.length > MAX_PATTERN_LEN) return null;
  if (NESTED_QUANT.test(pattern)) return null;
  if (NESTED_QUANT_OUTER.test(pattern)) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

module.exports = { safeRegex, MAX_PATTERN_LEN,
  _NESTED_QUANT: NESTED_QUANT, _NESTED_QUANT_OUTER: NESTED_QUANT_OUTER };
