/**
 * test-chrome-for.js — chromeFor pure projection + renderPanel
 * inline chrome composition (v0.6.3 P4.2a).
 *
 * chromeFor: pane state + context → {collapse, close, tabTrigger}.
 * renderPanel({chrome}): top border carries the glyphs inline; no
 * regex post-mutation. P4.2b wires composeRects to call chromeFor
 * + thread through; P4.2c retires injectTopRowChrome + injectTabTrigger.
 *
 * Run: node js/test/test-chrome-for.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { chromeFor } = require('../render/decor');
const { renderPanel } = require('../render/panel');
const { visibleLen, stripMarkup } = require('../io/ansi');

const pane = (extras = {}) => ({
  type: 'groups', id: 'groups', paneId: 'p-groups',
  hotkey: '1', title: 'Groups', columnIndex: 0,
  tabs: [{ id: 'groups', poolId: 'groups' }],
  ...extras,
});

// ---------- chromeFor projection ----------

describe('[1] chromeFor: non-detail pane defaults', () => {
  it('uncollapsed pane gets collapse=collapse, no close, [≡] always (D1 pane-select)', () => {
    const c = chromeFor(pane(), { freeConfigMode: false, dragging: false });
    eq(c.collapse, 'collapse');
    eq(c.close, null);
    // v0.6.3 D1 — non-detail [≡] is now the ALWAYS-visible pane-select
    // trigger (user's "like tabs, always there" choice); pre-D1 the
    // glyph only painted when pane.tabs.length >= 2.
    eq(c.tabTrigger, 'available', 'pane-select [≡] always present on non-detail');
  });
  it('collapsed pane gets collapse=expand (the [+] glyph)', () => {
    const c = chromeFor(pane({ collapsed: true }), { freeConfigMode: false, dragging: false });
    eq(c.collapse, 'expand');
  });
  it('free-config adds close', () => {
    const c = chromeFor(pane(), { freeConfigMode: true, dragging: false });
    eq(c.close, 'close');
    eq(c.collapse, 'collapse', 'collapse still present');
  });
});

describe('[2] chromeFor: detail pane', () => {
  it('detail never gets collapse or close (essential)', () => {
    const detail = { type: 'detail', tabs: [{ id: 'detail', poolId: 'detail' }] };
    const c = chromeFor(detail, { freeConfigMode: true, dragging: false, viewerTabCount: 5 });
    eq(c.collapse, null);
    eq(c.close, null, 'detail not closable even in free-config');
  });
  it('[≡] tracks viewer tab count, not pane.tabs.length', () => {
    const detail = { type: 'detail', tabs: [{ id: 'detail' }] };
    const c1 = chromeFor(detail, { viewerTabCount: 5 });
    eq(c1.tabTrigger, 'available', '5 tabs → [≡] shown');
    const c2 = chromeFor(detail, { viewerTabCount: 1 });
    eq(c2.tabTrigger, null, '1 tab → [≡] hidden');
    const c3 = chromeFor(detail, { viewerTabCount: 2 });
    eq(c3.tabTrigger, 'available', '2 tabs → [≡] shown');
  });
  it('[≡] state passes through (open/disabled/hidden)', () => {
    const detail = { type: 'detail', tabs: [{ id: 'detail' }] };
    eq(chromeFor(detail, { viewerTabCount: 3, tabTriggerState: 'open' }).tabTrigger, 'open');
    eq(chromeFor(detail, { viewerTabCount: 3, tabTriggerState: 'disabled' }).tabTrigger, 'disabled');
    eq(chromeFor(detail, { viewerTabCount: 3, tabTriggerState: 'hidden' }).tabTrigger, null);
  });
});

describe('[3] chromeFor: drag suppresses all chrome', () => {
  it('drag in flight → no collapse, no close, no [≡]', () => {
    const c = chromeFor(pane({ collapsed: true }), { freeConfigMode: true, dragging: true });
    eq(c.collapse, null);
    eq(c.close, null);
    eq(c.tabTrigger, null);
  });
});

describe('[4] chromeFor: non-detail [≡] = pane-select trigger (D1)', () => {
  // v0.6.3 D1 — non-detail [≡] is ALWAYS the pane-select trigger
  // regardless of pane.tabs.length; tab.length doesn't gate.
  it('singleton-tab pane still gets [≡] (was hidden pre-D1)', () => {
    const p = pane({ tabs: [{ id: 'a' }] });
    const c = chromeFor(p, { freeConfigMode: false });
    eq(c.tabTrigger, 'available');
  });
  it('multi-tab pane gets [≡] (unchanged)', () => {
    const p = pane({ tabs: [{ id: 'a' }, { id: 'b' }] });
    const c = chromeFor(p, { freeConfigMode: false });
    eq(c.tabTrigger, 'available');
  });
  it('paneSelectTriggerState passes through (available/open/disabled/hidden)', () => {
    const p = pane();
    eq(chromeFor(p, { paneSelectTriggerState: 'open' }).tabTrigger, 'open');
    eq(chromeFor(p, { paneSelectTriggerState: 'disabled' }).tabTrigger, 'disabled');
    eq(chromeFor(p, { paneSelectTriggerState: 'hidden' }).tabTrigger, null);
    eq(chromeFor(p, { paneSelectTriggerState: 'available' }).tabTrigger, 'available');
  });
});

// ---------- renderPanel inline chrome ----------

describe('[5] renderPanel with chrome opt: glyphs land in top border', () => {
  it('collapse-only on the right side', () => {
    const out = renderPanel({
      width: 30, height: 5, lines: ['hi'], title: 'Groups', hotkey: '1', focused: true,
      chrome: { collapse: 'collapse', close: null, tabTrigger: null },
    });
    const top = out.split('\n')[0];
    const plain = stripMarkup(top);
    // top should end with `[_]╮` visible cells
    assert(/\[_\]╮$/.test(plain), 'expected [_]╮ at end, got ' + JSON.stringify(plain.slice(-10)));
  });
  it('close + collapse on the right (free-config)', () => {
    const out = renderPanel({
      width: 40, height: 5, lines: ['hi'], title: 'Groups', hotkey: '1', focused: true,
      chrome: { collapse: 'collapse', close: 'close', tabTrigger: null },
    });
    const top = out.split('\n')[0];
    const plain = stripMarkup(top);
    assert(/\[X\]─\[_\]╮$/.test(plain), `expected close+collapse glyphs, got ${JSON.stringify(plain.slice(-15))}`);
  });
  it('tabTrigger after hotkey on the left', () => {
    const out = renderPanel({
      width: 30, height: 5, lines: ['hi'], title: 'Detail', hotkey: 'o', focused: true,
      chrome: { collapse: null, close: null, tabTrigger: 'available' },
    });
    const top = out.split('\n')[0];
    const plain = stripMarkup(top);
    assert(/^╭─\(o\)\[≡\]/.test(plain), `expected [≡] after (o), got ${JSON.stringify(plain.slice(0, 15))}`);
  });
  it('all three glyphs together', () => {
    const out = renderPanel({
      width: 40, height: 5, lines: ['hi'], title: 'Things', hotkey: '2', focused: true,
      chrome: { collapse: 'collapse', close: 'close', tabTrigger: 'available' },
    });
    const top = out.split('\n')[0];
    const plain = stripMarkup(top);
    assert(/^╭─\(2\)\[≡\]/.test(plain), 'left has [≡]');
    assert(/\[X\]─\[_\]╮$/.test(plain), 'right has [X]─[_]');
  });
  it('collapsed-expand uses [+] glyph instead of [_]', () => {
    const out = renderPanel({
      width: 30, height: 5, lines: [], title: 'X', hotkey: '1', focused: true,
      chrome: { collapse: 'expand', close: null, tabTrigger: null },
    });
    const top = out.split('\n')[0];
    const plain = stripMarkup(top);
    assert(/\[\+\]╮$/.test(plain), `expected [+] for expand, got ${JSON.stringify(plain.slice(-10))}`);
  });
});

describe('[6] renderPanel without chrome opt: pre-P4.2 path (bare border)', () => {
  it('top border has no chrome glyphs', () => {
    const out = renderPanel({
      width: 30, height: 5, lines: ['hi'], title: 'Groups', hotkey: '1', focused: true,
    });
    const top = out.split('\n')[0];
    const plain = stripMarkup(top);
    assert(!/\[_\]/.test(plain), `no [_] in bare border, got ${JSON.stringify(plain)}`);
    assert(!/\[≡\]/.test(plain), 'no [≡] in bare border');
    assert(top.includes('Groups'), 'title preserved');
  });
});

describe('[7] renderPanel: top border width is exactly width cells visible', () => {
  it('chrome opt → visible width matches', () => {
    const W = 40;
    const out = renderPanel({
      width: W, height: 5, lines: ['hi'], title: 'X', hotkey: '1', focused: true,
      chrome: { collapse: 'collapse', close: 'close', tabTrigger: 'available' },
    });
    const top = out.split('\n')[0];
    eq(visibleLen(top), W);
  });
  it('no chrome opt → visible width matches', () => {
    const out = renderPanel({
      width: 25, height: 5, lines: [], title: 'X', hotkey: '1', focused: true,
    });
    eq(visibleLen(out.split('\n')[0]), 25);
  });
});

report();
