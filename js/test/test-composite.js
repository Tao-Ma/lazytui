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
});

report();
