/**
 * Stats panel smoke test — exercises the line-graph rasterizer, the
 * docker stat-string parsers, default-metrics inference, and value
 * formatters. Hub schema registration is verified via the docker
 * plugin's init() side effect.
 *
 * Run: node js/test/test-stats.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const hub = require('../leaves/infra/hub');
const { update } = require('../app/runtime');
const { rasterize, rasterizeBraille, rasterizeBrailleMulti, columnNorms, colorizeRows, colorizeOverlay, colorizeByHeight, quantizeNorm, meterRow, BLOCKS } = require('../panel/monitor/stats-graph');
const stats = require('../panel/monitor/stats');
const docker = require('../panel/navigator/docker');

// --- rasterize: shape ---

describe('[1] rasterize: empty / degenerate inputs', () => {
  it('zero height returns []', () => {
    eq(rasterize([1, 2, 3], { width: 5, height: 0, min: 0, max: 10 }), []);
  });
  it('zero width returns rows of length 0', () => {
    const rows = rasterize([1, 2, 3], { width: 0, height: 3, min: 0, max: 10 });
    eq(rows.length, 0, 'no columns → no point producing rows');
  });
  it('empty samples → empty cells but right shape', () => {
    const rows = rasterize([], { width: 4, height: 3, min: 0, max: 10 });
    eq(rows.length, 3, 'three rows');
    rows.forEach(r => eq(r.length, 4, 'each row exactly W wide'));
    rows.forEach(r => eq(r, '    ', 'all-empty cells render as spaces'));
  });
});

describe('[2] rasterize: right-aligned, NaN as gap', () => {
  it('shorter-than-width samples left-pad with empty cells', () => {
    const rows = rasterize([100], { width: 4, height: 1, min: 0, max: 100 });
    eq(rows.length, 1);
    eq(rows[0], '   █', 'newest sample at last column, full cell');
  });
  it('NaN values render as space', () => {
    const rows = rasterize([NaN, 50, NaN, 100], { width: 4, height: 1, min: 0, max: 100 });
    eq(rows[0][0], ' ', 'col 0 is NaN');
    eq(rows[0][2], ' ', 'col 2 is NaN');
    eq(rows[0][3], '█', 'col 3 is 100% → full cell');
  });
});

describe('[3] rasterize: scale clamping', () => {
  it('values above max clamp to full', () => {
    const rows = rasterize([200], { width: 1, height: 1, min: 0, max: 100 });
    eq(rows[0], '█', '200 of 100 max → full cell');
  });
  it('values below min clamp to empty', () => {
    const rows = rasterize([-50], { width: 1, height: 1, min: 0, max: 100 });
    eq(rows[0], ' ', 'negative → empty cell');
  });
  it('zero range produces empty graph', () => {
    const rows = rasterize([5, 5, 5], { width: 3, height: 2, min: 5, max: 5 });
    rows.forEach(r => eq(r, '   ', 'flat range with no spread → empty'));
  });
});

describe('[4] rasterize: vertical resolution', () => {
  it('single row uses 8 fill levels', () => {
    // Sample at exactly 50% should be 4 of 8 levels — block "▄".
    const rows = rasterize([50], { width: 1, height: 1, min: 0, max: 100 });
    eq(rows[0], BLOCKS[4], '50% of 8 levels = ▄');
  });
  it('multi-row uses (H*8) levels — bottom-up fill', () => {
    // 3 rows × 8 levels = 24 slots. Value=12 of 100 → slot 3 of 24,
    // appears in bottom row only.
    const rows = rasterize([12.5], { width: 1, height: 3, min: 0, max: 100 });
    eq(rows.length, 3);
    eq(rows[0], ' ', 'top row empty');
    eq(rows[1], ' ', 'middle row empty');
    eq(rows[2], BLOCKS[3], 'bottom row = ▃');
  });
  it('full value → all rows full', () => {
    const rows = rasterize([100, 100, 100], { width: 3, height: 3, min: 0, max: 100 });
    rows.forEach(r => eq(r, '███', 'every cell full'));
  });
});

// --- braille rasterizer + colorize + meter (truecolor arc Phase 2) ---

describe('[4b] rasterizeBraille: contract mirrors rasterize', () => {
  it('zero height / width degenerate to []', () => {
    eq(rasterizeBraille([1], { width: 3, height: 0, min: 0, max: 1 }).length, 0);
    eq(rasterizeBraille([1], { width: 0, height: 2, min: 0, max: 1 }).length, 0);
  });
  it('exact shape: height rows × width chars', () => {
    const rows = rasterizeBraille([50, 50, 50, 50], { width: 5, height: 2, min: 0, max: 100 });
    eq(rows.length, 2);
    rows.forEach(r => eq(r.length, 5, 'row width'));
  });
  it('2 samples per column, newest-last at the right edge', () => {
    // 2 columns × 2 samples: [0, 0, 100, 100] → left col empty, right full.
    const rows = rasterizeBraille([0, 0, 100, 100], { width: 2, height: 1, min: 0, max: 100 });
    eq(rows[0][0], ' ', 'zero column empty');
    eq(rows[0][1], '⣿', 'full column = all 8 dots');
  });
  it('half-cell: one finite + one NaN sample fills one dot column', () => {
    const rows = rasterizeBraille([100, NaN], { width: 1, height: 1, min: 0, max: 100 });
    eq(rows[0], '⡇', 'left dot column full, right empty');
  });
  it('right-aligned: short series left-pads with gaps', () => {
    const rows = rasterizeBraille([100, 100], { width: 3, height: 1, min: 0, max: 100 });
    eq(rows[0], '  ⣿', 'newest data at column W-1');
  });
  it('vertical resolution is H*4 dot slots, bottom-up', () => {
    // 2 rows × 4 slots = 8. Value 25% of range → slot 2 → bottom row, 2 dots.
    const rows = rasterizeBraille([25, 25], { width: 1, height: 2, min: 0, max: 100 });
    eq(rows[0], ' ', 'top row empty');
    eq(rows[1], '⣤', 'bottom row: 2 dot-rows in both columns');
  });
  it('zero range renders empty (mirrors rasterize)', () => {
    const rows = rasterizeBraille([5, 5], { width: 1, height: 1, min: 0, max: 0 });
    eq(rows[0], ' ');
  });
});

describe('[4b-overlay] rasterizeBrailleMulti + colorizeOverlay', () => {
  it('degenerate / empty → { rows:[], owners:[] }', () => {
    eq(rasterizeBrailleMulti([[1]], { width: 3, height: 0, min: 0, max: 1 }).rows.length, 0);
    eq(rasterizeBrailleMulti([], { width: 3, height: 2, min: 0, max: 1 }).rows.length, 0);
  });
  it('single series matches rasterizeBraille glyphs (n=1 is the base case)', () => {
    const s = [0, 0, 100, 100];
    const one = rasterizeBraille(s, { width: 2, height: 1, min: 0, max: 100 });
    const multi = rasterizeBrailleMulti([s], { width: 2, height: 1, min: 0, max: 100 });
    eq(multi.rows[0], one[0], 'glyphs identical to the single-series rasterizer');
  });
  it('ORs two series into one cell + records the owner (last series wins the colour)', () => {
    // series A fills the LEFT dot-col, series B the RIGHT dot-col of a 1-cell grid.
    const A = [100, NaN];   // → ⡇ (left)
    const B = [NaN, 100];   // → ⢸ (right)
    const { rows, owners } = rasterizeBrailleMulti([A, B], { width: 1, height: 1, min: 0, max: 100 });
    eq(rows[0], '⣿', 'both dot-columns lit = merged glyph');
    eq(owners[0][0], 1, 'series B (index 1, drawn last) owns the cell colour');
  });
  it('colorizeOverlay wraps each cell in its owner series colour; spaces stay bare', () => {
    const rows = ['⡇⢸ '];
    const owners = [[0, 1, -1]];
    const out = colorizeOverlay(rows, owners, ['accent', 'warning']);
    eq(out[0], '[accent]⡇[/][warning]⢸[/] ');
  });
});

describe('[4c] columnNorms: grouping + peaks + gaps', () => {
  it('group=1 aligns with blocks columns', () => {
    eq(columnNorms([0, 50, 100], { width: 3, min: 0, max: 100, group: 1 }).join(','), '0,0.5,1');
  });
  it('degenerate width → [] (matches the rasterizers; a sub-2-col pane, else RangeError)', () => {
    eq(columnNorms([1, 2, 3], { width: 0, min: 0, max: 10, group: 1 }), []);
    eq(columnNorms([1, 2, 3], { width: -1, min: 0, max: 10, group: 2 }), []);
  });
  it('group=2 takes the max of each pair (peaks win)', () => {
    eq(columnNorms([10, 90, 40, 20], { width: 2, min: 0, max: 100, group: 2 }).join(','), '0.9,0.4');
  });
  it('all-gap group → NaN; mixed group ignores the gap', () => {
    const n = columnNorms([NaN, NaN, NaN, 60], { width: 2, min: 0, max: 100, group: 2 });
    assert(Number.isNaN(n[0]), 'gap column');
    eq(n[1], 0.6, 'finite half wins');
  });
  it('right-aligned like the rasterizers', () => {
    const n = columnNorms([100], { width: 3, min: 0, max: 100, group: 1 });
    assert(Number.isNaN(n[0]) && Number.isNaN(n[1]), 'padded columns are gaps');
    eq(n[2], 1);
  });
});

describe('[4d] colorizeRows: run batching + [/] termination (P8)', () => {
  const colorFor = (n) => (Number.isFinite(n) ? (n > 0.5 ? 'hot' : 'cold') : null);
  it('adjacent same-color columns batch into one run', () => {
    const out = colorizeRows(['████'], [0.1, 0.2, 0.9, 0.95], colorFor);
    eq(out[0], '[cold]██[/][hot]██[/]');
  });
  it('space columns stay uncolored and split runs', () => {
    const out = colorizeRows(['█ █'], [0.9, NaN, 0.9], colorFor);
    eq(out[0], '[hot]█[/] [hot]█[/]');
  });
  it('every run is [/]-terminated — no reset-free color changes (P8)', () => {
    const norms = Array.from({ length: 16 }, (_, i) => i / 15);
    const out = colorizeRows(['████████████████'], norms, (n) => `c${Math.round(n * 15)}`)[0];
    const opens = (out.match(/\[c\d+\]/g) || []).length;
    const closes = (out.match(/\[\/\]/g) || []).length;
    eq(opens, closes, 'one [/] per color run');
    assert(!/\[c\d+\][^[]*\[c\d+\]/.test(out), 'no color tag directly follows another without [/]');
  });
  it('uncolored rows pass through unchanged', () => {
    eq(colorizeRows(['   '], [NaN, NaN, NaN], colorFor)[0], '   ');
  });
});

describe('[4d2] colorizeByHeight: one run per row, colored by vertical position', () => {
  // frac is passed the row's height fraction (1 = top row, 0 = bottom).
  const colorFor = (frac) => `r${Math.round(frac * 100)}`;
  it('each row is a single run keyed to its row fraction (top=1, bottom=0)', () => {
    const out = colorizeByHeight(['███', '███', '███'], colorFor);
    eq(out[0], '[r100]███[/]', 'top row = frac 1');
    eq(out[1], '[r50]███[/]',  'middle row = frac 0.5');
    eq(out[2], '[r0]███[/]',   'bottom row = frac 0');
  });
  it('the same row keeps its color regardless of contents (byte-thrift: static per row)', () => {
    // Two ticks of a moving bar in the SAME row → identical color run (only the
    // glyphs differ), which is exactly what lets cell-diff skip the SGR.
    const a = colorizeByHeight(['█▄ ', '   '], colorFor)[0];
    const b = colorizeByHeight([' ▄█', '   '], colorFor)[0];
    assert(a.startsWith('[r100]') && b.startsWith('[r100]'), 'same row → same color atom across ticks');
  });
  it('all-gap rows pass through uncolored', () => {
    eq(colorizeByHeight(['   ', '█  '], colorFor)[0], '   ');
  });
  it('single-row graph gets the top (frac 1) color', () => {
    eq(colorizeByHeight(['██'], colorFor)[0], '[r100]██[/]');
  });
});

describe('[4d3] quantizeNorm: snap to N evenly-spaced bands', () => {
  it('8 bands → centers at k/7', () => {
    eq(quantizeNorm(0, 8), 0);
    eq(quantizeNorm(1, 8), 1);
    eq(Math.round(quantizeNorm(0.5, 8) * 7), 4, '0.5 → nearest band (4/7)');
  });
  it('nearby values collapse to the same band (fewer SGR changes)', () => {
    eq(quantizeNorm(0.70, 8), quantizeNorm(0.72, 8), 'small shift stays in-band');
  });
  it('clamps out-of-range and passes NaN through (a gap stays uncolored)', () => {
    eq(quantizeNorm(-0.5, 8), 0);
    eq(quantizeNorm(1.5, 8), 1);
    assert(Number.isNaN(quantizeNorm(NaN, 8)), 'NaN → NaN');
  });
});

describe('[4e] meterRow: eighth-block horizontal fill', () => {
  it('empty / full / clamped', () => {
    eq(meterRow(0, 4), '    ');
    eq(meterRow(1, 4), '████');
    eq(meterRow(7, 4), '████', 'clamps above 1');
    eq(meterRow(NaN, 4), '    ', 'non-finite → empty track');
  });
  it('partial fill uses eighth blocks', () => {
    eq(meterRow(0.5, 1), '▌', 'half of one cell');
    eq(meterRow(0.5, 4), '██  ', 'half of four cells');
    eq(meterRow(0.75, 2), '█▌', 'one full + one half');
    eq(meterRow(9 / 16, 2), '█▏', 'eighth precision: 9/16 of 2 cells = 1 + 1/8');
  });
  it('always exactly width chars', () => {
    for (const f of [0, 0.33, 0.66, 1]) eq(meterRow(f, 7).length, 7);
  });
});

describe('[4f] _renderSection composition — braille default, meter, gradient', () => {
  const schema = { columns: { cpu: { type: 'percent' }, mem: { type: 'bytes' } } };
  const samples = Array.from({ length: 20 }, (_, i) => ({ cpu: i * 5, mem: 1024 * (i + 1) }));
  it('percent metric: header + meter + graph rows, braille glyphs, hex gradient tags', () => {
    const out = stats._renderSection('cpu', samples, schema, 20, 2, 'braille');
    eq(out.length, 4, 'header + meter + 2 graph rows');
    assert(out[0].includes('[bold]CPU[/]'), 'header label');
    assert(/\[#[0-9a-f]{6}\]/i.test(out[1]), 'meter is gradient-colored');
    assert(out[1].includes('█') || out[1].includes('▌'), 'meter uses block fill');
    assert(/[⠀-⣿]/.test(out[2] + out[3]), 'graph rows are braille');
    assert(/\[#[0-9a-f]{6}\]/i.test(out[2] + out[3]), 'graph runs are gradient-colored');
    assert(!/\[#[0-9a-f]{6}\][^[]*\[#/i.test(out[2]), 'runs are [/]-terminated (P8)');
  });
  it('bytes metric: no meter row', () => {
    const out = stats._renderSection('mem', samples, schema, 20, 2, 'braille');
    eq(out.length, 3, 'header + 2 graph rows only');
  });
  it("graph: 'blocks' opts out of braille", () => {
    const out = stats._renderSection('cpu', samples, schema, 20, 2, 'blocks');
    assert(!/[⠀-⣿]/.test(out.join('')), 'no braille glyphs');
    assert(/[▁▂▃▄▅▆▇█]/.test(out[2] + out[3]), 'block glyphs instead');
    assert(/\[#[0-9a-f]{6}\]/i.test(out[2] + out[3]), 'blocks are gradient-colored too');
  });
});

// --- docker stat parsers ---

describe('[5] parseBytes: docker mem unit forms', () => {
  it('plain bytes', () => eq(docker._parseBytes('512B'), 512));
  it('KiB binary', () => eq(docker._parseBytes('1KiB'), 1024));
  it('MiB binary', () => eq(docker._parseBytes('120MiB'), 120 * 1024 * 1024));
  it('GiB binary', () => eq(docker._parseBytes('2GiB'), 2 * 1024 ** 3));
  it('decimal MB', () => eq(docker._parseBytes('1MB'), 1_000_000));
  it('fractional + space', () => eq(docker._parseBytes('1.5 MiB'), 1.5 * 1024 * 1024));
  it('garbled returns NaN', () => assert(Number.isNaN(docker._parseBytes('???'))));
  it('empty returns NaN', () => assert(Number.isNaN(docker._parseBytes(''))));
});

describe('[6] parseMem: split "used / limit"', () => {
  it('splits and parses both sides', () => {
    const r = docker._parseMem('120MiB / 2GiB');
    eq(r.used, 120 * 1024 * 1024);
    eq(r.limit, 2 * 1024 ** 3);
  });
  it('missing limit → NaN', () => {
    const r = docker._parseMem('120MiB');
    eq(r.used, 120 * 1024 * 1024);
    assert(Number.isNaN(r.limit), 'no slash → limit unknown');
  });
});

describe('[7] parsePercent', () => {
  it('with sign', () => eq(docker._parsePercent('3.2%'), 3.2));
  it('without sign', () => eq(docker._parsePercent('47'), 47));
  it('zero', () => eq(docker._parsePercent('0%'), 0));
  it('garbage NaN', () => assert(Number.isNaN(docker._parsePercent('??'))));
});

// --- default metrics inference ---

describe('[8] _defaultMetrics: filters by schema column type', () => {
  it('percent/bytes/rate pass through; string, meta, and (ambiguous) number excluded', () => {
    const schema = {
      columns: {
        cpu:      { type: 'percent' },
        mem:      { type: 'bytes' },
        rx:       { type: 'rate' },                 // counter-derived rate — graphable
        memLimit: { type: 'bytes', meta: true },   // scale ref, not graphable
        label:    { type: 'string' },
        ts:       { type: 'number' },               // metadata (timestamp) — NOT auto-graphed
      },
    };
    const ms = stats._defaultMetrics(schema);
    eq(ms, ['cpu', 'mem', 'rx'], 'rate included; string + meta + number excluded');
  });
  it('null schema → empty', () => eq(stats._defaultMetrics(null), []));
  it('schema without columns → empty', () => eq(stats._defaultMetrics({}), []));
});

// --- value formatters ---

describe('[9] _fmtPercent + _fmtBytes', () => {
  it('percent: one decimal', () => eq(stats._fmtPercent(3.2), '3.2%'));
  it('percent: NaN → em-dash', () => eq(stats._fmtPercent(NaN), '—'));
  it('bytes: KiB/MiB/GiB boundaries', () => {
    eq(stats._fmtBytes(512), '512B');
    eq(stats._fmtBytes(1536), '1.5KiB');
    eq(stats._fmtBytes(125 * 1024 * 1024), '125.0MiB');
    eq(stats._fmtBytes(2 * 1024 ** 3), '2.00GiB');
  });
  it('rate: bytes/sec (counter derivation)', () => {
    eq(stats._fmtRate(1536), '1.5KiB/s');
    eq(stats._fmtRate(125 * 1024 * 1024), '125.0MiB/s');
    eq(stats._fmtRate(NaN), '—');
  });
});

// --- hub round-trip on docker.stats topic ---

describe('[10] docker plugin defines docker.stats schema on init', () => {
  it('schema present after init', () => {
    hub._reset();
    docker.init({});
    const sch = hub.schema('docker.stats');
    assert(sch !== null, 'schema registered');
    eq(sch.rowKey, 'container_name');
    eq(sch.columns.cpu.type, 'percent');
    eq(sch.columns.mem.type, 'bytes');
  });
});

describe('[11] hub: docker.stats publish + history', () => {
  it('history returns published samples per container', () => {
    hub._reset();
    docker.init({});
    hub.subscribe('docker.stats', { window: 5 });
    for (let i = 0; i < 3; i++) {
      hub.publish('docker.stats', 'foo', { ts: i, cpu: 10 + i, mem: 100, memLimit: 1000 });
      hub.publish('docker.stats', 'bar', { ts: i, cpu: 50, mem: 500, memLimit: 1000 });
    }
    const fooHist = hub.history('docker.stats', 'foo', 10);
    eq(fooHist.length, 3, 'three samples for foo');
    eq(fooHist[0].cpu, 10, 'oldest first');
    eq(fooHist[2].cpu, 12, 'newest last');
    const barHist = hub.history('docker.stats', 'bar', 10);
    eq(barHist.length, 3, 'three samples for bar');
    barHist.forEach(s => eq(s.cpu, 50, 'bar always 50%'));
  });
});

describe('[12] hub: docker.stats window eviction', () => {
  it('publish past window → oldest dropped', () => {
    hub._reset();
    docker.init({});
    hub.subscribe('docker.stats', { window: 5 });
    for (let i = 0; i < 12; i++) {
      hub.publish('docker.stats', 'foo', { ts: i, cpu: i, mem: i, memLimit: 100 });
    }
    const h = hub.history('docker.stats', 'foo', 100);
    eq(h.length, 5, 'trimmed to window');
    eq(h[0].cpu, 7, 'oldest survivor is 12 - 5 = sample 7');
    eq(h[h.length - 1].cpu, 11, 'newest survives');
  });
});

describe('[13] hub: docker.stats delete clears row history', () => {
  it('delete removes a row but leaves siblings alone', () => {
    hub._reset();
    docker.init({});
    hub.subscribe('docker.stats', { window: 5 });
    hub.publish('docker.stats', 'foo', { ts: 1, cpu: 10, mem: 1, memLimit: 100 });
    hub.publish('docker.stats', 'bar', { ts: 1, cpu: 20, mem: 2, memLimit: 100 });
    hub.delete('docker.stats', 'foo');
    eq(hub.history('docker.stats', 'foo').length, 0, 'foo cleared');
    eq(hub.history('docker.stats', 'bar').length, 1, 'bar intact');
  });
});

// --- v0.6.4 Phase D — declared hub subscriptions wired at mount ---

describe('[14] stats declares its metrics-mirror subscription (pure)', () => {
  it('subscriptions(paneDef) projects a metrics-mirror descriptor; no topic → []', () => {
    // Pure function of the pane config — no side effects, no hub touch.
    // v0.6.6 Finding B — declares a `metrics-mirror` Sub (was a bare hub sub).
    eq(stats.subscriptions({ topic: 'docker.stats', window: 5 })[0].kind, 'metrics-mirror', 'metrics-mirror kind');
    eq(stats.subscriptions({ topic: 'docker.stats', window: 5 })[0].topic, 'docker.stats', 'topic carried');
    eq(stats.subscriptions({ topic: 'docker.stats', window: 5 })[0].window, 5, 'explicit window carried');
    eq(stats.subscriptions({ topic: 'docker.stats' })[0].window, 40, 'window defaults to 40 (matches render)');
    eq(stats.subscriptions({}).length, 0, 'no topic → no subscription');
    eq(stats.subscriptions(undefined).length, 0, 'no paneDef → no subscription');
  });

  it('two panes on one topic coalesce to ONE metrics-mirror at the MAX window', () => {
    // metrics-mirror keys by topic (it writes the single model.metrics[topic]
    // field), so two same-topic stats panes with different windows must merge,
    // not last-write-clobber — the wider-history pane would otherwise be starved.
    const state = require('../app/state');
    const out = new Map();
    state._addDesired(out, { kind: 'metrics-mirror', topic: 'docker.stats', window: 40, ms: 250 });
    state._addDesired(out, { kind: 'metrics-mirror', topic: 'docker.stats', window: 120, ms: 100 });
    eq(out.size, 1, 'same topic → one mirror, not two');
    const desc = [...out.values()][0].desc;
    eq(desc.window, 120, 'max window retained (not the last-written 40 if order flips)');
    eq(desc.ms, 100, 'tightest cadence retained');
    // Order-independent: adding the larger first still yields the max.
    const out2 = new Map();
    state._addDesired(out2, { kind: 'metrics-mirror', topic: 'docker.stats', window: 120 });
    state._addDesired(out2, { kind: 'metrics-mirror', topic: 'docker.stats', window: 40 });
    eq([...out2.values()][0].desc.window, 120, 'max window regardless of add order');
  });
});

describe('[15] framework reconciles declared subscriptions (Model → Sub, #D13)', () => {
  const state = require('../app/state');
  const api = require('../panel/api');
  const route = require('../panel/route');
  const layout = require('../panel/layout');
  const { getModel } = require('../model/store');

  // Place `panes` in the layout arrange so reconcileSubscriptions sees them
  // (the desired set is a pure projection of the placed panes). Registers the
  // 'layout' service slot (the arrange holder) + the 'stats' owner so the
  // reconciler resolves them via componentForPanel.
  function _place(panes) {
    api.registerComponent(layout);
    api.registerComponent(stats);
    const cur = api.serviceSlice('layout') || {};
    route.setInstanceSlice('layout', { ...cur, arrange: { columns: [{ panels: panes }] } });
  }
  const STATS_PANE = { type: 'stats', paneId: 'pane-stats', topic: 'docker.stats', window: 5 };

  it('a placed stats pane subscribes; removing it TEARS THE SUB DOWN', () => {
    hub._reset(); state._resetSubscriptions(); docker.init({});
    _place([STATS_PANE]);
    state.reconcileSubscriptions(getModel());
    hub.publish('docker.stats', 'foo', { ts: 1, cpu: 10, mem: 100, memLimit: 1000 });
    eq(hub.history('docker.stats', 'foo', 10).length, 1, 'placed → subscribed → sample retained (no render)');
    // Remove the pane and re-reconcile — the sub MUST be torn down (the leak
    // the old mount-time wiring left live). #D13 — Model→Sub start/stop.
    _place([]);
    state.reconcileSubscriptions(getModel());
    hub.publish('docker.stats', 'foo', { ts: 2, cpu: 12, mem: 100, memLimit: 1000 });
    eq(hub.history('docker.stats', 'foo', 10).length, 0, 'removed → unsubscribed → nothing retained (teardown)');
  });

  it('dedup: two stats panes on the same (topic, window) share ONE sub', () => {
    hub._reset(); state._resetSubscriptions(); docker.init({});
    _place([STATS_PANE, { ...STATS_PANE, paneId: 'pane-stats-2' }]);
    state.reconcileSubscriptions(getModel());
    // One ring buffer per topic regardless → publishing once yields exactly
    // one retained sample (no duplication from the second pane).
    hub.publish('docker.stats', 'foo', { ts: 1, cpu: 7, mem: 1, memLimit: 100 });
    eq(hub.history('docker.stats', 'foo', 10).length, 1, 'single sample retained');
  });

  it('a pane whose Component declares no subscriptions() is a no-op', () => {
    hub._reset(); state._resetSubscriptions(); docker.init({});
    _place([{ type: 'groups', paneId: 'pane-groups' }]);  // groups has no subscriptions hook
    state.reconcileSubscriptions(getModel());
    hub.publish('docker.stats', 'foo', { ts: 1, cpu: 1, mem: 1, memLimit: 1 });
    eq(hub.history('docker.stats', 'foo', 10).length, 0, 'nothing subscribed → nothing retained');
  });

  it('_desiredSubs is a pure projection: app-global resize + store mirrors + the placed stats pane', () => {
    _place([STATS_PANE]);
    const desired = state._desiredSubs(getModel());
    // App-global subs always desired: `resize` (FIX-3 Phase 2) + the three
    // `store-mirror`s (FIX-1: history / diag / jobs), plus the stats pane's
    // `metrics-mirror` (Finding B) → five.
    eq(desired.size, 5, 'resize + 3 store mirrors + one stats metrics-mirror');
    assert(desired.has('resize:resize'), 'app-global resize sub present (FIX-3 Phase 2)');
    assert(desired.has('store-mirror:history'), 'app-global history store-mirror present (FIX-1)');
    assert(desired.has('store-mirror:diag'), 'app-global diag store-mirror present (FIX-1)');
    assert(desired.has('store-mirror:jobs'), 'app-global jobs store-mirror present (FIX-1)');
    eq(desired.get('store-mirror:jobs').kind, 'store-mirror', 'tagged store-mirror');
    // Finding B — the stats pane's metrics-mirror, keyed by topic (not topic:window).
    assert(desired.has('metrics-mirror:docker.stats'), 'placed stats pane → metrics-mirror keyed by topic');
    eq(desired.get('metrics-mirror:docker.stats').kind, 'metrics-mirror', 'descriptor tagged with its kind');
  });
});

describe('[16] metrics_synced arm — hub series mirrored into model.metrics (Finding B)', () => {
  it('lands { series, schema } under model.metrics[topic] + emits a render Cmd', () => {
    const series = { foo: [{ ts: 1, cpu: 10 }, { ts: 2, cpu: 20 }] };
    const schema = { columns: { cpu: { type: 'percent' } } };
    const [m, cmds] = update({ metrics: {} }, { type: 'metrics_synced', topic: 'docker.stats', series, schema });
    eq(m.metrics['docker.stats'].series, series, 'series stored under the topic');
    eq(m.metrics['docker.stats'].schema, schema, 'schema stored under the topic');
    // The trailing metrics-mirror sample arrives via ctx.applyMsg (no implicit
    // repaint), so the arm must emit render or the graph never refreshes between
    // unrelated dispatches (v0.6.6 pre-release review regression fix).
    eq(cmds.length, 1, 'one Cmd'); eq(cmds[0].type, 'render', 'render Cmd repaints the graph');
  });

  it('merges topics — a new topic does not clobber others', () => {
    const base = { metrics: { 'a.x': { series: { r: [] }, schema: {} } } };
    const [m] = update(base, { type: 'metrics_synced', topic: 'b.y', series: { s: [] }, schema: {} });
    assert(m.metrics['a.x'], 'pre-existing topic preserved');
    assert(m.metrics['b.y'], 'new topic added');
  });
});

describe('[stats] aggregate — fold all rows into one synthetic series', () => {
  const schema = { columns: { pct: { type: 'percent' }, bytes: { type: 'bytes' }, name: { type: 'string' } } };
  const series = {
    core0: [{ pct: 20, bytes: 100, name: 'a' }, { pct: 40, bytes: 200, name: 'a' }],
    core1: [{ pct: 60, bytes: 300, name: 'b' }, { pct: 80, bytes: 400, name: 'b' }],
  };
  it('per-type default (true): percent → avg, bytes → sum; string skipped', () => {
    const out = stats._aggregateSamples(series, schema, 40, true);
    eq(out.length, 2);
    eq(out[0].pct, 40); eq(out[1].pct, 60);          // avg(20,60), avg(40,80)
    eq(out[0].bytes, 400); eq(out[1].bytes, 600);    // sum(100,300), sum(200,400)
    eq('name' in out[0], false, 'string column not aggregated');
  });
  it('explicit reducer applies to all columns', () => {
    eq(stats._aggregateSamples(series, schema, 40, 'sum')[0].pct, 80);   // sum(20,60)
    eq(stats._aggregateSamples(series, schema, 40, 'max')[0].pct, 60);   // max(20,60)
  });
  it('right-anchors a shorter (just-appeared) row to the most-recent end', () => {
    const s = { a: [{ pct: 10 }, { pct: 20 }], b: [{ pct: 90 }] };   // b has 1 sample
    const out = stats._aggregateSamples(s, { columns: { pct: { type: 'percent' } } }, 40, true);
    eq(out.length, 2);
    eq(out[0].pct, 10);   // only a at the older index
    eq(out[1].pct, 55);   // avg(20, 90) at the newest index — b aligned to the end
  });
  it('empty / no-row series → []', () => {
    eq(stats._aggregateSamples({}, schema, 40, true).length, 0);
  });
  it('full render() of an aggregate pane does not throw and shows the title', () => {
    // guards render()'s title/rowKey path — the scoping bug that a select_from /
    // aggregate pane hit (rowKey referenced outside its block) only surfaces on a
    // FULL render, which the rasterizer tests above never exercise.
    const { getModel } = require('../app/runtime');
    getModel().metrics = getModel().metrics || {};
    getModel().metrics['m.aggR'] = {
      schema: { columns: { pct: { type: 'percent' } } },
      series: { c0: [{ pct: 10 }, { pct: 20 }], c1: [{ pct: 30 }, { pct: 40 }] },
    };
    const out = stats.panelTypes.stats.render({ topic: 'm.aggR', aggregate: true, title: 'CPU', window: 40 }, 30, 8, {}, { focused: false });
    assert(typeof out === 'string' && out.includes('CPU'), `aggregate render produced a titled panel, got ${JSON.stringify(String(out).slice(0, 60))}`);
  });
});

report();
