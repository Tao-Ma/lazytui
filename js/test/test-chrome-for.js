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
  it('uncollapsed pane gets collapse=collapse, no close, [≡] passthrough', () => {
    const c = chromeFor(pane(), { freeConfigMode: false, dragging: false });
    eq(c.collapse, 'collapse');
    eq(c.close, null);
    // v0.6.4 #1 Step 2 — [≡] is the unified pane-menu trigger; chromeFor
    // surfaces ctx.paneMenuTriggerState verbatim (visibility decided
    // upstream in the render pass). Default (no ctx) = 'available'.
    eq(c.tabTrigger, 'available', 'pane-menu [≡] default available');
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
    const c = chromeFor(detail, { freeConfigMode: true, dragging: false, paneMenuTriggerState: 'available' });
    eq(c.collapse, null);
    eq(c.close, null, 'detail not closable even in free-config');
  });
  it('detail [≡] surfaces paneMenuTriggerState like any pane (no special tab-count gate)', () => {
    // v0.6.4 #1 Step 2 — the per-pane "has ≥2 tabs" visibility gate moved
    // UPSTREAM (paint.js paneMenuTriggerStateFor). chromeFor is a uniform
    // passthrough: 'hidden' → null, everything else → that state.
    const detail = { type: 'detail', tabs: [{ id: 'detail' }] };
    eq(chromeFor(detail, { paneMenuTriggerState: 'available' }).tabTrigger, 'available');
    eq(chromeFor(detail, { paneMenuTriggerState: 'hidden' }).tabTrigger, null);
  });
  it('[≡] state passes through (open/disabled/hidden)', () => {
    const detail = { type: 'detail', tabs: [{ id: 'detail' }] };
    eq(chromeFor(detail, { paneMenuTriggerState: 'open' }).tabTrigger, 'open');
    eq(chromeFor(detail, { paneMenuTriggerState: 'disabled' }).tabTrigger, 'disabled');
    eq(chromeFor(detail, { paneMenuTriggerState: 'hidden' }).tabTrigger, null);
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

describe('[4] chromeFor: every pane surfaces paneMenuTriggerState', () => {
  // v0.6.4 #1 Step 2 — the [≡] glyph is the unified pane-menu trigger on
  // every pane; chromeFor is a dumb passthrough of ctx.paneMenuTriggerState
  // (the render pass decides per-pane visibility / open / disabled).
  it('default (no ctx) = available', () => {
    const c = chromeFor(pane(), { freeConfigMode: false });
    eq(c.tabTrigger, 'available');
  });
  it('paneMenuTriggerState passes through (available/open/disabled/hidden)', () => {
    const p = pane();
    eq(chromeFor(p, { paneMenuTriggerState: 'open' }).tabTrigger, 'open');
    eq(chromeFor(p, { paneMenuTriggerState: 'disabled' }).tabTrigger, 'disabled');
    eq(chromeFor(p, { paneMenuTriggerState: 'hidden' }).tabTrigger, null);
    eq(chromeFor(p, { paneMenuTriggerState: 'available' }).tabTrigger, 'available');
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
