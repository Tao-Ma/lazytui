/**
 * Smoke — stats pane end-to-end (truecolor arc Phase 2, docs/truecolor.md).
 *
 * Drives the REAL pipeline: a stats pane placed next to containers,
 * series injected via the metrics_synced Msg (the metrics-mirror arm),
 * frame captured off the actual render path. Asserts the Phase-2 payoff
 * end-to-end:
 *   - braille graph glyphs + the percent meter row reach the frame;
 *   - gradient color arrives as canonical truecolor bytes (38;2) at
 *     truecolor depth;
 *   - the SAME frame re-rendered at depth 16 carries NO 38;2 — the
 *     write-boundary downgrade (P3) proven on real output, not just on
 *     the quantize leaf.
 *
 * Run: node js/scripts/run-smoke.js stats-graph   (or directly)
 */
'use strict';

const sm = require('./_helpers/smoke');
const api = sm.api;
const paint = require('../../render/paint');
const { describe, it, assert, eq, report } = require('../test-runner');

// containers + stats aren't in the test-runner auto-set (layout/detail/groups);
// info/text-view back the content-slot mint (same list as the routing smoke).
for (const [modPath, name] of [
  ['../../panel/navigator/docker', 'containers'],
  ['../../panel/monitor/stats', 'stats'],
  ['../../panel/info/info', 'info'],
  ['../../panel/text-view/text-view', 'text-view'],
]) {
  if (!api.getComponent(name)) api.registerComponent(require(modPath));
}

sm.bootFresh({
  groups: {
    g1: {
      name: 'g1', label: 'Group 1',
      containers: ['c1'],
      actions: {},
      children: [], parent: null, depth: 0, quick: false,
    },
  },
  // bootFresh bypasses the parser, so the layout is the RESOLVED shape
  // (pane objects; per-pane config spreads onto the runtime pane).
  layout: {
    columns: [
      { width: 40, panels: [{ id: 'containers', type: 'containers' }] },
      {
        panels: [
          {
            id: 'stats', type: 'stats', title: 'Stats',
            config: { topic: 'smoke.stats', select_from: 'containers', metrics: ['cpu'], window: 40 },
          },
          { id: 'detail', type: 'detail' },
        ],
      },
    ],
  },
});
sm.resize(120, 40);

// Full-frame reads (cell-diff emits sparse frames after the first paint).
const frame = () => { paint.forceFullRepaint(); return sm.capture(() => sm.render()); };

// The focused containers row IS the series key (production: docker.stats
// keyed by container name).
const rowKey = api.getItems('containers')[0];

// A 0→95% ramp so the gradient spans the whole cool→hot range and the
// meter lands part-filled.
const samples = Array.from({ length: 40 }, (_, i) => ({ cpu: i * (95 / 39) }));
sm.applyMsg({
  type: 'metrics_synced',
  topic: 'smoke.stats',
  series: { [rowKey]: samples },
  schema: { columns: { cpu: { type: 'percent' } } },
});

describe('stats smoke — braille + gradient + meter reach the real frame', () => {
  paint.setColorDepth('truecolor');
  const tc = frame();

  it('series key matches the focused containers row', () => {
    assert(typeof rowKey === 'string' && rowKey.length > 0, `rowKey: ${JSON.stringify(rowKey)}`);
  });
  it('CPU header renders with current/peak/avg', () => {
    assert(/CPU/.test(tc.frame), 'CPU label');
    assert(/peak/.test(tc.frame) && /avg/.test(tc.frame), 'stats annotations');
  });
  it('graph rows are braille (default style, no graph: key)', () => {
    assert(/[⡀-⣿]/.test(tc.frame), 'braille glyphs in the frame');
  });
  it('percent meter row present (block fill)', () => {
    assert(/[█▏▎▍▌▋▊▉]/.test(tc.frame), 'eighth-block meter fill');
  });
  it('gradient arrives as canonical truecolor bytes at truecolor depth', () => {
    assert(/\x1b\[[0-9;]*38;2;\d+;\d+;\d+/.test(tc.raw), '38;2 SGR in raw frame');
  });
});

describe('stats smoke — write-boundary downgrade (P3) on real output', () => {
  paint.setColorDepth('16');
  const lo = frame();
  paint.setColorDepth('truecolor');

  it('no 38;2 escapes at depth 16', () => {
    // This assertion caught a REAL bypass on its first run: footer.js wrote
    // stdout directly, skipping paint's depth funnel — invisible while the
    // footer was 16-color, a leak the moment it became a hex pair (3b).
    assert(!/38;2;/.test(lo.raw), 'truecolor quantized away');
  });
  it('quantized base-16 colors present instead', () => {
    assert(/\x1b\[[0-9;]*(3[0-7]|9[0-7])[;m]/.test(lo.raw), 'base-16 SGR colors in frame');
  });
  it('the visible text is identical at both depths (frame is depth-free)', () => {
    const tc2 = frame();
    eq(lo.frame, tc2.frame, 'stripped frames match');
  });
});

describe('stats smoke — self-writing overlays go through the depth funnel too', () => {
  // Pre-release review HIGH: cmdline + pane-menu composed their own screen
  // bytes and wrote io/term stdout DIRECTLY, bypassing paint's _emit — raw
  // 38;2 leaked at legacy depths the moment their slots went hex (the same
  // class as the footer bypass this file caught earlier). Both now route
  // through draw.writeOut → the injected depth funnel. Pin the cmdline path
  // (the pane-menu shares the writer).
  paint.setColorDepth('16');
  const cap = sm.capture(() => sm.handleKey(':', ':'));
  const esc16 = sm.capture(() => sm.handleKey('escape', '\x1b'));
  paint.setColorDepth('truecolor');

  it('cmdline overlay painted, with zero 38;2 at depth 16', () => {
    assert(/\x1b\[/.test(cap.raw), 'cmdline emitted bytes');
    assert(!/38;2;/.test(cap.raw + esc16.raw), 'overlay bytes quantized');
  });
});

report();
