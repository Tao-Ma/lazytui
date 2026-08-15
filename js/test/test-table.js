/**
 * table panel — the generic hub-topic table consumer (btop-style process list).
 * Pins the novel logic: the INTERNAL sort in getItems (direction, missing-value
 * sinking, string columns, native order), value formatting, and column
 * resolution. The render/selection/sort-control wiring is exercised by the
 * integration section at the bottom (register → boot → render).
 *
 * Run: node js/test/test-table.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const table = require('../panel/monitor/table');

function setMetric(topic, seriesByRow, schemaCols) {
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series: seriesByRow, schema: { columns: schemaCols } } };
}
const SCHEMA = { cpu: { type: 'percent' }, comm: { type: 'string' }, rss: { type: 'bytes' } };

describe('[table] _fmt — by schema type', () => {
  it('percent', () => eq(table._fmt(47.2, 'percent'), '47.2%'));
  it('bytes compact', () => { eq(table._fmt(512, 'bytes'), '512B'); eq(table._fmt(1536, 'bytes'), '2K'); eq(table._fmt(1.5 * 1024 ** 3, 'bytes'), '1.5G'); });
  it('number', () => { eq(table._fmt(128, 'number'), '128'); eq(table._fmt(3.14159, 'number'), '3.1'); });
  it('string passthrough', () => eq(table._fmt('postgres', 'string'), 'postgres'));
  it('NaN → em dash', () => eq(table._fmt(NaN, 'percent'), '—'));
});

describe('[table] _columns — resolution', () => {
  it('config columns win, in order', () => eq(table._columns({ columns: ['cpu', 'comm'] }, null), ['cpu', 'comm']));
  it('else non-meta schema columns', () => {
    const metric = { schema: { columns: { cpu: { type: 'percent' }, lim: { type: 'bytes', meta: true }, mem: { type: 'bytes' } } } };
    eq(table._columns({}, metric), ['cpu', 'mem']);   // meta column skipped
  });
});

describe('[table] getItems — internal sort', () => {
  it('desc by cpu; missing value sinks to the bottom', () => {
    setMetric('t', { a: [{ cpu: 10 }], b: [{ cpu: 90 }], c: [{ cpu: 50 }], d: [{}] }, SCHEMA);
    eq(table.getItems({ topic: 't', nav: { sort: { key: 'cpu', dir: -1 } } }), ['b', 'c', 'a', 'd']);
  });
  it('asc by cpu; missing value still sinks to the bottom', () => {
    setMetric('t', { a: [{ cpu: 10 }], b: [{ cpu: 90 }], c: [{ cpu: 50 }], d: [{}] }, SCHEMA);
    eq(table.getItems({ topic: 't', nav: { sort: { key: 'cpu', dir: 1 } } }), ['a', 'c', 'b', 'd']);
  });
  it('sorts on the LATEST sample per row', () => {
    setMetric('t', { a: [{ cpu: 99 }, { cpu: 5 }], b: [{ cpu: 1 }, { cpu: 80 }] }, SCHEMA);
    eq(table.getItems({ topic: 't', nav: { sort: { key: 'cpu', dir: -1 } } }), ['b', 'a']);
  });
  it('string column sorts lexically', () => {
    setMetric('t', { p1: [{ comm: 'redis' }], p2: [{ comm: 'awk' }], p3: [{ comm: 'postgres' }] }, SCHEMA);
    eq(table.getItems({ topic: 't', nav: { sort: { key: 'comm', dir: 1 } } }), ['p2', 'p3', 'p1']);
  });
  it('no sort key → native (insertion) order', () => {
    setMetric('t', { z: [{ cpu: 1 }], a: [{ cpu: 2 }] }, SCHEMA);
    eq(table.getItems({ topic: 't', nav: { sort: { key: null } } }), ['z', 'a']);
  });
  it('unknown / empty topic → []', () => {
    eq(table.getItems({ topic: 'nope', nav: {} }), []);
    eq(table.getItems({ nav: {} }), []);
  });
  it('customFilter matches the row key OR a string column (comm), not just the key', () => {
    setMetric('t', { '11': [{ cpu: 5, comm: 'nginx' }], '22': [{ cpu: 9, comm: 'postgres' }], '33': [{ cpu: 1, comm: 'redis' }] }, SCHEMA);
    const base = { topic: 't', columns: ['cpu', 'comm'], nav: { sort: { key: 'cpu', dir: -1 } } };
    eq(table.getItems({ ...base, nav: { ...base.nav, filter: 'post' } }), ['22'], 'filter by command name');
    eq(table.getItems({ ...base, nav: { ...base.nav, filter: '3' } }), ['33'], 'filter by row key (pid)');
  });
});

// --- integration: register → boot → paint the real screen --------------------
const api = require('../panel/api');
const sm = require('./smoke/_helpers/smoke');
if (!api.getComponent('table')) api.registerComponent(require('../panel/monitor/table'));

describe('[table] render — sorted, columnar (real paint)', () => {
  it('places a table pane, sorts rows by the config default, formats cells', () => {
    // Parsed-shape layout (resolved pane objects + pool), as the parser emits.
    const paneCfg = { id: 'procs', type: 'table', title: 'Procs', config: { topic: 'p.stat', columns: ['cpu', 'comm'], sort: 'cpu' } };
    sm.bootFresh({
      groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { procs: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    setMetric('p.stat', {
      '11': [{ cpu: 12.0, comm: 'redis' }],
      '22': [{ cpu: 88.5, comm: 'postgres' }],
      '33': [{ cpu: 4.0, comm: 'awk' }],
    }, SCHEMA);

    // The paint uses cursor moves, not '\n', between screen rows — assert the
    // sort by the position of each row's (unique) formatted cpu cell in the frame.
    const { frame } = sm.capture(() => sm.render());
    const hi = frame.indexOf('88.5%'), mid = frame.indexOf('12.0%'), lo = frame.indexOf('4.0%');
    assert(hi >= 0 && mid >= 0 && lo >= 0, 'all three rows rendered (88.5% / 12.0% / 4.0%)');
    assert(hi < mid && mid < lo, 'rows sorted desc by cpu (88.5 → 12.0 → 4.0)');
    assert(/postgres/.test(frame) && /redis/.test(frame) && /awk/.test(frame), 'string cells present');
  });

  it('selected bottom row stays visible when the list scrolls (header off-by-one fix)', () => {
    const paneCfg = { id: 'big', type: 'table', title: 'Big', config: { topic: 'p.big', columns: ['cpu'] } };  // native order
    sm.bootFresh({
      groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { big: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    const series = {};
    for (let i = 0; i < 40; i++) series['proc' + i] = [{ cpu: i }];   // 40 rows > any test viewport
    setMetric('p.big', series, SCHEMA);
    require('../panel/nav-state').setSel('table', 39);                 // cursor on the last row
    const { frame } = sm.capture(() => sm.render());
    // Pre-fix, the header pushed row 39 one line past the sliced viewport → invisible.
    assert(/proc39\b/.test(frame), 'the selected last row (proc39) scrolled into view');
    assert(!/proc0\b/.test(frame), 'the top rows scrolled out of view');
  });
});

report();
