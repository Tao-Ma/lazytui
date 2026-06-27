/**
 * Phase 2 (v0.6.7) — view-construction cost: the gate for A1 (per-panel render
 * memo) and A3 (window-only decoration).
 *
 * There is no other bench for construction cost (bench-hotpaths = reducer,
 * bench-cell-diff = wire). This one measures, through the REAL render path:
 *
 *   [A3] viewer decoration cost — full-buffer vs visible-window — at scale, AND
 *        confirms the no-search/no-selection path is already O(1) passthrough
 *        (so A3 only helps the large-buffer + active-search/selection case).
 *   [A3-append] matchesFor recompute cost (the append-while-search concern).
 *   [A1] full render(model) per frame at realistic vs stress scale (the ceiling
 *        A1 could save by skipping unchanged panels).
 *
 * Decision rules are printed at the end. Run:
 *   node js/test/bench-render-construction.js
 */
'use strict';

const path = require('path');

// Boot the real pipeline FIRST (test-runner wires the panel host + base
// components; initState builds the route table) so resolveTarget()/_slice() are
// memoized-cheap — otherwise pre-boot route churn dominates the decorate timings.
require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const search = require('../panel/viewer/search');
const matches = require('../leaves/text/search');
const { parse } = require('../parser/index');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const { render } = require('../render/paint');
const api = sm.api;

const DEMO = path.join(__dirname, '..', '..', 'demo', 'dual-viewer', 'tui.yml');
if (!api.getInstanceSlice('files')) {
  try { api.registerComponent(require('../panel/navigator/files')); } catch (_) {}
}
const cfg = parse(DEMO);
getModel().config = cfg;
getModel().projectDir = cfg.project_dir;
initState();
sm.resize(120, 48);

const layout = api.getInstanceSlice('layout');
const viewers = [];
for (const col of layout.arrange.columns || [])
  for (const p of col.panels || []) if (p && p.type === 'detail' && p.paneId) viewers.push(p.paneId);
const V = viewers[0];
function setContent(lines) { api.dispatchMsg(api.wrap(V, { type: 'viewer_set_content', lines })); }
function focus(id) { api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: id })); }
focus(V);

// --- content generator (mirrors bench-cell-diff doc-shape: plain/CJK/emoji) ---
function doc(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    if (i % 7 === 0) out.push(`行 ${i} 宽字符 CJK 全角テスト fox ${i}`);
    else if (i % 11 === 0) out.push(`${i} 🚀 emoji ✓ ★ fox mix ${i}`);
    else out.push(`line ${i}: the quick brown fox jumps over the lazy dog ${i}`);
  }
  return out;
}

function timeOps(fn, iters) {
  for (let i = 0; i < Math.min(500, iters); i++) fn();   // warmup
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ops: Math.round(iters / (ms / 1000)), usPer: (ms * 1000) / iters };
}
const itersFor = (n, budget) => Math.max(20, Math.min(20000, Math.round(budget / n)));
// render() writes frames to stdout; keep our results on stderr so they're
// separable (run with stdout → /dev/null to discard the painted frames).
const log = (s) => process.stderr.write(s + '\n');

const INNER_H = 38;
const SCALES = [200, 2000, 10000, 50000];

log('Phase 2 view-construction bench — render is 50ms-debounced (≤20fps; ~50ms/frame budget)\n');

// =====================================================================
// [A3] decoration cost: full buffer vs visible window
// =====================================================================
log('[A3] search decoration cost — full buffer vs visible window (innerH=' + INNER_H + ')');
log('     term "fox" matches ~every line. select.decorateLines has the same O(N) .map shape.\n');

for (const n of SCALES) {
  const lines = doc(n);
  const start = Math.floor(n / 2);
  const window = lines.slice(start, start + INNER_H);
  const activeSlice = { search: { active: true, term: 'fox', idx: 0 } };
  const noSlice = { search: { active: false, term: '', idx: 0 } };

  const passOps = timeOps(() => search.decorateLines(lines, noSlice), 20000);
  const fullOps = timeOps(() => search.decorateLines(lines, activeSlice), itersFor(n, 8e5));
  const winOps = timeOps(() => search.decorateLines(window, activeSlice), 20000);

  const speedup = (winOps.usPer > 0 ? fullOps.usPer / winOps.usPer : 0);
  log(`  n=${String(n).padStart(6)}  no-search(passthru) ${passOps.usPer.toFixed(2)}µs   ` +
      `active full ${fullOps.usPer.toFixed(2)}µs   active window ${winOps.usPer.toFixed(2)}µs   ` +
      `→ window ${speedup.toFixed(1)}× faster`);
}

// =====================================================================
// [A3-append] matchesFor recompute (append-while-search): cold vs memoized
// =====================================================================
log('\n[A3-append] matchesFor over the full buffer — cold (new array each call = every append)');
log('            vs warm (memoized = pure scroll). Stage 3 only matters if cold dominates.\n');
for (const n of [2000, 10000, 50000]) {
  const base = doc(n);
  const coldOps = timeOps(() => matches.matchesFor(base.slice(), 'fox'), itersFor(n, 5e5));
  const warmOps = timeOps(() => matches.matchesFor(base, 'fox'), 200000);
  log(`  n=${String(n).padStart(6)}  cold ${coldOps.usPer.toFixed(2)}µs/scan   warm ${warmOps.usPer.toFixed(3)}µs (memo hit)`);
}

// =====================================================================
// [A1] full render(model) per frame — realistic vs stress
// =====================================================================
log('\n[A1] full render(model) per frame (the ceiling a per-panel memo could save)\n');

setContent(doc(300));
const rRealistic = timeOps(() => render(getModel()), 2000);
log(`  realistic (3 panes, 300-line viewer, no search):   ${rRealistic.usPer.toFixed(1)}µs/frame  (${rRealistic.ops.toLocaleString()} fps-equiv)`);

setContent(doc(50000));
const rStress = timeOps(() => render(getModel()), 500);
log(`  stress (3 panes, 50k-line viewer, no search):      ${rStress.usPer.toFixed(1)}µs/frame  (${rStress.ops.toLocaleString()} fps-equiv)`);

// stress + active search: set search state directly on the instance slice.
const vs = api.getInstanceSlice(V);
api.setInstanceSlice(V, { ...vs, search: { active: true, term: 'fox', idx: 0, typing: '' } });
const rStressSearch = timeOps(() => render(getModel()), 20);
log(`  stress (50k viewer, ACTIVE search "fox"):          ${rStressSearch.usPer.toFixed(1)}µs/frame  (${rStressSearch.ops.toLocaleString()} fps-equiv)`);

log('\n--- decision read ---');
log('  A3: worth it iff "active full vs window" gap is large at 10k/50k AND stress+search');
log('      render is a meaningful fraction of ~50ms. (no-search decorate is already O(1).)');
log('  A1: worth it iff a full frame is a meaningful fraction of ~50ms AND grows with panes.');
