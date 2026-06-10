/**
 * v0.6 — placement.collapsed feature, all-mode toggle.
 *
 * Covers:
 *   - reducer: panel_collapse_toggle flips collapsed, refuses detail
 *   - distributeColumnHeights: collapsed reserves 1 row, remainder
 *     splits across non-collapsed peers; slack-row rule parks
 *     leftovers on the last NON-collapsed panel
 *   - YAML round-trip: collapsed:true survives serialize, parser
 *     accepts it on placement and rejects it on pool entry
 *
 *   node js/test/test-collapse.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const layout = require('../panel/layout');

// --- Tiny slice builder (mirrors test-pool-cmdline.js's helper) ---
function buildSlice({ left = [], right = [], detailHeightPct = 60 } = {}) {
  const pool = {};
  const mkPlacement = (id, type, hotkey, columnIndex, extra) =>
    Object.assign({ id, type, title: id, hotkey, columnIndex }, extra || {});
  const leftPanels = left.map(([id, type, extra], i) => {
    pool[id] = { id, type, title: id, config: {} };
    return mkPlacement(id, type, String(i + 1), 0, extra);
  });
  const RIGHT_KEYS = ['7', '8', '9'];
  const rightPanels = right.map(([id, type, extra], i) => {
    pool[id] = { id, type, title: id, config: {} };
    return mkPlacement(id, type, RIGHT_KEYS[i], 1, extra);
  });
  return {
    ...layout.init(),
    arrange: {
      detailHeightPct,
      pool,
      columns: [
        { width: 30, panels: leftPanels },
        { panels: rightPanels },
      ],
    },
  };
}

// --- Section 1: reducer ---
describe('[panel_collapse_toggle] reducer', () => {
  it('flips a left-panel placement', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups'], ['files', 'files']],
      right: [['detail', 'detail']],
    });
    const next = layout.update({ type: 'panel_collapse_toggle', id: 'files' }, slice);
    assert(next !== slice, 'returns new slice');
    eq(next.arrange.columns[0].panels[0].collapsed, undefined, 'untouched panel untouched');
    eq(next.arrange.columns[0].panels[1].collapsed, true, 'targeted panel flipped');
    assert(next.dirty, 'marked dirty for :save-layout');
  });
  it('un-collapses on second toggle', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups', { collapsed: true }]],
      right: [['detail', 'detail']],
    });
    const next = layout.update({ type: 'panel_collapse_toggle', id: 'groups' }, slice);
    eq(next.arrange.columns[0].panels[0].collapsed, false);
  });
  it('refuses to collapse detail', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['detail', 'detail']],
    });
    const next = layout.update({ type: 'panel_collapse_toggle', id: 'detail' }, slice);
    eq(next, slice, 'same slice ref — refused');
  });
  it('no-op on unknown id', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['detail', 'detail']],
    });
    const next = layout.update({ type: 'panel_collapse_toggle', id: 'ghost' }, slice);
    eq(next, slice);
  });
  it('right-column placement also flips', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = layout.update({ type: 'panel_collapse_toggle', id: 'actions' }, slice);
    eq(next.arrange.columns[1].panels[0].collapsed, true);
    eq(next.arrange.columns[1].panels[1].collapsed, undefined, 'detail untouched');
  });
});

// --- Section 2: render-side distribution (test seam: _distributeColumnHeights) ---
describe('[distributeColumnHeights] honors collapsed = 1 row', () => {
  const { _distributeColumnHeights } = require('../render/geometry');

  function run(panels, availH, isLastCol = false) {
    // _distributeColumnHeights is now a pure function: takes panels +
    // settings, returns a `{ [type]: rows }` map. (Was: wrote into a
    // slice's panelHeights field.)
    return _distributeColumnHeights(panels, availH, isLastCol, /*minH*/ 3, /*detailHeightPct*/ 60);
  }

  it('collapsed panel gets h=1; sibling absorbs the rest', () => {
    const panels = [
      { type: 'groups', id: 'groups', columnIndex: 0 },
      { type: 'files',  id: 'files',  columnIndex: 0, collapsed: true },
    ];
    const h = run(panels, 22, false);
    eq(h.files, 1, 'collapsed = 1 row');
    eq(h.groups, 21, 'flex sibling gets 22 - 1 = 21');
  });

  it('two collapsed siblings, one flex', () => {
    const panels = [
      { type: 'a', id: 'a', columnIndex: 0, collapsed: true },
      { type: 'b', id: 'b', columnIndex: 0 },
      { type: 'c', id: 'c', columnIndex: 0, collapsed: true },
    ];
    const h = run(panels, 22, false);
    eq(h.a, 1);
    eq(h.c, 1);
    eq(h.b, 20, 'middle flex absorbs 22 - 1 - 1 = 20');
  });

  it('slack rows park on the last non-collapsed panel', () => {
    // Two flex panels, one collapsed-LAST. Slack must NOT grow the
    // collapsed one (it's locked at h=1).
    const panels = [
      { type: 'a', id: 'a', columnIndex: 0 },
      { type: 'b', id: 'b', columnIndex: 0 },
      { type: 'c', id: 'c', columnIndex: 0, collapsed: true },
    ];
    // availH = 21 → innerAvail = 20 → flex 20/2 = 10 each. Sum a+b+c =
    // 10 + 10 + 1 = 21. No slack here — pick a non-divisible H instead.
    const h = run(panels, 22, false);
    // innerAvail = 21; flex 21/2 = 10 floor; last flex gets 21 - 10 = 11.
    eq(h.a, 10);
    eq(h.b, 11);
    eq(h.c, 1);
  });

  it('collapsed panel WITH detail in right column', () => {
    // Right column with detail (60% reserve) and one collapsed sibling.
    const panels = [
      { type: 'actions', id: 'actions', columnIndex: 1, collapsed: true },
      { type: 'detail',  id: 'detail',  columnIndex: 1 },
    ];
    const h = run(panels, 22, /*isRight*/ true);
    eq(h.actions, 1, 'collapsed at 1');
    // innerAvail = 22 - 1 = 21; reserved = floor(21 * 0.6) = 12; flex=0.
    // Sum = 1 + 12 = 13; slack 9 → parked on last non-collapsed = detail.
    eq(h.detail, 21, 'detail = 12 reserved + 9 slack');
  });

  it('detail is never collapsed even if flag sneaks in', () => {
    // distributeColumnHeights doesn't gate detail at all — the reducer
    // is the gatekeeper. So if a malformed placement carries
    // collapsed:true on detail, the math still must not crash. We assert
    // the renderer-side behavior (detail wins detail-reserve), since the
    // reducer-level no-op covers the actual user path.
    const panels = [
      { type: 'detail', id: 'detail', columnIndex: 1, collapsed: true },
    ];
    const h = run(panels, 22, true);
    // The current behavior: collapsed branch fires first (h=1), then
    // detail branch runs against innerAvail = 21 and overwrites with
    // reserved. End state: detail = max(minH, floor(21 * 0.6)) = 12 +
    // slack 10 → 22. Asserting just that nothing throws and detail is
    // a positive number — exact value follows from the math but isn't
    // the contract.
    assert(h.detail > 1, `detail honored, not collapsed (got ${h.detail})`);
  });
});

// --- Section 3: YAML serializer ---
describe('[yaml-layout] collapsed serialization', () => {
  const yaml = require('../feature/yaml-layout');

  it('serializeLayoutCell emits collapsed: true (mapping form)', () => {
    const lines = yaml.serializeLayoutCell(
      { id: 'files', type: 'files', columnIndex: 0, collapsed: true },
      8, {});
    const joined = lines.join('\n');
    assert(joined.includes('collapsed: true'), `got: ${joined}`);
    assert(joined.includes('tabs: [files]'),   `got: ${joined}`);
  });

  it('does NOT emit collapsed when absent (bare-string cell)', () => {
    const lines = yaml.serializeLayoutCell(
      { id: 'files', type: 'files', columnIndex: 0 },
      8, {});
    const joined = lines.join('\n');
    assert(!joined.includes('collapsed'), `got: ${joined}`);
    eq(lines.length, 1, 'bare pool-ref form');
  });

  it('does NOT emit collapsed: false (bare-string cell)', () => {
    const lines = yaml.serializeLayoutCell(
      { id: 'files', type: 'files', columnIndex: 0, collapsed: false },
      8, {});
    const joined = lines.join('\n');
    assert(!joined.includes('collapsed'), `got: ${joined}`);
    eq(lines.length, 1, 'collapsed:false suppressed; bare form used');
  });
});

// --- Section 4: parser round-trip ---
describe('[parser] PLACEMENT_ONLY_KEYS accepts collapsed', () => {
  const parser = require('../parser/index');

  function writeTmp(content) {
    const p = path.join(os.tmpdir(), `lazytui-collapse-${process.pid}-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(p, content);
    return p;
  }

  it('parses collapsed:true on a layout cell, lifts onto the placement', () => {
    const p = writeTmp(`
panels:
  files:
    type: files
  detail:
    type: detail
layout:
  columns:
    - width: 30
      panels:
        - { tabs: [files], collapsed: true }
    - panels:
        - detail
groups:
  g1:
    label: G1
    actions:
      a:
        label: A
        script: 'echo a'
`.trim());
    try {
      const cfg = parser.parse(p);
      const files = cfg.layout.columns[0].panels.find(x => x.id === 'files');
      assert(files, 'files placed');
      eq(files.collapsed, true, 'collapsed lifted onto placement');
    } finally { fs.unlinkSync(p); }
  });

  it('parser rejects collapsed: true on detail placement', () => {
    const p = writeTmp(`
panels:
  files:
    type: files
  detail:
    type: detail
layout:
  columns:
    - width: 30
      panels:
        - files
    - panels:
        - { tabs: [detail], collapsed: true }
groups:
  g1:
    label: G1
    actions:
      a:
        label: A
        script: 'echo a'
`.trim());
    let threw = null;
    try { parser.parse(p); } catch (e) { threw = e; }
    fs.unlinkSync(p);
    assert(threw, 'should reject collapsed on detail');
    assert(/detail.*collapsed|collapsed.*detail/i.test(threw.message), `got: ${threw && threw.message}`);
  });

  it('parser rejects collapsed in a pool entry (placement-only)', () => {
    const p = writeTmp(`
panels:
  files:
    type: files
    collapsed: true
  detail:
    type: detail
layout:
  columns:
    - width: 30
      panels:
        - files
    - panels:
        - detail
groups:
  g1:
    label: G1
    actions:
      a:
        label: A
        script: 'echo a'
`.trim());
    let threw = null;
    try { parser.parse(p); } catch (e) { threw = e; }
    fs.unlinkSync(p);
    assert(threw, 'should reject placement-only key on pool entry');
    assert(/collapsed.*placement/i.test(threw.message), `got: ${threw && threw.message}`);
  });
});

report();
