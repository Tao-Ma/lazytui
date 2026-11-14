/**
 * A `terminal` pane with NO visible interior — minimized (a 1-row bar), or
 * squeezed below 3 rows / 3 columns — is not a terminal surface.
 *
 * Field report 2026-11-14 (an nvim pane, `type: terminal`): minimizing it
 * logged `[dispatch] post-dispatch scroll clamp error: Invalid array length`
 * on EVERY dispatch while it stayed minimized, and nvim's screen stayed
 * painted where the pane's body had been. The PTY reconcile sized the session
 * to the 1-row bar (`rows = h - 2 = -1`, io/terminal resizeSession's
 * `prevFrame.length = -1` threw), and the overlay still listed the bar as a
 * surface, so the vanish reclaim that clears a departed surface never fired.
 *
 * One rule now (panel/terminal-surfaces `terminalInterior`): a surface needs
 * an interior of at least 1×1. The finalizer's PTY reconcile, the overlay, the
 * overlay poll gate and Enter's activate/restart all read it.
 *
 *   [1] minimize: no finalize error, the PTY keeps its last size, no surface
 *   [2] minimize clears the painted grid; restore paints it back
 *   [3] a narrow screen never sizes the PTY below 1×1
 *   [4] Enter on a minimized terminal neither enters terminal mode nor
 *       restarts a dead session at a negative size
 *   [5] io/terminal refuses a non-positive size (defense in depth)
 *
 * Run: node js/test/test-terminal-no-interior.js
 */
'use strict';

process.stdout.columns = 160; process.stdout.rows = 40;

const { section, assert, eq, report } = require('./test-runner');
const tl = require('./_helpers/terminal-layout');   // the field layout (dev.sh)
const terminal = require('../io/terminal');
const route = require('../panel/route');
const { visibleTerminalSurfaces } = require('../panel/terminal-surfaces');
const { getModel } = require('../model/store');
const { dispatchMsg, applyMsg } = require('../dispatch/runtime/loop');
const sm = require('./smoke/_helpers/smoke');

// Every console.error a step logs (the finalizer reports its throw there).
const errors = [];
const _origErr = console.error;
console.error = (...a) => { errors.push(a.join(' ')); _origErr(...a); };
const clampErrors = () => errors.filter(e => /^\[dispatch\] post-dispatch/.test(e));

const devPane = tl.terminalPane;
const toggleCollapse = (p) => dispatchMsg(route.wrap('layout', { type: 'panel_collapse_toggle', id: p.id }));
const focusPane = (p) => dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: p.paneId }));
const pressEnter = () => require('../dispatch/control/input')._dispatchToken('\r');

// Every frame the app writes — the explicit renders below AND the ones the
// render queue schedules on its own (setImmediate) — goes to a virtual
// terminal (_helpers/host-screen), so the screen it holds is what the user
// would see.
const hs = require('./_helpers/host-screen').install({ cols: 160, rows: 40 });
const { vt, feed: flush, paint: paintAndSync } = hs;
function screenText() {
  const out = [];
  for (let y = 0; y < vt.rows; y++) out.push(hs.line(y));
  return out.join('\n');
}

(async () => {
  if (!terminal.ptyAvailable()) {
    _origErr('  (skipped: the optional node-pty dependency is not installed)');
    hs.restore();
    report();
    return;
  }

  const fx = tl.boot({ cmd: 'sleep 60' });
  const pane = fx.pane();
  const id = fx.id;

  section('[1] minimize: no finalize error, the PTY keeps its last size, no surface');
  assert(terminal.getSession(id), 'precondition: the finalizer spawned the PTY');
  const before = terminal.sessionSize(id);
  assert(before && before.cols > 0 && before.rows > 0, `precondition: a positive size (${JSON.stringify(before)})`);
  assert(visibleTerminalSurfaces(getModel()).some(s => s.id === id), 'precondition: an on-screen surface');

  // A marker in the grid, so [2] can see whether it survives the minimize.
  await flush(terminal.getSession(id).screen, '\r\nGHOSTMARK-7f3a');
  await paintAndSync();
  assert(screenText().includes('GHOSTMARK-7f3a'), 'precondition: the grid is painted');

  errors.length = 0;
  toggleCollapse(pane);
  assert(devPane().collapsed, 'the pane is minimized');
  eq(clampErrors(), [], 'no post-dispatch error on the minimize');
  dispatchMsg(route.wrap('layout', { type: 'term_resized', cols: 160, rows: 40 }));
  eq(clampErrors(), [], 'no error on later dispatches either');
  eq(terminal.sessionSize(id), before, 'the PTY keeps its last size (no SIGWINCH to a 1-row bar)');
  assert(!visibleTerminalSurfaces(getModel()).some(s => s.id === id), 'a minimized terminal is not a surface');

  section('[2] minimize clears the painted grid; restore paints it back');
  await paintAndSync();
  assert(!screenText().includes('GHOSTMARK-7f3a'), 'no stale grid where the pane body was');
  eq(clampErrors(), [], 'the minimized frame renders without error');
  toggleCollapse(devPane());
  assert(!devPane().collapsed, 'restored');
  eq(terminal.sessionSize(id), before, 'restored at the same size');
  await paintAndSync();
  assert(screenText().includes('GHOSTMARK-7f3a'), 'the grid paints again on restore');

  section('[3] a narrow screen never sizes the PTY below 1×1');
  errors.length = 0;
  for (const cols of [100, 80, 70, 60, 50, 40, 36, 30]) {
    sm.resize(cols, 40);
    const sz = terminal.sessionSize(id);
    assert(sz && sz.cols >= 1 && sz.rows >= 1, `at ${cols} columns the PTY is ${JSON.stringify(sz)}`);
  }
  eq(clampErrors(), [], 'no post-dispatch error at any width');
  sm.resize(160, 40);
  eq(terminal.sessionSize(id), before, 'back to the full size');

  section('[4] Enter on a minimized terminal');
  focusPane(devPane());
  eq(route.getFocus(), devPane().paneId, 'precondition: the terminal pane is focused');
  toggleCollapse(devPane());
  pressEnter();
  assert(!getModel().modes.terminalMode, 'does not enter terminal mode with nothing on screen to type into');
  // A dead session: Enter used to restart it sized to the bar (rows -1).
  terminal.getSession(id).exited = true;
  errors.length = 0;
  let threw = null;
  try { pressEnter(); } catch (e) { threw = e; }
  eq(threw && threw.message, null, 'no throw');
  assert(terminal.getSession(id) && terminal.getSession(id).exited,
    'the dead session is left for a restart once the pane is visible');
  toggleCollapse(devPane());
  pressEnter();
  const restarted = terminal.getSession(id);
  assert(restarted && !restarted.exited, 'restored + Enter restarts it');
  eq(terminal.sessionSize(id), before, 'at the pane size');
  assert(getModel().modes.terminalMode, 'and enters terminal mode');
  applyMsg({ type: 'terminal_exit' });

  section('[5] io/terminal refuses a non-positive size');
  terminal.resizeSession(id, 40, -1);
  eq(terminal.sessionSize(id), before, 'resizeSession(…, -1) is a no-op');
  terminal.resizeSession(id, 0, 10);
  eq(terminal.sessionSize(id), before, 'resizeSession(0, …) is a no-op');
  eq(terminal.ensureSession('pane-never-spawned', 'sleep 1', 10, 0, '.'), null, 'ensureSession at 0 rows spawns nothing');
  assert(!terminal.getSession('pane-never-spawned'), 'and registers nothing');
  eq(terminal.restartSession(id, 10, -1), null, 'restartSession at a negative size refuses');
  assert(terminal.getSession(id) && !terminal.getSession(id).exited, 'without killing the live session');

  terminal.destroyAll();
  fx.cleanup();
  console.error = _origErr;
  hs.restore();
  report();
})();
