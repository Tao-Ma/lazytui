/**
 * Navigation history — pure jumplist ring math for `model.nav` (v0.6.7 Phase 3).
 *
 * Browser back/forward = vim jumplist: a LIST of visited locations + a CURSOR.
 * Back = cursor--, forward = cursor++; a new push after a back TRUNCATES the
 * forward branch (you can't redo into a branch you've diverged from). The ring
 * is capped (oldest evicted).
 *
 * Zero-dep leaf so the root reducer arms (nav_record / nav_back / nav_forward /
 * nav_prune in dispatch/update/reducer.js) delegate the index/array math here
 * and it stays testable in isolation (test-nav-history.js). A "location" is an
 * opaque, plain-JSON tagged record built by the impure `nav_capture` effect
 * (group + focused pane + tab/sel by STABLE identity); this leaf only does
 * array math + a structural dedupe compare — it never inspects a record's shape.
 */
'use strict';

// The initial / empty ring. store.js seeds model.nav with this shape.
const EMPTY = { history: [], cursor: -1, cap: 100 };

// Structural equality over the small plain-JSON location records (no Sets, no
// functions — guaranteed by the capture effect + the no-closure modal contract).
// Records are built field-for-field in a stable order, so JSON.stringify is a
// sound canonical form for the consecutive-dedupe check.
function sameLoc(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Push a location. Three jumplist rules, in order:
//   1. dedupe — a consecutive duplicate of the current entry is a no-op
//      (returns the SAME nav ref so the reducer can identity-preserve);
//   2. truncate — if we are back in history (cursor < end), drop the forward
//      branch before appending;
//   3. cap — evict from the front past `cap`, leaving the cursor on the newest.
function push(nav, loc) {
  const cap = nav.cap || EMPTY.cap;
  if (nav.cursor >= 0 && sameLoc(nav.history[nav.cursor], loc)) return nav;
  let history = nav.history.slice(0, nav.cursor + 1);
  history.push(loc);
  if (history.length > cap) history = history.slice(history.length - cap);
  return { ...nav, history, cursor: history.length - 1 };
}

// Step the cursor by `dir` (-1 back / +1 forward). Returns { nav, loc } with the
// destination location to restore, or null when there is nothing that way.
function step(nav, dir) {
  const target = nav.cursor + dir;
  if (target < 0 || target >= nav.history.length) return null;
  return { nav: { ...nav, cursor: target }, loc: nav.history[target] };
}

// Remove the entry at `index` (a stale "404" record whose group/pane vanished).
// Shift the cursor down if it sat after the removed slot; clamp into range.
function prune(nav, index) {
  if (index < 0 || index >= nav.history.length) return nav;
  const history = nav.history.slice(0, index).concat(nav.history.slice(index + 1));
  let cursor = nav.cursor > index ? nav.cursor - 1 : nav.cursor;
  if (cursor >= history.length) cursor = history.length - 1;
  return { ...nav, history, cursor };
}

module.exports = { EMPTY, sameLoc, push, step, prune };
