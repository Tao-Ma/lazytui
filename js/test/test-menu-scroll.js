/**
 * Regression: a menu (right-click context menu / port picker) with MORE items
 * than fit on screen must scroll to keep the selected row visible — before this,
 * only the first screenful rendered and the cursor drove off-screen with no way
 * to see or reach the rest.
 *
 * Verified for real: replay the render bytes into @xterm/headless (async write,
 * awaited) and read the screen. Run: node js/test/test-menu-scroll.js
 */
'use strict';

process.stdout.columns = 80; process.stdout.rows = 24;   // 24 rows → ~20 visible menu rows

const { describe, it, assert, eq, report } = require('./test-runner');   // auto-wires panel-host
const { Terminal } = require('@xterm/headless');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const { applyMsg } = require('../dispatch/control/dispatch');
const { render } = require('../render/paint');
const { hitTest } = require('../overlay/menu');
const { overlayBox } = require('../leaves/render/draw');

const _grp = (name, label) => ({
  name, label, containers: [],
  actions: { a1: { key: 'a1', label: 'A', type: 'run', script: 'echo', tab: false } },
  children: [], parent: null, depth: 0, quick: false,
});
getModel().config = {
  project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
  groups: { g1: _grp('g1', 'Group 1') },
};
initState();
getModel().projectDir = '.';

const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
function paint() {
  const c = [];
  const o = process.stdout.write;
  process.stdout.write = (s) => { c.push(String(s)); return true; };
  try { render(getModel()); } finally { process.stdout.write = o; }
  return new Promise((res) => term.write(c.join(''), res));
}
function screen() {
  const b = term.buffer.active;
  const out = [];
  for (let y = 0; y < term.rows; y++) { const ln = b.getLine(y); out.push(ln ? ln.translateToString(true) : ''); }
  return out.join('\n');
}
const N = 40;
const items = Array.from({ length: N }, (_, i) => [`ITEM_${String(i).padStart(2, '0')}`, 'noop', null]);
const countVisible = (s) => items.filter((it) => s.includes(it[0])).length;

(async () => {
  await paint();                                              // base
  applyMsg({ type: 'menu_open', items, anchor: null });       // 40 items, taller than the screen
  await paint();
  const atTop = screen();
  // Navigate the cursor to the LAST item; the window should scroll to it.
  for (let i = 0; i < N - 1; i++) applyMsg({ type: 'menu_nav', dir: +1 });
  await paint();
  const atEnd = screen();

  describe('[menu-scroll] a menu taller than the screen scrolls with the cursor', () => {
    it('windows the list (not all 40 items at once)', () => {
      assert(countVisible(atTop) > 0 && countVisible(atTop) < N, `showed ${countVisible(atTop)} of ${N}`);
      assert(atTop.includes('ITEM_00'), 'first item visible at the top');
    });
    it('scrolls the last item into view when the cursor reaches it', () => {
      assert(getModel().modal.menu.idx === N - 1, 'cursor is on the last item');
      assert(atEnd.includes('ITEM_39'), 'the selected last item is on screen (was off-screen before)');
      assert(!atEnd.includes('ITEM_00'), 'the top item scrolled out of view');
    });
    it('a click on a scrolled menu maps to the visible row, not an off-screen item', () => {
      // Still scrolled to the end (window shows the last screenful). hitTest must
      // reject border clicks BEFORE applying scroll, else the top border activates
      // an off-screen item (silent wrong-port inject in the picker).
      const { offX, offY, menuH } = overlayBox({ linesLen: N, anchor: null, maxWidth: 44 });
      const mx = offX + 2;
      const innerH = menuH - 2;
      // mirror menuScroll (centered, clamped) for idx = last item
      const scroll = Math.max(0, Math.min((N - 1) - Math.floor(innerH / 2), N - innerH));
      eq(hitTest(mx, offY).itemIdx, null, 'top border click is a no-op (not an off-screen item)');
      eq(hitTest(mx, offY + menuH - 1).itemIdx, null, 'bottom border click is a no-op');
      eq(hitTest(mx, offY + 1).itemIdx, scroll, 'first visible content row maps to the scrolled item');
    });
  });
  report();
})();
