/**
 * node-pty is an OPTIONAL dependency (its native addon has no prebuild on some
 * platforms, e.g. linux-arm64, and its source build needs a toolchain, so
 * `npm install` may skip it). The dispatch runtime top-level-requires io/terminal
 * at boot (cleanup / finalize / actions), so a bare `require('node-pty')` would
 * crash the WHOLE TUI on a node-pty-less install. This pins the graceful path:
 * terminal.js loads, terminal SESSIONS no-op, and the terminal PANE shows a notice
 * instead of a blank box or a crash.
 *
 * Mock node-pty's require to THROW before loading terminal.js (run-tests gives each
 * file its own process, so this override is isolated).
 *
 * Run: node js/test/test-terminal-optional-pty.js
 */
'use strict';

const Module = require('module');
const _load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-pty') throw new Error('test: node-pty not installed');
  return _load.call(this, request, ...rest);
};

const { describe, it, assert, eq, report } = require('./test-runner');
const term = require('../io/terminal');            // guarded require must not throw
const panel = require('../panel/terminal/terminal');
const { stripMarkup } = require('../leaves/text/ansi');

describe('[terminal] degrades gracefully when the optional node-pty is absent', () => {
  it('io/terminal loads without node-pty (the dispatch runtime can boot)', () => {
    assert(term && typeof term.ensureSession === 'function', 'module loaded, exports intact');
  });

  it('ptyAvailable() reports false', () => eq(term.ptyAvailable(), false));

  it('ensureSession no-ops to null — no spawn, no throw', () => {
    eq(term.ensureSession('t1', 'echo hi', 80, 24, '.'), null);
  });

  it('session accessors stay null-safe (what the frame finalizer reads)', () => {
    eq(term.sessionSize('t1'), null);
    eq(term.restartSession('t1', 80, 24), null);
    term.destroyAll();   // must not throw
  });

  it('the terminal panel renders a notice instead of a blank box or crash', () => {
    const out = panel.panelTypes.terminal.render({ title: 'T', hotkey: '' }, 44, 9, {}, { chrome: null });
    const plain = stripMarkup(out);
    assert(plain.includes('unavailable') && plain.includes('node-pty'),
      `expected a node-pty notice, got: ${JSON.stringify(plain)}`);
    eq(out.split('\n').length, 9, 'exactly h rows (no crash)');
  });
});

describe('[terminal] without node-pty a terminal pane offers no typing (the keys)', () => {
  // Enter put the pane in terminal mode with no session behind it: the footer
  // said `Enter type here`, and every key after Enter vanished into the missing
  // session until Ctrl+\ (pre-release review 2026-11-14).
  process.stdout.columns = 160; process.stdout.rows = 40;
  const tl = require('./_helpers/terminal-layout');
  const route = require('../panel/route');
  const { getModel } = require('../model/store');
  const { dispatchMsg, applyMsg } = require('../dispatch/runtime/loop');
  const { focusedTerminalState } = require('../panel/terminal-surfaces');
  // The real stdin handler (terminal-mode routing lives there).
  const stdin = new (require('events').EventEmitter)();
  stdin.on('data', require('../dispatch/control/input')._makeDataHandler(stdin));
  const key = (t) => require('./smoke/_helpers/smoke').capture(() => stdin.emit('data', t));
  const fx = tl.boot({ cmd: 'sleep 60' });
  dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: fx.pane().paneId }));
  it('the footer offers no Enter (on screen, but nothing to type into)', () => {
    const st = focusedTerminalState(getModel());
    eq([st.onScreen, st.typeable], [true, false]);
    const hints = require('../leaves/input/bindings').footerFor('terminal', st);
    assert(!/Enter/.test(hints), hints);
  });
  it('Enter does not enter terminal mode', () => {
    key('\r');
    eq(getModel().modes.terminalMode, false);
  });
  it('a terminal mode entered anyway ends at the first key (no session to type into)', () => {
    applyMsg({ type: 'terminal_enter' });
    key('j');
    eq(getModel().modes.terminalMode, false);
  });
  it('once boot says no PTY can run (caps.pty false), every entry path is refused — and its auto-zoom undone', () => {
    // `:edit`, a spawn action, a group terminal and a docker shell each mint a
    // tab and enter terminal mode (some zooming the pane full first) — they
    // skipped activateTerminal's guard (round-2 review 2026-11-14). The reducer
    // refuses terminal_enter itself now.
    applyMsg({ type: 'caps_pty', available: false });
    dispatchMsg(route.wrap('layout', { type: 'view_set', mode: 'full' }));
    eq(route.getInstanceSlice('layout').viewMode, 'full', 'precondition: a caller zoomed the pane');
    applyMsg({ type: 'terminal_enter' });
    eq(getModel().modes.terminalMode, false, 'refused');
    eq(route.getInstanceSlice('layout').viewMode, 'normal', 'the zoom is undone');
  });
  // The model has the say once boot set it (`caps.pty`, recorded): a replayed
  // frame from a host where terminals ran paints the pane, not this host's
  // notice — and offers Enter as that host did (round-3 review 2026-11-14).
  it('caps.pty true (a recording from a host with node-pty): no notice, Enter offered', () => {
    applyMsg({ type: 'caps_pty', available: true });
    const out = panel.panelTypes.terminal.render({ title: 'T', hotkey: '' }, 44, 9, {}, { chrome: null });
    eq(stripMarkup(out).includes('unavailable'), false, 'no notice');
    eq(focusedTerminalState(getModel()).typeable, true, 'typeable, as there');
  });
  it('caps.pty false: the notice', () => {
    applyMsg({ type: 'caps_pty', available: false });
    const out = panel.panelTypes.terminal.render({ title: 'T', hotkey: '' }, 44, 9, {}, { chrome: null });
    eq(stripMarkup(out).includes('unavailable'), true);
  });
  fx.cleanup();
});

Module._load = _load;   // restore (belt-and-suspenders; process exits after report)
report();
