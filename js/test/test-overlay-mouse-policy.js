/**
 * Overlay mouse policy (docs/mouse-hit-map.md §Backdrop). An overlay whose mode
 * blocks chrome clicks (modes.js `suppressChrome: true`) publishes an outside-
 * click backdrop in its own band (above all pane chrome); one whose mode leaves
 * chrome live publishes either none or a `backdrop: 'below-chrome'` one (z 35,
 * under the chrome band — Release 2: jobs, pane-menu, which-key). The three settings that say "this
 * popup owns the screen" (descriptor `modal`, modes.js `modal`, modes.js
 * `suppressChrome`) and `mouse.outside` are independent facts; nothing but this
 * test keeps the R1 pairing — a new overlay that blocks chrome without a
 * backdrop would be mouse-dead outside its box, and one with a backdrop over a
 * chrome-live mode would newly block chrome clicks.
 *
 * Each descriptor's mode flag is found by PROBING its isActive against the
 * modes table, so descriptors carry no duplicated `flag` field.
 *
 * Run: node js/test/test-overlay-mouse-policy.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
require('../render/overlay-compositor-boot');
const compositor = require('../render/overlay-compositor');
const { MODES } = require('../leaves/input/modes');

function flagOf(d) {
  const hits = MODES.filter(m => {
    try { return d.isActive({ modes: { [m.flag]: true }, modal: {}, prefixSeq: [] }) === true; } catch (_) { return false; }
  });
  return hits.length === 1 ? hits[0] : null;
}

const BELOW_CHROME = ['jobs', 'pane-menu', 'which-key'];

describe('[policy] backdrop placement follows suppressChrome', () => {
  const ds = compositor._all();
  it('every mode-flag overlay is found by probing', () => {
    const flagged = ds.filter(d => flagOf(d)).map(d => d.id).sort();
    eq(flagged, ['action-palette', 'cmdline', 'confirm', 'copy', 'diag-log', 'fabric-field', 'fabric-form',
                 'jobs', 'menu', 'pane-menu', 'panel-list', 'register-popup', 'which-key'].sort());
  });
  for (const d of ds) {
    const m = flagOf(d);
    if (!m) continue;
    it(`${d.id} (${m.flag}, suppressChrome=${m.suppressChrome})`, () => {
      const hasBackdrop = !!(d.mouse && d.mouse.outside != null);
      const below = hasBackdrop && d.mouse.backdrop === 'below-chrome';
      if (m.suppressChrome) {
        assert(hasBackdrop && !below, 'chrome blocked → a backdrop in the overlay band');
      } else {
        assert(!hasBackdrop || below, 'chrome live → no backdrop, or one below the chrome band');
        eq(below, BELOW_CHROME.includes(d.id), 'the R2 below-chrome set');
      }
      assert(d.isActive({ modes: {} }) === false, 'inactive with no modes');
    });
  }
});

describe('[owner] namespace', () => {
  it('no descriptor id can collide with a pane owner', () => {
    // Pane regions are owned by `pane:<paneId>` (hit-map §Owner namespace);
    // an overlay owner is its descriptor id.
    const hm = require('../panel/hit-map');
    for (const d of compositor._all()) {
      assert(!String(d.id).startsWith(hm.PANE_OWNER_PREFIX), `${d.id} is not in the pane namespace`);
    }
  });
});

report();
