/**
 * Pane chrome on the hit map — mouse (docs/mouse-hit-map.md Release 2).
 *
 *   [1] [_] collapses / [+] expands — raw SGR, published where it painted
 *   [2] [X] hides a pane in free-config; not published outside it
 *   [3] [≡] opens the pane menu (act, click-time seeding); open → toggles closed
 *   [4] a chrome-suppressing mode publishes no chrome
 *   [5] stale geometry: a batched key that moves panes swallows the click;
 *       a batched focus click does NOT stale the frame
 *   [6] double-click on a glyph = one toggle
 *   [7] slot tab strip: a tab click activates it; a truncated tab and a chain
 *       mode publish nothing
 *   [8] pre-release review regressions: Ctrl+\ (leave terminal) + a chrome
 *       click in one chunk; a body click batched behind the key that closed an
 *       in-grid popup; chrome pushed onto the footer row; a router-consumed press
 *       disarms a pending text selection
 *   [9] round-2 review: border-control specs without / with duplicate ids and a
 *       spec whose regions() throws (plugin contract); the free-config panel
 *       list owns its box (chrome under it is not clickable through it)
 *
 * Run: node js/test/test-chrome-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { EventEmitter } = require('events');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const hm = require('../panel/hit-map');
const input = require('../dispatch/control/input');
const mpool = require('../leaves/wm/pool');
const { getModel } = require('../app/runtime');
const api = sm.api;
const loop = require('../dispatch/runtime/loop');
const toLayout = (msg) => sm.capture(() => loop.dispatchMsg(api.wrap('layout', msg)));

const layout = () => api.getInstanceSlice('layout');
const panes = () => mpool.allPanesInColumns(layout().arrange);
const pane = (paneId) => panes().find(p => p.paneId === paneId);
const chrome = (id) => hm.all().filter(r => r.id === id && r.z === hm.BANDS.CHROME);
const sgr = (mx, my) => `\x1b[<0;${mx + 1};${my + 1}M`;

// two groups panes stacked in column 0, the content slot in column 1 —
// bootFresh takes the RESOLVED layout shape (it bypasses the parser).
const P = { groups: { id: 'groups', type: 'groups' }, groups2: { id: 'groups2', type: 'groups' }, detail: { id: 'detail', type: 'detail' } };
const LAYOUT = {
  pool: P,
  columns: [
    { width: 40, panels: [{ id: 'groups', type: 'groups' }, { id: 'groups2', type: 'groups' }] },
    { panels: [{ id: 'detail', type: 'detail' }] },
  ],
};
function boot() {
  sm.bootFresh({ layout: LAYOUT });
  toLayout({ type: 'view_set', mode: 'normal' });
  sm.resize(120, 30);
  hc.paint();
}
function chunk(bytes) {
  const stdin = new EventEmitter();
  const h = input._makeDataHandler(stdin);
  stdin.on('data', h);
  input._classifyPress(0, 250, 90, Date.now());
  sm.capture(() => h(bytes));
}

describe('[1] [_] / [+]', () => {
  it('[_] click collapses THAT pane; the region covers the painted glyph', () => {
    boot();
    const r = chrome('collapse')[0];
    assert(r, 'some pane published a collapse glyph');
    eq(hc.screenText(r.owner, 'collapse'), '[_]');
    hc.clickRegion(r.owner, 'collapse');
    eq(pane(r.owner).collapsed, true);
    hc.paint();
    eq(hc.screenText(r.owner, 'collapse'), '[+]', 'collapsed bar publishes [+]');
    hc.clickRegion(r.owner, 'collapse');
    eq(!!pane(r.owner).collapsed, false, 'expanded again');
  });
  it('the content slot (detail) carries no collapse glyph', () => {
    boot();
    const det = panes().find(p => p.type === 'detail' || p.role === 'content');
    assert(det, 'boot layout has a content slot');
    eq(hc.region(det.paneId, 'collapse'), null);
  });
});

describe('[2] [X] in free-config', () => {
  it('published only in free-config; a click hides that pane', () => {
    boot();
    eq(chrome('close').length, 0, 'normal mode: no [X]');
    sm.capture(() => sm.applyMsg({ type: 'mode_set', flag: 'freeConfigMode' }));
    hc.paint();
    const r = chrome('close').find(x => x.owner === 'pane-groups2');
    assert(r, 'free-config publishes [X] on groups2');
    eq(hc.screenText(r.owner, 'close'), '[X]');
    const id = pane(r.owner).id;
    hc.clickRegion(r.owner, 'close');
    assert(!panes().some(p => p.id === id), 'pane hidden from the arrange');
  });
});

describe('[3] [≡] trigger', () => {
  it('available → opens that pane\'s menu; open → the same glyph closes it', () => {
    boot();
    const r = chrome('trigger')[0];
    assert(r, 'some pane shows a [≡]');
    eq(hc.screenText(r.owner, 'trigger'), '[≡]');
    hc.clickRegion(r.owner, 'trigger');
    eq(getModel().modes.paneMenuMode, true);
    eq(layout().paneMenu.targetPaneId, r.owner);
    hc.paint();
    assert(hc.region(r.owner, 'trigger'), 'the open target keeps its glyph');
    const others = chrome('trigger').filter(x => x.owner !== r.owner);
    eq(others.length, 0, 'other triggers are disabled while one menu is open');
    hc.clickRegion(r.owner, 'trigger');
    eq(getModel().modes.paneMenuMode, false, 'toggled closed');
  });
});

describe('[4] chrome-suppressing mode', () => {
  it('free-config title edit (suppressChrome, no overlay) publishes no chrome', () => {
    boot();
    sm.capture(() => sm.applyMsg({ type: 'mode_set', flag: 'freeConfigMode' }));
    sm.capture(() => sm.applyMsg({ type: 'mode_set', flag: 'freeConfigTitleEditMode' }));
    hc.paint();
    eq(hm.all().filter(r => r.z === hm.BANDS.CHROME).length, 0);
  });
});

describe('[5] stale geometry', () => {
  it('`+` (view expand) + click on the old [_] → swallowed: nothing collapses', () => {
    boot();
    const r = chrome('collapse').find(x => x.rect.y > 0) || chrome('collapse')[0];
    const before = panes().map(p => !!p.collapsed).join();
    chunk('+' + sgr(r.rect.x + 1, r.rect.y));
    eq(layout().viewMode, 'half', 'the key ran');
    eq(panes().map(p => !!p.collapsed).join(), before, 'no pane collapsed');
  });
  it('a focus click + a chrome click in one chunk: the frame is NOT stale', () => {
    boot();
    toLayout({ type: 'focus_set', focus: 'pane-detail' });
    hc.paint();
    const r = hc.region('pane-groups', 'collapse');
    const b = require('../leaves/wm/geometry').visibleBoundsFor(layout(), 'pane-groups2');
    chunk(sgr(b.x + 2, b.y + 2) + sgr(r.rect.x + 1, r.rect.y));
    eq(layout().focus, 'pane-groups2', 'the body click focused (layout slice changed in-chunk)');
    eq(pane('pane-groups').collapsed, true, 'the chrome click still resolved');
  });
});

describe('[6] double-click', () => {
  it('a double-click on [_] toggles once', () => {
    boot();
    const r = chrome('collapse')[0];
    hc.dblclickRegion(r.owner, 'collapse');
    eq(pane(r.owner).collapsed, true, 'one toggle, not two');
  });
});

describe('[7] slot tab strip', () => {
  const tabs = () => hm.all().filter(r => r.owner === 'pane-detail' && r.id.startsWith('tab:'));
  it('each drawn tab publishes over its label; a click activates that tab', () => {
    boot();
    const ts = tabs();
    assert(ts.length >= 2, `the content slot shows ≥2 tabs (got ${ts.length})`);
    const other = ts.find(r => r.id !== `tab:${pane('pane-detail').activeTabId}`);
    const label = hc.screenText('pane-detail', other.id);
    assert(/^[A-Za-z]/.test(label) && !label.includes('─'), `region covers a label, got "${label}"`);
    hc.clickRegion('pane-detail', other.id);
    eq(pane('pane-detail').activeTabId, other.id.slice(4));
  });
  it('a tab cut by truncation publishes nothing; the survivors still do', () => {
    boot();
    const wide = tabs().length;
    sm.resize(52, 30);                         // narrow the content slot
    hc.paint();
    const narrow = tabs();
    assert(narrow.length < wide, `fewer tabs survive (${narrow.length} of ${wide})`);
    const rows = hc.screenRows();
    for (const r of narrow) {
      const text = (rows[r.rect.y] || []).slice(r.rect.x, r.rect.x + r.rect.w).join('');
      assert(!text.includes('…'), `a published tab is drawn intact ("${text}")`);
    }
  });
  it('no tab regions while a chain mode is active (tab clicks were never live there)', () => {
    boot();
    sm.capture(() => sm.applyMsg({ type: 'mode_set', flag: 'jobsMode' }));
    hc.paint();
    eq(tabs().length, 0);
  });
});

describe('[8] pre-release review regressions', () => {
  it('Ctrl+\\ (leave terminal mode) + a [_] click in one chunk collapses it', () => {
    boot();
    const r = hc.region('pane-groups2', 'collapse');
    sm.capture(() => sm.applyMsg({ type: 'terminal_enter' }));
    hc.paint();
    if (!getModel().modes.terminalMode) return;   // no PTY backend here → nothing to exercise
    assert(hc.region('pane-groups2', 'collapse'), 'chrome still publishes under terminal mode');
    chunk('\x1c' + sgr(r.rect.x + 1, r.rect.y));
    eq(getModel().modes.terminalMode, false, 'left terminal mode');
    eq(pane('pane-groups2').collapsed, true, 'the click collapsed it (not a body click)');
  });
  it('which-key cancelled by a key + a body click in one chunk: the click still focuses', () => {
    boot();
    toLayout({ type: 'focus_set', focus: 'pane-groups' });
    sm.capture(() => sm.applyMsg({ type: 'enter_prefix' }));
    hc.paint();
    const bd = hm.all().find(r => r.id === 'backdrop' && r.z === hm.BANDS.BELOW_CHROME);
    assert(bd && bd.invisible, 'the below-chrome backdrop is invisible to the stale rule');
    const b = require('../leaves/wm/geometry').visibleBoundsFor(layout(), 'pane-groups2');
    // `Z` (no binding under the leader) ends the chord; a bare Esc + CSI in one
    // chunk is ambiguous to the tokenizer.
    eq(layout().focus, 'pane-groups', 'precondition: focus elsewhere');
    chunk('Z' + sgr(b.x + 3, b.y + 2));
    eq(getModel().modes.prefixMode, false, 'chord ended');
    eq(layout().focus, 'pane-groups2', 'the body click focused, as before R2');
  });
  it('a pane pushed onto the footer row publishes nothing there', () => {
    const pool = {}, panels = [];
    for (let i = 0; i < 5; i++) { pool['g' + i] = { id: 'g' + i, type: 'groups' }; panels.push({ id: 'g' + i, type: 'groups' }); }
    sm.bootFresh({ layout: { pool, columns: [{ panels }] } });
    toLayout({ type: 'view_set', mode: 'normal' });
    sm.resize(60, 10);
    hc.paint();
    const availH = require('../leaves/wm/geometry').availRows(layout().dims);
    const below = hm.all().filter(r => r.rect.y + r.rect.h > availH && r.z < 1000);
    eq(below.map(r => `${r.owner}/${r.id}`), [], 'no pane region on or past the footer row');
    const before = panes().map(p => !!p.collapsed).join();
    hc.click(56, 9);
    eq(panes().map(p => !!p.collapsed).join(), before, 'a footer click collapses nothing');
  });
  it('a press the hit map consumes disarms a pending text selection', () => {
    boot();
    const psel = require('../panel/select-view');
    const b = require('../leaves/wm/geometry').visibleBoundsFor(layout(), 'pane-groups');
    const r = hc.region('pane-groups2', 'collapse');
    // press on the groups body (arms a selection), then — no release — a press
    // on groups2's [_] (router-consumed, no mode opens), then motion over the
    // groups body.
    chunk(`\x1b[<0;${b.x + 3};${b.y + 2}M` + sgr(r.rect.x + 1, r.rect.y) + `\x1b[<32;${b.x + 6};${b.y + 2}M`);
    eq(psel.selectionFor('pane-groups'), null, 'no selection began from the stale arm');
  });
});

describe('[9] round-2 review regressions', () => {
  // Plugin-style border controls: the spec contract is { render, regions,
  // dispatch } — `id` was never required (nor unique).
  const LOG = [];
  const spec = (label, id, opts = {}) => {
    const sp = {
      render: () => ({ text: label, visibleW: label.length }),
      regions: opts.throws ? () => { throw new Error('regions boom'); } : (x0, y, w) => [{ x0, x1: x0 + w - 1, y, action: 'go' }],
      dispatch: (action) => { LOG.push(`${label}:${action}`); return null; },
    };
    if (id !== undefined) sp.id = id;
    return sp;
  };
  const mkType = (specs) => ({
    borderControls: specs,
    render(panel, w, h, slice, opts) {
      const ctl = api.borderControlsFor({ paneId: panel.paneId, type: panel.type, focused: !!(opts && opts.focused), innerW: w - 2 }, getModel());
      return api.renderPanel({ width: w, height: h, lines: ['body'], title: 'RV', focused: !!(opts && opts.focused),
        chrome: opts && opts.chrome, topControls: ctl });
    },
  });
  api.registerComponent({
    name: 'r2plug', init: () => ({}), update: (m, sl) => sl,
    panelTypes: {
      rvnone: mkType([spec('AAA'), spec('BBB')]),
      rvdup: mkType([spec('CCC', 'x'), spec('DDD', 'x')]),
      rvthrow: mkType([spec('EEE', 'e', { throws: true }), spec('FFF', 'f')]),
    },
  });
  const bootType = (type) => {
    const P2 = { rv: { id: 'rv', type }, detail: { id: 'detail', type: 'detail' } };
    sm.bootFresh({ layout: { pool: P2, columns: [{ width: 50, panels: [P2.rv] }, { panels: [P2.detail] }] } });
    toLayout({ type: 'view_set', mode: 'normal' });
    sm.resize(120, 30);
    return hc.screenRows();
  };
  const cellOf = (rows, text) => {
    for (let y = 0; y < rows.length; y++) {
      const line = (rows[y] || []).join('');
      const x = line.indexOf(text);
      if (x >= 0) return { x: x + 1, y };
    }
    return null;
  };
  for (const [type, a, b] of [['rvnone', 'AAA', 'BBB'], ['rvdup', 'CCC', 'DDD']]) {
    it(`${type}: a click on each control dispatches THAT control (specs found by identity, not id)`, () => {
      const rows = bootType(type);
      for (const label of [a, b]) {
        const c = cellOf(rows, label);
        assert(c, `${label} painted`);
        LOG.length = 0;
        hc.click(c.x, c.y);
        eq(LOG, [`${label}:go`]);
      }
    });
  }
  it('a spec whose regions() throws loses only its own clicks — the pane still paints', () => {
    const rows = bootType('rvthrow');
    const screen = rows.map(r => (r || []).join('')).join('\n');
    assert(!screen.includes('render error'), 'no error block');
    assert(cellOf(rows, 'EEE') && cellOf(rows, 'FFF'), 'both controls painted');
    LOG.length = 0;
    const f = cellOf(rows, 'FFF');
    hc.click(f.x, f.y);
    eq(LOG, ['FFF:go'], 'the healthy control still works');
  });

  it('free-config: a click inside the panel list over a pane\'s [X] does not hide that pane', () => {
    // (titles: the panel list prints each pool entry's title — the parser always sets one)
    const P3 = { g1: { id: 'g1', type: 'groups', title: 'G1' }, g2: { id: 'g2', type: 'groups', title: 'G2' },
                 g3: { id: 'g3', type: 'groups', title: 'G3' }, detail: { id: 'detail', type: 'detail', title: 'Detail' } };
    sm.bootFresh({ layout: { pool: P3, columns: [{ width: 70, panels: [P3.g1, P3.g2, P3.g3] }, { panels: [P3.detail] }] } });
    toLayout({ type: 'view_set', mode: 'normal' });
    sm.resize(120, 30);
    toLayout({ type: 'free_config_enter' });
    if (!layout().panelList || !layout().panelList.open) toLayout({ type: 'panel_list_open', cursor: 0 });
    hc.paint();
    const box = hm.all().find(r => r.owner === 'panel-list' && r.id === 'box');
    assert(box, 'the panel list publishes its box');
    const covered = hm.all().find(r => r.id === 'close' && r.z === hm.BANDS.CHROME
      && r.rect.x >= box.rect.x && r.rect.x + r.rect.w <= box.rect.x + box.rect.w
      && r.rect.y >= box.rect.y && r.rect.y < box.rect.y + box.rect.h);
    assert(covered, 'some pane\'s [X] lies under the box');
    const before = panes().map(p => p.id).join();
    hc.click(covered.rect.x + 1, covered.rect.y);
    eq(panes().map(p => p.id).join(), before, 'no pane hidden');
    eq(getModel().modes.freeConfigMode, true, 'still in free-config (the legacy handler took the click)');
    toLayout({ type: 'free_config_exit' });
  });
});

report();
