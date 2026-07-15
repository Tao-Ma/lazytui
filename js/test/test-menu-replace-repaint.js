/**
 * Regression: a menu replaced IN PLACE — the right-click context menu opening
 * its "Send selection to port…" port picker — must not leave the first menu's
 * pixels ghosting on screen.
 *
 * The menu overlay is stamped ON TOP of the cell-diffed base frame each paint;
 * the base diff can't clear a MOVED overlay (the base under the old position
 * didn't change), so only a full repaint wipes it. A menu→menu swap keeps the
 * `menuOpen` flag set, so the overlay-drop force-full check misses it — paint.js
 * forces a full repaint when the menu items array is swapped while open.
 *
 * Verified for real: replay the render bytes into @xterm/headless (its write is
 * async — awaited) and read the screen. Run: node js/test/test-menu-replace-repaint.js
 */
'use strict';

// Deterministic dims before anything (io/term reads stdout.columns at load).
process.stdout.columns = 80; process.stdout.rows = 24;

const { describe, it, assert, report } = require('./test-runner');   // auto-wires panel-host
const { Terminal } = require('@xterm/headless');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const { applyMsg } = require('../dispatch/control/dispatch');
const { render } = require('../render/paint');

const _grp = (name, label) => ({
  name, label, containers: [],
  actions: { a1: { key: 'a1', label: 'Action 1', type: 'run', script: 'echo a1', tab: false } },
  children: [], parent: null, depth: 0, quick: false,
});
getModel().config = {
  project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
  groups: { g1: _grp('g1', 'Group 1') },
};
initState();
getModel().projectDir = '.';

const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

// Capture the RAW bytes a render writes (rendering is synchronous).
function cap() {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { render(getModel()); } finally { process.stdout.write = orig; }
  return chunks.join('');
}
// @xterm's write() parses asynchronously — await the callback before reading.
const flush = (bytes) => new Promise((res) => term.write(bytes, res));
function screenText() {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = 0; y < term.rows; y++) {
    const ln = buf.getLine(y);
    lines.push(ln ? ln.translateToString(true) : '');
  }
  return lines.join('\n');
}

(async () => {
  // Capture three frames in order (paint's diff state advances f0 → A → B).
  const f0 = cap();                                                    // base, no menu
  applyMsg({ type: 'menu_open', items: [['ZZALPHAROW', 'noop', null]], anchor: { x: 4, y: 3 } });
  const fA = cap();                                                    // context menu at a cursor anchor
  applyMsg({ type: 'menu_open', items: [['QQBRAVOROW', 'noop', null]], anchor: { x: 40, y: 3 } });
  const fB = cap();                                                    // in-place replacement (fresh items, menuOpen stays set)

  await flush(f0); await flush(fA);
  const afterA = screenText();
  await flush(fB);
  const afterB = screenText();

  describe('[menu-replace] a replaced menu leaves no ghost', () => {
    it('menu A paints on screen (precondition)', () => {
      assert(afterA.includes('ZZALPHAROW'), 'menu A visible after its frame');
    });
    it('the replacement wipes menu A and shows the picker', () => {
      assert(afterB.includes('QQBRAVOROW'), 'picker B is on screen');
      assert(!afterB.includes('ZZALPHAROW'), 'first menu left NO ghost (full repaint wiped it)');
    });
  });
  report();
})();
