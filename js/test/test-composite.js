/**
 * composite panel — btop-density boxes (docs/compact-panes.md). Pins the novel
 * logic: widget-height split (anchored heightPct + flex, headings/gaps reserved),
 * the subscriptions UNION across widget topics, and that render stacks the reused
 * stats/gauge bodies inside ONE bordered box. The bodies themselves are covered by
 * test-render-body / test-stats / test-gauge.
 *
 * Run: node js/test/test-composite.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { stripMarkup } = require('../leaves/text/ansi');
const composite = require('../panel/monitor/composite');
const api = require('../panel/api');
const sm = require('./smoke/_helpers/smoke');
const nav = require('../panel/nav-state');

function setMetric(topic, series, cols) {
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series, schema: { columns: cols } } };
}

describe('[composite] _heightPct', () => {
  it('number → clamped percent', () => { eq(composite._heightPct(45), 45); eq(composite._heightPct(150), 100); });
  it('"N%" string → number', () => eq(composite._heightPct('55%'), 55));
  it('absent / invalid / zero → null (flex)', () => {
    eq(composite._heightPct(undefined), null);
    eq(composite._heightPct('x'), null);
    eq(composite._heightPct(0), null);
  });
});

describe('[composite] _split — anchored + flex, headings/gaps reserved', () => {
  it('two flex widgets share the inner height minus the 1-row gap', () => {
    const hs = composite._split([{ type: 'graph' }, { type: 'graph' }], 21);
    eq(hs.length, 2);
    eq(hs[0] + hs[1], 20);   // 21 - 1 gap
  });
  it('anchored heightPct honored; flex takes the rest', () => {
    const hs = composite._split([{ type: 'graph', height: '50%' }, { type: 'graph' }], 22);
    eq(hs[0] + hs[1], 21);   // 22 - 1 gap
    assert(hs[0] >= 10 && hs[0] <= 11, `~50% of 21 body rows, got ${hs[0]}`);
  });
  it('a heading reserves one extra row', () => {
    const hs = composite._split([{ type: 'bars', heading: 'Cores' }, { type: 'graph' }], 21);
    eq(hs[0] + hs[1], 19);   // 21 - 1 heading - 1 gap
  });
});

describe('[composite] subscriptions — union across widget topics', () => {
  it('one metrics-mirror per distinct topic+window (dedup)', () => {
    const subs = composite.subscriptions({ widgets: [
      { type: 'graph', topic: 'a' },
      { type: 'bars',  topic: 'a' },              // dup topic+window → deduped
      { type: 'graph', topic: 'b', window: 60 },
    ] });
    eq(subs.length, 2);
    assert(subs.every((s) => s.kind === 'metrics-mirror'), 'all metrics-mirror');
    eq(subs.find((s) => s.topic === 'b').window, 60);
  });
  it('no widgets → no subs', () => eq(composite.subscriptions({}).length, 0));
});

describe('[composite] render — stacks bodies in one border', () => {
  setMetric('c.cpu', { _: [{ cpu: 10 }, { cpu: 50 }, { cpu: 90 }] }, { cpu: { type: 'percent' } });
  setMetric('c.core', { c0: [{ busy: 30 }], c1: [{ busy: 70 }] }, { busy: { type: 'percent' } });

  const panel = { title: 'CPU', widgets: [
    { type: 'graph', topic: 'c.cpu', row: '_', metrics: ['cpu'], height: '55%' },
    { type: 'bars',  topic: 'c.core', column: 'busy', heading: 'Cores' },
  ] };

  it('one bordered box, exactly h rows tall, titled, both bodies present', () => {
    const out = composite.panelTypes.composite.render(panel, 40, 14, {}, {});
    const rows = out.split('\n');
    eq(rows.length, 14, 'exactly h rows');
    assert(stripMarkup(rows[0]).includes('CPU'), 'title in the top border');
    const body = stripMarkup(out);
    assert(body.includes('Cores'), 'the bars heading is drawn');
    assert(body.includes('c1'), 'a per-core bar (row c1) is drawn');
  });

  it('a too-short box does not paint a phantom scrollbar (composites do not scroll)', () => {
    // At h=6 (innerH 4) the graph + heading + gap + bars stack overflows innerH;
    // renderPanel must not infer a scrollable total and paint a thumb.
    const out = composite.panelTypes.composite.render(panel, 40, 6, {}, {});
    const rows = out.split('\n');
    eq(rows.length, 6, 'exactly h rows');
    assert(!rows.some((r) => r.includes('▐')), `no scrollbar thumb on an over-full composite — ${JSON.stringify(rows)}`);
  });

  it('empty widgets → a dim hint, still a bordered box of h rows', () => {
    const out = composite.panelTypes.composite.render({ title: 'X', widgets: [] }, 30, 6, {}, {});
    eq(out.split('\n').length, 6);
    assert(stripMarkup(out).includes('needs a widgets'), 'hint shown');
  });

  it('unknown widget type → a dim marker, not a crash', () => {
    const out = composite.panelTypes.composite.render(
      { title: 'X', widgets: [{ type: 'bogus', topic: 'c.cpu' }] }, 30, 6, {}, {});
    assert(stripMarkup(out).includes('unknown widget type'), 'marker shown');
  });

  it('a `meter` widget draws exactly ONE bar (the top-sorted row), unlike `bars`', () => {
    // c.core has 2 rows (c0=30, c1=70). `bars` → 2 bars; `meter` → 1 (top = c1).
    const out = composite.panelTypes.composite.render(
      { title: 'M', widgets: [{ type: 'meter', topic: 'c.core', column: 'busy' }] }, 40, 8, {}, {});
    const body = stripMarkup(out);
    assert(body.includes('c1'), 'the top-sorted row (c1=70) is the single meter');
    assert(!body.includes('c0'), 'the lower row (c0) is NOT drawn — meter is single-row');
  });

  it('a `meter` with `row:` selects that row by key', () => {
    const out = composite.panelTypes.composite.render(
      { title: 'M', widgets: [{ type: 'meter', topic: 'c.core', column: 'busy', row: 'c0' }] }, 40, 8, {}, {});
    const body = stripMarkup(out);
    assert(body.includes('c0'), 'row:c0 selected');
    assert(!body.includes('c1'), 'the top row (c1) is NOT drawn when row:c0 is pinned');
  });

  it('a sub-2 degenerate size degrades gracefully, never throws (round-3 review)', () => {
    // A full-viewed box on a ≤2-row / ≤1-col terminal hands render() h<2 or w<2, so
    // innerH/innerW go negative. The phantom-scrollbar cap (`lines.length = innerH`)
    // and renderPanel's countless bottom border (`repeat(innerW)`) both must clamp
    // at 0 rather than RangeError — matching gauge's graceful degradation.
    for (const [w, h] of [[1, 1], [40, 1], [1, 12], [2, 2], [40, 2]]) {
      let out;
      try { out = composite.panelTypes.composite.render(panel, w, h, {}, {}); }
      catch (e) { assert(false, `render ${w}x${h} threw: ${e && e.message}`); }
      assert(typeof out === 'string' && !out.includes('▐'), `${w}x${h}: string, no phantom thumb`);
    }
  });
});

// --- Interactive sub-widget: a focusable/scrollable `bars` inside the box ---
describe('[composite] interactive widget — cursor inside the box', () => {
  for (const p of ['monitor/stats', 'monitor/gauge', 'monitor/composite']) {
    const c = require(`../panel/${p}`);
    if (!api.getComponent(c.name)) { try { api.registerComponent(c); } catch (_) { /* order-guarded */ } }
  }

  const paneCfg = { id: 'cbox', type: 'composite', title: 'CPU', config: { widgets: [
    { type: 'graph', topic: 'ci.cpu', row: '_', metrics: ['cpu'], height: '40%' },
    { type: 'bars',  topic: 'ci.core', column: 'busy', label: 'core', interactive: true },
  ] } };

  function boot() {
    sm.bootFresh({
      groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { cbox: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    setMetric('ci.cpu', { _: [{ cpu: 20 }, { cpu: 40 }, { cpu: 60 }] }, { cpu: { type: 'percent' } });
    setMetric('ci.core', { c0: [{ busy: 30, core: 'cpu0' }], c1: [{ busy: 70, core: 'cpu1' }], c2: [{ busy: 50, core: 'cpu2' }] },
      { busy: { type: 'percent' }, core: { type: 'string' } });
  }

  it('getItems on the placed pane = the interactive bars rows (sorted desc)', () => {
    boot();
    eq(api.getItems('cbox').join(','), 'c1,c2,c0', 'the interactive widget drives the cursor list');
  });

  it('getInfo on the placed pane → the selected row detail card (topic resolved via the interactive widget)', () => {
    boot();
    const mpool = require('../leaves/wm/pool');
    const ls = api.getInstanceSlice('layout');
    const paneId = mpool.allPanesInColumns(ls.arrange).find((p) => p.type === 'composite').paneId;
    const info = composite.panelTypes.composite.getInfo('c1', paneId);
    assert(info.length > 1, `not the bare [row: …] fallback → topic resolved: ${JSON.stringify(info)}`);
    assert(info.some((l) => stripMarkup(l).includes('cpu1')), `detail card projects the ci.core row fields: ${JSON.stringify(info)}`);
  });

  it('a focused composite threads the cursor → the selected bar row renders differently', () => {
    boot();
    const mpool = require('../leaves/wm/pool');
    const ls = api.getInstanceSlice('layout');
    const paneId = mpool.allPanesInColumns(ls.arrange).find((p) => p.type === 'composite').paneId;
    nav.setSel(paneId, 0);   // top of the sorted list (c1 = cpu1)

    // Unfocused → display mode (no cursor highlight). Focused → the selected row
    // gets the `[selected]` treatment. Assert the cpu1 line CHANGES between the two
    // (colour-independent: any difference proves the cursor is threaded + applied,
    // dodging the CI truecolor-vs-16-colour SGR fragility).
    ls.focus = 'nobody';
    const cpu1Unfocused = sm.capture(() => sm.render()).frame.split('\n').find((l) => l.includes('cpu1'));
    ls.focus = paneId;
    const cpu1Focused = sm.capture(() => sm.render()).frame.split('\n').find((l) => l.includes('cpu1'));
    assert(cpu1Unfocused && cpu1Focused, 'the cpu1 bar rendered in both');
    assert(cpu1Unfocused !== cpu1Focused, 'the SELECTED (sel 0 = cpu1) row renders differently when the box is focused — cursor threaded in');
  });

  it('a display-only composite (no interactive widget) exposes NO cursor rows', () => {
    const display = { id: 'd', type: 'composite', title: 'D', config: { widgets: [{ type: 'graph', topic: 'ci.cpu', row: '_', metrics: ['cpu'] }] } };
    sm.bootFresh({
      groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { d: display }, columns: [{ panels: [display] }] },
    });
    setMetric('ci.cpu', { _: [{ cpu: 20 }] }, { cpu: { type: 'percent' } });
    eq(api.getItems('d').length, 0, 'display composite has no interactive rows → nav no-ops');
  });
});

report();
