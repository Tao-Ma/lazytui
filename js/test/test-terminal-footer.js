/**
 * A focused `terminal` pane says what its keys do — and its keys do it.
 *
 * Field report 2026-11-14 (nvim in a `type: terminal` pane): with the pane
 * focused, nothing said that Enter hands the keyboard to the editor — the
 * footer showed the generic list hints (`↑↓ select | / filter`, neither of
 * which applies). The terminal hints (`Enter activate` / `Enter restart` /
 * `x close`) still sat in the viewer footer's table behind an `isTerminal`
 * fact the viewer always passed as false (left over from when terminals were
 * viewer tabs). And on a dead terminal that is its slot's only tab, `x` did
 * nothing (remove_tab refuses the last tab) while the exit banner said
 * `x close`.
 *
 *   [1] live terminal: `Enter type here`, no list-only hints
 *   [2] minimized: no Enter hint (Enter does nothing there)
 *   [3] dead, only tab: `Enter restart`; `x` opens the menu, as its hint says;
 *       the exit banner offers no `x close`
 *   [4] dead, with a sibling tab: `x close` closes it; the banner offers it
 *   [5] the viewer footer no longer carries terminal hints
 *   [6] terminal mode names the pane by the title its border shows
 *       (`[terminal: Dev]`; it read `[terminal: terminal]` — the footer read a
 *       separate `label` a configured pane never had)
 *   [7] … and in a multi-tab slot, the active tab's title
 *
 * Run: node js/test/test-terminal-footer.js
 */
'use strict';

const { section, assert, eq, report } = require('./test-runner');
const tl = require('./_helpers/terminal-layout');
const sm = require('./smoke/_helpers/smoke');
const terminal = require('../io/terminal');
const route = require('../panel/route');
const { getModel } = require('../model/store');
const { dispatchMsg, applyMsg } = require('../dispatch/runtime/loop');
const { _dispatchToken, _makeDataHandler } = require('../dispatch/control/input');
const { EventEmitter } = require('events');

// Every frame the app writes goes to a virtual terminal (paint is a diff
// against the previous frame, so the screen must see them all); the runner's
// plain report lines pass through.
const { Terminal } = require('@xterm/headless');
const vt = new Terminal({ cols: 160, rows: 40, allowProposedApi: true });
let _frames = '';
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const str = String(chunk);
  if (str.includes('\x1b')) { _frames += str; return true; }
  return _origWrite(chunk, ...rest);
};
async function screen() {
  sm.render();
  await new Promise(res => setImmediate(res));
  const bytes = _frames; _frames = '';
  await new Promise(res => vt.write(bytes, res));
  const rows = [];
  for (let y = 0; y < vt.rows; y++) rows.push(vt.buffer.active.getLine(y).translateToString(true));
  return rows;
}
const footer = async () => (await screen())[39];
const frameText = async () => (await screen()).join('\n');
const focus = (paneId) => dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: paneId }));
const collapse = (p) => dispatchMsg(route.wrap('layout', { type: 'panel_collapse_toggle', id: p.id }));

(async () => {
  if (!terminal.ptyAvailable()) {
    console.log('  (skipped: the optional node-pty dependency is not installed)');
    process.stdout.write = _origWrite;
    report();
    return;
  }
  const fx = tl.boot({ cmd: 'sleep 60' });
  focus(fx.pane().paneId);

  section('[1] live terminal');
  const f1 = await footer();
  assert(f1.includes('Enter type here'), `says Enter hands it the keyboard: "${f1.trim()}"`);
  assert(!f1.includes('↑↓ select') && !f1.includes('/ filter'), 'no list-only hints');
  assert(f1.includes('x menu') && f1.includes('q quit') && f1.includes('←→ panel'), 'the keys that do apply');

  section('[2] minimized');
  collapse(fx.pane());
  const f2 = await footer();
  assert(!f2.includes('Enter'), `no Enter hint while there is nothing to type into: "${f2.trim()}"`);
  collapse(fx.pane());

  section('[3] dead, only tab');
  terminal.getSession(fx.id).exited = true;
  terminal.getSession(fx.id).exitCode = 1;
  const f3 = await footer();
  assert(f3.includes('Enter restart'), `offers a restart: "${f3.trim()}"`);
  assert(!f3.includes('x close'), 'no x close (the slot keeps its last tab)');
  assert(f3.includes('x menu'), 'x is the menu');
  const banner3 = await frameText();
  assert(banner3.includes('Process exited: 1'), 'precondition: the exit banner shows');
  assert(!banner3.includes('x close'), 'the banner offers no x close either');
  _dispatchToken('x');
  assert(getModel().modes.menuOpen, 'x opens the menu, as its hint says (it did nothing)');
  _dispatchToken('\x1b');
  assert(!getModel().modes.menuOpen, 'Esc closes it');

  section('[4] dead, with a sibling tab');
  dispatchMsg(route.wrap('layout', {
    type: 'mint_tab', paneId: fx.pane().paneId, paneType: 'terminal', poolId: 'term-sib',
    title: 'sib', config: { cmd: 'sleep 60' },
  }));
  eq(fx.pane().activeTabId, 'term-sib', 'precondition: the minted sibling is active');
  const sibId = 'pane-term-sib';
  assert(terminal.getSession(sibId), 'precondition: its PTY spawned');
  terminal.getSession(sibId).exited = true;
  terminal.getSession(sibId).exitCode = 2;
  const f4 = await footer();
  assert(f4.includes('x close') && f4.includes('Enter restart'), `x close + Enter restart: "${f4.trim()}"`);
  assert((await frameText()).includes('x close'), 'the banner offers x close');
  _dispatchToken('x');
  eq((fx.pane().tabs || []).length, 1, 'x closed the dead sibling');
  assert(!getModel().modes.menuOpen, 'without opening the menu');

  section('[5] the viewer footer no longer carries terminal hints');
  const bindings = require('../leaves/input/bindings');
  // The facts the viewer used to pass for a terminal tab — the entries they
  // guarded are gone, not just switched off.
  const segs = bindings.footerSegs('detail', { total: 2, isTerminal: true, dead: true, isEphemeral: true });
  assert(segs.includes('/ search'), 'viewer: / search');
  assert(!segs.some(s => /Enter (activate|restart)|x close/.test(s)), `no terminal hints: ${JSON.stringify(segs)}`);

  // Terminal mode's keys arrive on stdin (not _dispatchToken): Ctrl+\ leaves.
  const stdin = new EventEmitter();
  stdin.on('data', _makeDataHandler(stdin));

  section('[6] terminal mode names the pane by its title');
  focus(fx.pane().paneId);
  eq(fx.pane().tabs.length, 1, 'precondition: the configured pane is alone in its slot again');
  _dispatchToken('\r');                       // dead since [3]: Enter restarts it + types into it
  assert(getModel().modes.terminalMode, 'precondition: Enter entered terminal mode');
  const f6 = await footer();
  assert(f6.includes('[terminal: Dev]'), `the footer names it as its border does: "${f6.trim()}"`);
  assert(!f6.includes('[terminal: terminal]'), 'not the generic name');
  assert((await screen()).some(r => r.includes('Dev')), 'precondition: the border shows Dev');
  stdin.emit('data', '\x1c');
  assert(!getModel().modes.terminalMode, 'Ctrl+\\ left terminal mode');

  section('[7] a multi-tab slot: the active tab\'s title');
  dispatchMsg(route.wrap('layout', {
    type: 'mint_tab', paneId: fx.pane().paneId, paneType: 'terminal', poolId: 'term-two',
    title: 'Two', config: { cmd: 'sleep 60' },
  }));
  eq(fx.pane().activeTabId, 'term-two', 'precondition: the minted tab is active');
  _dispatchToken('\r');
  assert(getModel().modes.terminalMode, 'precondition: Enter entered terminal mode');
  const rows7 = await screen();
  const f7 = rows7[39];
  assert(f7.includes('[terminal: Two]'), `the footer names the active tab: "${f7.trim()}"`);
  assert(rows7.some(r => r.includes('Dev') && r.includes('Two')), 'precondition: the tab strip shows both names');
  stdin.emit('data', '\x1c');
  assert(!getModel().modes.terminalMode, 'Ctrl+\\ left terminal mode');

  terminal.destroyAll();
  fx.cleanup();
  process.stdout.write = _origWrite;
  report();
})();
