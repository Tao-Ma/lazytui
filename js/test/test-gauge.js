/**
 * gauge panel — the snapshot bar-meter consumer (btop-style mem/disk/process
 * bars). Pins the novel logic: value formatting, the metered-column resolution,
 * the internal sort in getItems (bars order by the metered value), proportional
 * meter fill, and the click→bar mapping (no header, so no off-by-one). The
 * render/selection wiring is exercised by the integration section at the bottom.
 *
 * Run: node js/test/test-gauge.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const gauge = require('../panel/monitor/gauge');

const SCHEMA = { cpu: { type: 'percent' }, comm: { type: 'string' }, rx: { type: 'rate' } };

function setMetric(topic, seriesByRow, schemaCols) {
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series: seriesByRow, schema: { columns: schemaCols } } };
}

describe('[gauge] _fmt — by schema type', () => {
  it('percent', () => eq(gauge._fmt(88.5, 'percent'), '88.5%'));
  it('rate = bytes/sec', () => { eq(gauge._fmt(512, 'rate'), '512B/s'); eq(gauge._fmt(1.5 * 1024 ** 2, 'rate'), '1.5M/s'); });
  it('number', () => { eq(gauge._fmt(128, 'number'), '128'); eq(gauge._fmt(3.14159, 'number'), '3.1'); });
  it('NaN → em dash', () => eq(gauge._fmt(NaN, 'percent'), '—'));
});

describe('[gauge] _meterColumn — default resolution', () => {
  const metric = { schema: { columns: { comm: { type: 'string' }, cpu: { type: 'percent' }, mem: { type: 'percent' } } } };
  it('config column wins', () => eq(gauge._meterColumn({ column: 'mem' }, metric), 'mem'));
  it('defaults to the first percent column (skips the string)', () => eq(gauge._meterColumn({}, metric), 'cpu'));
  it('falls back to the first numeric when no percent', () => {
    const m2 = { schema: { columns: { name: { type: 'string' }, n: { type: 'number' } } } };
    eq(gauge._meterColumn({}, m2), 'n');
  });
});

describe('[gauge] getItems — bars ordered by metered value', () => {
  it('sorts desc by the metered column; missing values sink', () => {
    const metric = {
      series: { a: [{ cpu: 12 }], b: [{ cpu: 88 }], c: [{}], d: [{ cpu: 47 }] },
      schema: { columns: { cpu: { type: 'percent' } } },
    };
    getModel().metrics = { t: metric };
    eq(gauge.getItems({ topic: 't', column: 'cpu', sortDir: -1 }).join(','), 'b,d,a,c', 'desc, missing (c) last');
    eq(gauge.getItems({ topic: 't', column: 'cpu', sortDir: 1 }).join(','), 'a,d,b,c', 'asc, missing (c) still last');
  });
});

// --- Integration: register → boot → real paint ---

const api = require('../panel/api');
const sm = require('./smoke/_helpers/smoke');
const nav = require('../panel/nav-state');
const rq = require('../leaves/infra/render-queue');
if (!api.getComponent('gauge')) api.registerComponent(require('../panel/monitor/gauge'));

// Decode the painted frame → screen-row → { text, procKey } so a test can find
// the ACTUAL screen y a given bar rendered at (paint uses absolute cursor moves).
function screenGrid() {
  let raw = '';
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { raw += s; return true; };
  rq.forceFullRepaint();
  sm.render();
  process.stdout.write = orig;
  const rows = {}; let cy = 1, cx = 1, i = 0;
  while (i < raw.length) {
    if (raw[i] === '\x1b') {
      const mm = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(raw.slice(i));
      if (mm) { const p = mm[1].split(';').map(Number); if (mm[2] === 'H') { cy = p[0] || 1; cx = p[1] || 1; } i += mm[0].length; continue; }
      i++; continue;
    }
    if (raw[i] === '\n') { cy++; cx = 1; i++; continue; }
    rows[cy] = rows[cy] || []; rows[cy][cx] = raw[i]; cx++; i++;
  }
  const out = {};
  for (const y of Object.keys(rows)) out[Number(y)] = (rows[y] || []).join('');
  return out;
}

describe('[gauge] render — sorted bars, labels, proportional fill (real paint)', () => {
  it('renders one labeled bar per row, ordered by the metered value, filled proportionally', () => {
    const paneCfg = { id: 'bars', type: 'gauge', title: 'CPU', config: { topic: 'host.proc', column: 'cpu', label: 'comm' } };
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { bars: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    setMetric('host.proc', {
      '101': [{ cpu: 88.5, comm: 'postgres' }],
      '102': [{ cpu: 12.0, comm: 'redis' }],
      '103': [{ cpu: 4.0, comm: 'awk' }],
      '104': [{ cpu: 47.0, comm: 'node' }],
    }, SCHEMA);
    const { frame } = sm.capture(() => sm.render());
    // Labels from the `label:` column (comm), ordered desc by cpu.
    const iPg = frame.indexOf('postgres'), iNode = frame.indexOf('node'), iRedis = frame.indexOf('redis'), iAwk = frame.indexOf('awk');
    assert(iPg >= 0 && iNode >= 0 && iRedis >= 0 && iAwk >= 0, 'all four bar labels rendered');
    assert(iPg < iNode && iNode < iRedis && iRedis < iAwk, 'bars ordered desc by cpu (postgres → node → redis → awk)');
    assert(/88\.5%/.test(frame) && /47\.0%/.test(frame) && /4\.0%/.test(frame), 'formatted values present');

    // Proportional fill: the higher-cpu bar has strictly more full blocks.
    const grid = screenGrid();
    const full = {};
    for (const y of Object.keys(grid).map(Number)) {
      const m = /(postgres|node|redis|awk)/.exec(grid[y]);
      if (m) full[m[1]] = (grid[y].match(/█/g) || []).length;
    }
    assert(full.postgres > full.node && full.node > full.redis && full.redis > full.awk,
      `bar fill is proportional to value (postgres ${full.postgres} > node ${full.node} > redis ${full.redis} > awk ${full.awk})`);
  });

  it('empty states: no topic, no data, no numeric column', () => {
    const paneCfg = { id: 'e', type: 'gauge', title: 'E', config: { topic: 'nope', column: 'cpu' } };
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { e: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    const { frame } = sm.capture(() => sm.render());
    assert(/no data yet/.test(frame), 'unknown/empty topic → (no data yet)');
  });
});

describe('[gauge] click selects the bar under the cursor (no header → no off-by-one)', () => {
  it('clicking a bar row selects that row; a stats pane could select_from it', () => {
    const paneCfg = { id: 'bars', type: 'gauge', title: 'CPU', config: { topic: 'host.proc', column: 'cpu', label: 'comm' } };
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { bars: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    setMetric('host.proc', {
      '101': [{ cpu: 88.5, comm: 'postgres' }],
      '102': [{ cpu: 12.0, comm: 'redis' }],
      '103': [{ cpu: 4.0, comm: 'awk' }],
      '104': [{ cpu: 47.0, comm: 'node' }],
    }, SCHEMA);
    sm.capture(() => sm.render());
    const grid = screenGrid();
    const items = api.getItems('bars');   // rowKeys, sorted desc by cpu
    const labelOf = { '101': 'postgres', '104': 'node', '102': 'redis', '103': 'awk' };
    let checked = 0;
    for (const y of Object.keys(grid).map(Number)) {
      const m = /(postgres|node|redis|awk)/.exec(grid[y]);
      if (!m) continue;
      nav.setSel('bars', 0);
      sm.capture(() => sm.handleMouse('press', 3, y));
      const sel = nav.getSel('bars');
      // getItems returns rowKeys (so a stats pane can select_from this gauge);
      // the selected rowKey's label must match the bar shown at the click.
      eq(labelOf[items[sel]], m[1], `click screen-row ${y} selects the ${m[1]} bar`);
      checked++;
    }
    assert(checked >= 3, 'exercised several bars');
  });
});

// Regression: a gauge is a WINDOWED self-slicing pane (like the table) — it
// re-clamps its own scroll at render but the model getScroll isn't re-clamped to
// the list bounds, so getScroll diverges on a resize / row-shrink while scrolled.
// The click→row mapping must read the PAINTED scroll (the capture), not getScroll,
// or every click lands on the wrong bar. See input.js `_rowIndexAt` (cap.windowed).
describe('[gauge] click uses the painted scroll after a row-shrink (divergence regression)', () => {
  // Fresh divergent setup per click (a prior click repaints + re-clamps scroll,
  // collapsing the divergence — so each assertion rebuilds it), then ONE click.
  function clickAfterShrink(screenY) {
    const paneCfg = { id: 'bars', type: 'gauge', title: 'CPU', config: { topic: 'host.proc', column: 'v' } };
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { bars: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    sm.resize(80, 12);                                   // short pane → the list overflows
    const set = (n) => { const s = {}; for (let i = 0; i < n; i++) s['p' + i] = [{ v: i }]; setMetric('host.proc', s, { v: { type: 'number' } }); };
    set(40); nav.setSel('bars', 39); sm.capture(() => sm.render());   // scroll to the bottom
    set(20); sm.capture(() => sm.render());              // 20 procs exit → getScroll now stale/divergent
    const grid = screenGrid();
    const items = api.getItems('bars');
    const cap = require('../panel/select-view').contentFor('pane-bars');
    const m = /p\d+/.exec(grid[screenY] || '');          // the proc painted at this screen row
    sm.capture(() => sm.handleMouse('press', 3, screenY));
    return { shown: m ? m[0] : null, selected: items[nav.getSel('bars')], diverged: nav.getScroll('bars') !== (cap && cap.scroll) };
  }

  it('clicking a visible bar selects THAT bar even when getScroll has diverged', () => {
    let checked = 0, diverged = false;
    for (const y of [2, 5, 8, 10]) {
      const r = clickAfterShrink(y);
      if (r.shown == null) continue;                     // that screen row had no bar
      diverged = diverged || r.diverged;
      eq(r.selected, r.shown, `divergent gauge: click screen-row ${y} selects ${r.shown} (painted there)`);
      checked++;
    }
    assert(checked >= 3, 'exercised several bars under divergence');
    assert(diverged, 'the scenario actually produced a getScroll↔painted divergence (else the test is vacuous)');
  });
});

// Visual: btop-style bounded meter + grey track. The bar is capped at
// `bar_width` (doesn't sprawl across a wide pane) and the unfilled remainder is a
// dim `░` track (the whole bar reads as a meter, not a colour stub). See gauge.js
// `_meter` + the `barMax`/`trailW` logic.
describe('[gauge] bounded meter + grey track', () => {
  const FILL = /[█▏▎▍▌▋▊▉]/g, TRACK = /░/g, BAR = /[█▏▎▍▌▋▊▉░]/g;
  it('caps the bar at bar_width and fills the remainder with a dim track', () => {
    const paneCfg = { id: 'bw', type: 'gauge', title: 'CPU', config: { topic: 'm.bw', column: 'cpu', bar_width: 10 } };
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { bw: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    setMetric('m.bw', { half: [{ cpu: 50 }], zero: [{ cpu: 0 }] }, { cpu: { type: 'percent' } });
    const grid = screenGrid();
    let halfLine = '', zeroLine = '';
    for (const y of Object.keys(grid).map(Number)) {
      if (/half/.test(grid[y])) halfLine = grid[y];
      if (/zero/.test(grid[y])) zeroLine = grid[y];
    }
    eq((halfLine.match(BAR) || []).length, 10, 'bar bounded to bar_width=10 (not the full ~78-col pane)');
    const hf = (halfLine.match(FILL) || []).length, ht = (halfLine.match(TRACK) || []).length;
    assert(hf >= 4 && ht >= 4, `50% → ~half fill, ~half grey track (fill ${hf}, track ${ht})`);
    eq((zeroLine.match(FILL) || []).length, 0, '0% → no fill');
    eq((zeroLine.match(TRACK) || []).length, 10, '0% → full grey track (btop shows the whole bar)');
  });
});

report();
