/**
 * Paint ↔ hit-test agreement for clickable border chrome.
 *
 * The class of bug this guards: paint (leaves/render/draw.js) and a hit-test
 * compute the same interactive element's screen column INDEPENDENTLY, and drift.
 * The `[≡]` pane-menu trigger shipped exactly this — its hit-zone was pinned to a
 * fixed column while draw.js paints the glyph at a hotkey-dependent one, so on a
 * hotkey-less pane the clickable zone sat 3 cells right of the visible glyph.
 *
 * This test doesn't re-derive geometry (that's what drifted). It RENDERS the real
 * host-monitor demo — which has BOTH hotkeyed panes (columns 1/3) and hotkey-less
 * ones (the middle column) — scans the painted frame for each pane's `[≡]` glyph,
 * and asserts `hitTestTrigger` fires exactly under the painted glyph and nowhere
 * else on that row. Any future divergence (paint moves the glyph, or a hit-test
 * bakes a new assumption) fails here regardless of how the offset is computed.
 *
 * SCOPE: covers the POSITION axis on panes wide enough that `[≡]` IS painted (the
 * demo columns are 30/44/flex). It does NOT cover the PRESENCE axis — a very
 * narrow pane where renderPanel drops all chrome yet the width-proxy hit-test
 * still reports a hit (see the KNOWN GAP note in pane-menu.hitTestTrigger); that
 * needs the paint to publish its drawn chrome regions — its own arc.
 *
 * Run: node js/test/test-chrome-hittest-agreement.js
 */
'use strict';

const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const api = require('./smoke/_helpers/smoke').api;
const route = require('./smoke/_helpers/smoke').route;
const sm = require('./smoke/_helpers/smoke');
const paint = require('../render/paint');
const paneMenu = require('../overlay/pane-menu');
const { visibleBoundsFor } = require('../leaves/wm/geometry');

for (const p of ['navigator/actions', 'navigator/groups', 'monitor/stats', 'monitor/table', 'monitor/gauge']) {
  const c = require('../panel/' + p);
  if (!api.getComponent(c.name)) { try { api.registerComponent(c); } catch (_) { /* order-guarded */ } }
}

const { parse } = require('../parser/index');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');

const cfg = parse(path.join(__dirname, '..', '..', 'demo', 'host-monitor', 'tui.yml'));
getModel().config = cfg;
getModel().projectDir = cfg.project_dir;
require('../dispatch/runtime/host-wiring').wirePanelHost();
require('../panel/nav-state').setNavDispatch(require('../dispatch/runtime/effects').effectHost());
initState();
sm.resize(120, 40);
// One sample per topic so every pane paints its border (a "no data yet" pane
// still paints its chrome, but seed anyway to mirror a live screen).
getModel().metrics = {
  'host.proc': { schema: cfg.metrics['host.proc'].schema, series: { 100: [{ cpu: 5, mem: 1, comm: 'x', command: 'x', state: 'S', threads: 1, rss: 0, ppid: 1, user: 'r' }] } },
  'host.net': { schema: cfg.metrics['host.net'].schema, series: { eth0: [{ rx: 1, tx: 1 }] } },
  'host.disk': { schema: cfg.metrics['host.disk'].schema, series: { '/': [{ pct: 1, used: 1, size: 1 }] } },
  'host.diskio': { schema: cfg.metrics['host.diskio'].schema, series: { vda: [{ read: 1, write: 1 }] } },
};

// Decode the painted frame into screen rows (paint uses cursor moves, not '\n').
function paintedRows() {
  let raw = '';
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { raw += s; return true; };
  paint.forceFullRepaint();
  sm.render();
  process.stdout.write = orig;
  const rows = {}; let cy = 1, cx = 1, i = 0;
  while (i < raw.length) {
    if (raw[i] === '\x1b') {
      const m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(raw.slice(i));
      if (m) { const p = m[1].split(';').map(Number); if (m[2] === 'H') { cy = p[0] || 1; cx = p[1] || 1; } i += m[0].length; continue; }
      i++; continue;
    }
    if (raw[i] === '\n') { cy++; cx = 1; i++; continue; }
    rows[cy] = rows[cy] || []; rows[cy][cx] = raw[i]; cx++; i++;
  }
  return rows;   // 1-based [cy][cx] → char
}

describe('[chrome agreement] the painted [≡] glyph is exactly what hitTestTrigger fires on', () => {
  const rows = paintedRows();
  const layout = api.getInstanceSlice('layout');
  const panes = [];
  for (const col of (layout.arrange.columns || [])) for (const pn of (col.panels || [])) if (pn.paneId) panes.push(pn);

  // The middle column is hotkey-less (the regression scenario); prove the fixture
  // actually contains both regimes so this test can't silently degrade.
  const withHk = panes.filter(pn => pn.hotkey);
  const noHk = panes.filter(pn => !pn.hotkey);
  it('the demo exercises BOTH hotkeyed and hotkey-less panes', () => {
    assert(withHk.length >= 1, `expected hotkeyed panes, got ${withHk.length}`);
    assert(noHk.length >= 1, `expected hotkey-less panes, got ${noHk.length}`);
  });

  for (const pn of panes) {
    if (!paneMenu.triggerVisible(pn.paneId)) continue;
    it(`${pn.paneId} (hotkey=${JSON.stringify(pn.hotkey || '')}): click lands on the painted [≡]`, () => {
      const b = visibleBoundsFor(layout, pn.paneId, route.resolveViewerPaneId());
      const line = rows[b.y + 1] || [];   // 1-based row for screen y=b.y
      // Find the painted `≡` on this pane's top border.
      let eqX = -1;
      for (let x = b.x + 1; x <= b.x + b.w; x++) { if (line[x] === '≡') { eqX = x - 1; break; } }   // 0-based screen x
      assert(eqX >= 0, 'the [≡] glyph is painted on this pane');
      // hitTestTrigger uses the same 0-based screen-x space as bounds. The glyph
      // is `[≡]`, so `[` is at eqX-1 and the 3-cell zone is [eqX-1 .. eqX+1].
      eq(paneMenu.hitTestTrigger(eqX, b.y), pn.paneId, 'clicking the ≡ opens THIS pane');
      eq(paneMenu.hitTestTrigger(eqX - 1, b.y), pn.paneId, 'clicking the [ opens it');
      eq(paneMenu.hitTestTrigger(eqX + 1, b.y), pn.paneId, 'clicking the ] opens it');
      // Just outside the painted glyph must NOT fire (no phantom zone — the bug).
      eq(paneMenu.hitTestTrigger(eqX + 2, b.y), null, 'one cell right of ] is dead');
      eq(paneMenu.hitTestTrigger(eqX - 2, b.y), null, 'one cell left of [ is dead');
    });
  }
});

report();
