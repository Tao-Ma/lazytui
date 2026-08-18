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
 * SCOPE: covers BOTH axes.
 *   - POSITION — on panes wide enough that `[≡]` IS painted (demo cols 30/44/flex),
 *     the click lands exactly on the painted glyph and nowhere else on the row.
 *   - PRESENCE — squeezing the terminal drops a pane's whole `[≡]`/`[X]`/`[_]`
 *     cluster (renderPanel's all-or-nothing `fits`); the hit-tests must then report
 *     NOTHING at the would-be glyph columns. This is the former KNOWN GAP: the fix
 *     has paint publish each drawn glyph range to panel/chrome-regions and the
 *     hit-tests read it, so a dropped glyph is unclickable.
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

for (const p of ['navigator/actions', 'navigator/groups', 'monitor/stats', 'monitor/table', 'monitor/gauge', 'monitor/composite']) {
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

// PRESENCE axis — the phantom-hit fix. Squeeze the terminal so panes fall into the
// drop band (below ~120 many columns clamp to ~10 cols; even at the demo's own 120
// one pane already drops). For each triggerVisible pane: where `[≡]` is painted a
// click still opens it (agreement holds at narrow widths too); where the cluster is
// DROPPED, the would-be `[≡]` and `[_]` columns are DEAD — the bug was a phantom hit
// there. A non-vacuity check proves the sweep exercised both a paint and a drop.
const { leftBorderPrefix } = require('../leaves/render/draw');
const chromeHit = require('../panel/chrome-hittest');
const { poolIdOf } = require('../leaves/wm/pane');   // hitTestCollapseButton returns the pool-id (p.id)

describe('[chrome agreement] PRESENCE — hit-test fires on each glyph IFF it was painted', () => {
  // The `[≡]` trigger is left-anchored and truncates INDEPENDENTLY of the right
  // `[X]/[_]` cluster — a table pane carrying a `‹ sort ›` border-control can drop
  // `[≡]` (left squeeze) while `[_]` still paints on the right. So the invariant is
  // per-glyph agreement (hit-test fires exactly where paint drew), NOT whole-cluster.
  let eqDrew = 0, eqDropped = 0, collDrew = 0, collDropped = 0;
  for (const W of [120, 60]) {
    sm.resize(W, 40);
    const rows = paintedRows();
    const layout = api.getInstanceSlice('layout');
    const panes = [];
    for (const col of (layout.arrange.columns || [])) for (const pn of (col.panels || [])) if (pn.paneId) panes.push(pn);
    for (const pn of panes) {
      if (!paneMenu.triggerVisible(pn.paneId)) continue;
      const b = visibleBoundsFor(layout, pn.paneId, route.resolveViewerPaneId());
      if (!b || b.h < 1) continue;
      const line = rows[b.y + 1] || [];
      // [≡] trigger — find its painted glyph (left-anchored).
      let eqX = -1;
      for (let x = b.x + 1; x <= b.x + b.w; x++) { if (line[x] === '≡') { eqX = x - 1; break; } }   // 0-based screen x
      const trigX = b.x + leftBorderPrefix(pn.hotkey || '').triggerCol + 1;   // would-be ≡ center
      // [_] collapse — right-anchored; its `_` center sits at b.x + b.w - 3.
      const collX = b.x + b.w - 3;
      const collPainted = line[collX + 1] === '_';   // 1-based cx = collX + 1
      if (eqX >= 0) eqDrew++; else eqDropped++;
      if (collPainted) collDrew++; else collDropped++;
      it(`W=${W} ${pn.paneId} (w=${b.w}, [≡]${eqX >= 0 ? '✓' : '·'} [_]${collPainted ? '✓' : '·'}): paint↔hit-test agree`, () => {
        // Trigger: fires IFF painted; the would-be column is dead when dropped.
        if (eqX >= 0) eq(paneMenu.hitTestTrigger(eqX, b.y), pn.paneId, 'painted [≡] opens it');
        else eq(paneMenu.hitTestTrigger(trigX, b.y), null, 'dropped [≡] column is dead (no phantom)');
        // Collapse: fires IFF painted — INDEPENDENT of the trigger's fate.
        // (hitTestCollapseButton returns the pool-id, not the paneId.)
        if (collPainted) eq(chromeHit.hitTestCollapseButton(collX, b.y), poolIdOf(pn.paneId), 'painted [_] collapses it');
        else eq(chromeHit.hitTestCollapseButton(collX, b.y), null, 'dropped [_] column is dead (no phantom)');
      });
    }
  }
  it('the sweep exercised BOTH a painted and a dropped [≡] (non-vacuous)', () => {
    assert(eqDrew >= 1, `expected ≥1 painted [≡] across the sweep, got ${eqDrew}`);
    assert(eqDropped >= 1, `expected ≥1 dropped [≡] across the sweep, got ${eqDropped}`);
  });
  it('the sweep exercised a painted [_] independent of a dropped [≡] (the sort-control case)', () => {
    assert(collDrew >= 1, `expected ≥1 painted [_] across the sweep, got ${collDrew}`);
  });
});

report();
