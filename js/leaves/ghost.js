/**
 * ghost.js — pure prompt-autosuggest helper (a leaf: no deps, no IO).
 *
 * `ghostSuffix(text, ghost)` returns the tail of `ghost` not yet typed in
 * `text` (the greyed autosuggest remainder), or '' when `ghost` doesn't
 * extend `text`. Used by the prompt reducer arm (`dispatch/update/reducer.js`
 * prompt_key) AND the prompt overlay render (`overlay/prompt.js`) — it lived
 * in `app/runtime.js` (exported as `_ghostSuffix`) until F3 relocated the
 * reducer out of `app/`; a leaf is the right home for a shared pure helper
 * both layers need. See docs/reducer-cleanup-relocation.md.
 */
'use strict';

function ghostSuffix(text, ghost) {
  if (!ghost || !ghost.startsWith(text) || text.length >= ghost.length) return '';
  return ghost.slice(text.length);
}

module.exports = { ghostSuffix };
