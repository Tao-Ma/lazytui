/**
 * Overlay mouse policy (docs/mouse-hit-map.md §Backdrop) — hit-map R1 rule:
 * an overlay publishes an outside-click backdrop IFF its mode blocks chrome
 * clicks (modes.js `suppressChrome: true`). The three settings that say "this
 * popup owns the screen" (descriptor `modal`, modes.js `modal`, modes.js
 * `suppressChrome`) and `mouse.outside` are independent facts; nothing but this
 * test keeps the R1 pairing — a new overlay that blocks chrome without a
 * backdrop would be mouse-dead outside its box, and one with a backdrop over a
 * chrome-live mode would newly block chrome clicks. (Release 2 moves the
 * chrome-live modes' backdrops BELOW the chrome band and updates this rule.)
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

describe('[policy] backdrop iff suppressChrome', () => {
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
      eq(hasBackdrop, !!m.suppressChrome, 'backdrop ⇔ suppressChrome');
      assert(d.isActive({ modes: {} }) === false, 'inactive with no modes');
    });
  }
});

report();
