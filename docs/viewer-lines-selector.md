# viewer-lines selector — retire `slice.lines` via derived selectors

> Status: **IN PROGRESS** (v0.6.4, pre-tag). Spec written 2026-06-12.
> Supersedes the B1 "defer" verdict (docs/v0.6.3.md Track B) — see the
> analysis trail in auto-memory `viewer-lines-selector`.

## Why

`slice.lines` is denormalized derived state stored in the model. TEA's
purity rule it satisfies (single writer — the finalizer); the
normalization ideal ("store only what you can't compute") it violates,
which is why every audit since v0.6.2 re-flags it. The recurring flag is
correct: a normalized design exists, reuses only established mechanisms
(dispatch-side fact threading, post-dispatch finalizer clamp,
parametrized leaves, ref-keyed memos), and deletes more code than it
adds.

### Ground truth (recon 2026-06-12)

1. **No reducer arm writes `slice.lines` anymore.** Unrouted streams go
   to the Transcript buffer (`viewerStreamBuffer`) since v0.6.2; routed
   output to `actionTabBuffers`/`contentTabs`; discrete docs to
   `viewerOverride`. The stream.js/state.js "legacy slice.lines write"
   comments are STALE (pre-Transcript).
2. **The field's only canonical role is sticky last-Info-content** —
   `viewerLines()` tab-0 falls back to `slice.lines` when the focused
   pane has no `getInfo` (so Info doesn't blank when the viewer itself
   is focused).
3. **Info freshness is already eventful.** `redraw()` (paint.js)
   dispatches `viewer_show_info` before every paint; focus/nav/filter
   changes emit `show_selected_info` Cmds (layout.js ×8, groups.js,
   runtime nav_select). The finalizer's live `_infoFromFocus()` call —
   plugin `getItems`+`getInfo` on EVERY viewer Msg — is redundant for
   freshness and is the expensive part of the measured ~93μs/Msg
   finalizer cost. viewer.js:246 already names the fix ("v0.7
   candidate: thread the resolved lines through msg.lines").
4. Render does NOT read `slice.lines` — it calls `viewerLines()` fresh
   per frame. Consumers of the stored field are: reducer arms (scroll/
   cursor/select bounds), `leaves/search.js` (computeMatches +
   maxScroll), the finalizer's transition-detect, and the tab-0 sticky
   fallback.

## Target architecture

- **Canonical per-tab homes, no exceptions.** New `slice.infoLines` =
  Info-tab content, written by the `viewer_show_info` arm from
  `msg.lines` (computed dispatcher-side at the two existing
  chokepoints: `dispatch.showSelectedInfo()` and `paint.redraw()`).
  Sticky by construction. Every other tab already has a home.
- **Lines are a selector, not a field.** `tabs.js` facade:
  `linesFor(slice, model)` → `pt.viewerLines(slice, model,
  model.currentGroup)` — the `lookups` bag dies with the finalizer's
  plugin call. `viewerLines` mostly returns source-array refs, so it's
  near-free; memoize `flatTabInfo` if the bench asks.
- **Search matches are a chained selector.** `matchesFor(lines, term)`
  module-level ref-keyed memo; `slice.search` keeps `{active, term,
  idx, typing}` canonical, drops `matches`. The finalizer's
  transition-detect (`originalSlice.lines !== lines` →
  `ms.recomputeFor`) is DELETED — the memo recomputes exactly when the
  lines ref changes. `ms.*` parametrized with lines.
- **Bounds via threading + finalizer safety-net.** Arms that need
  lengths DURING reduction (`viewer_scroll` bottom, cursor/select
  bounds, search nav) get `lines`/`linesLen` threaded in the Msg
  payload (modelBundle pattern, computed via the selector at the
  dispatch chokepoints). The post-dispatch finalizer in `panel/api.js`
  (resize-as-Msg home) additionally clamps viewer scroll via the
  selector — same safety-net navigators already have.

## Phases (each suite+smoke green; strict no-op unless stated)

- **P0 — Info canonical.** `viewer_show_info` threads `msg.lines`; arm
  writes `slice.infoLines`; `viewerLines` tab-0 reads
  `infoLines ?? slice.lines` (tolerant during transition); finalizer
  derivation drops the `lookups`/plugin call; render drops it too.
  Behavior no-op (freshness paths audited in §Ground-truth 3).
- **P1 — matches selector.** Chained memo; delete transition-detect;
  `ms.*` take lines; search arms/key-bundle thread lines.
- **P2 — bounds.** Thread `linesLen` at scroll/cursor/select dispatch
  sites; add viewer clamp to the api.js finalizer.
- **P3 — delete the field.** Finalizer lines-derivation + init +
  remaining fallbacks go; test fixtures flip (`lines:` →
  `infoLines:`/buffers); tolerant fallback removed.
- **P4 — verify + docs.** Bench gate (must be ≥ finalizer baseline;
  expect a win — the per-Msg plugin call is gone), DATAFLOW/PRINCIPLES
  notes, CHANGELOG, adversarial review pass.

## Risks

- Fixture churn (tests construct slices with `lines:`) — absorbed by
  the P0-P2 tolerant fallback, flipped in one pass at P3 (the `boundsOf`
  precedent).
- Info-freshness regressions on item-change paths not covered by
  `show_selected_info`/`redraw` — P0 keeps render-time freshness until
  P3? NO — P0 moves Info display to stored `infoLines`; the audit says
  coverage is complete (redraw fires before every paint). Any gap found
  = add the missing Cmd, not revert.
- Hot path — bench before/after at each phase that touches
  viewer_append.
