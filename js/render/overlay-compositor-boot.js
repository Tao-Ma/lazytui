/**
 * Overlay-compositor boot — the one place that imports each migrated
 * overlay module and calls its `registerSelf(compositor)`. Imported
 * for side effect from `paint.js`'s module load, so every path that
 * ends up requiring paint.js (app/tui.js production boot, the smoke
 * harness, headless unit tests, replay fold) gets the same registry.
 *
 * Keeping the loop here (not inline in tui.js) means the test harness
 * doesn't duplicate the list. Each new migration adds exactly one
 * line to `registerAll()`.
 *
 * Idempotent: compositor.register uses an id-keyed replace, so
 * re-running `registerAll` (e.g. test harness that re-boots paint.js)
 * is safe. See `js/test/test-overlay-compositor.js`'s "register with
 * existing id REPLACES" pin for the shape.
 *
 * Overlay-compositor-migration Release 3 (docs/overlay-compositor-
 * migration.md §Release 3).
 */
'use strict';

const compositor = require('./overlay-compositor');

/**
 * Register every migrated overlay descriptor. Called at paint.js
 * module load; also safe to call again from app boot or a test
 * harness setup fn.
 */
function registerAll() {
  // zIndex bands:
  //    10-140: mode-flag-driven overlays, zIndex-ascending matches the
  //            retired paint.js if-chain's historical paint order (the
  //            compositor paints low→high so a user sees the same stack).
  //    141-998: reserved for future tiered overlays (toasts, banners).
  //    999+:   "always on top" tier — currently just hover-tooltip.
  //
  // Mode-flag overlays — descriptor's render fn thunks the overlay's
  // existing render fn; isActive reads a single `model.modes.*` flag.
  require('../overlay/confirm').registerSelf(compositor);          //  10
  require('../overlay/copy').registerSelf(compositor);             //  20
  require('../overlay/diag-log').registerSelf(compositor);         //  30
  require('../overlay/jobs').registerSelf(compositor);             //  40
  require('../overlay/pane-menu').registerSelf(compositor);        //  50
  require('../overlay/panel-list').registerSelf(compositor);       //  60
  require('../overlay/register-popup').registerSelf(compositor);   //  70
  require('../overlay/which-key').registerSelf(compositor);        //  80
  require('../overlay/action-palette').registerSelf(compositor);   //  90
  require('../overlay/menu').registerSelf(compositor);             // 100
  require('../overlay/cmdline').registerSelf(compositor);          // 110
  require('../overlay/fabric-form').registerSelf(compositor);      // 120
  require('../overlay/fabric-field').registerSelf(compositor);     // 130
  // State-driven overlays — isActive reads injected or singleton state
  // instead of a model.modes flag. Each wire-up lives next to the
  // descriptor registration site that depends on it.
  require('../overlay/replay-scrubber').registerSelf(compositor);  // 140 — isActive gates on injected replay data (setDataSource at tui.js boot)
  require('../overlay/hover-tooltip').registerSelf(compositor);    // 999 — isActive gates on hoverRegion.get() + modal-suppression
}

module.exports = { registerAll };

// Side effect at module load: the common path (paint.js requires us,
// we register everything). A caller that wants to _reset() + rebuild
// in a test can do so and then call registerAll() again.
registerAll();
