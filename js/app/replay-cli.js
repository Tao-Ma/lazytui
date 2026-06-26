/**
 * `--replay <session.jsonl>` — reconstruct a recorded session from its WAL and
 * print the frame. Headless: no TTY required, no PTY spawned, no subscriptions
 * armed (the replay flag suppresses effects + the finalizer's IO; the recorded
 * Msg stream alone drives state). Takes no config — the recorded `set_config`
 * Msg carries it.
 *
 * The harness installs the SAME non-Msg runtime scaffolding the live boot does
 * (host wiring + effect handlers + the built-in Component set from
 * app/components + the per-pane/sub reconcilers), then folds the WAL from the
 * bare model. (It folds from the start rather than seeking a checkpoint:
 * checkpoint-accelerated CLI seek needs mint-on-restore — restoreState would
 * have to recreate the per-pane instance set before writing slices — which is a
 * documented follow-up. In-process checkpoint seek is proven by test-replay-checkpoint.)
 *
 * v0.6.6 replay arc; see docs/v0.6.6-replay-readiness.md + the arc memory.
 */
'use strict';

function _installRuntime() {
  require('../dispatch/runtime/host-wiring').wirePanelHost();
  const { effectHost, installBuiltins } = require('../dispatch/runtime/effects');
  require('../panel/nav-state').setNavDispatch(effectHost());
  require('../panel/commands').setCommandsDispatch(effectHost());
  installBuiltins();
  const { registerComponent } = require('../panel/api');
  for (const comp of require('./components').BUILTIN_COMPONENTS) registerComponent(comp);
  require('../panel/viewer/pty-lifecycle').install(effectHost());
  // Wire the reconcilers the finalizer needs so a replayed `set_arrange` mints
  // the per-pane slices (the sub-reconcile is skipped under replay, but wire it
  // for parity with the live boot).
  const state = require('./state');
  const finalize = require('../dispatch/runtime/finalize');
  finalize.setInstanceReconciler(state.reconcilePaneInstances);
  finalize.setSubscriptionReconciler(state.reconcileSubscriptions);
}

// Decode a painted frame (absolute cursor moves + text, no newlines) back into
// a readable rows×cols grid — for piped/captured output. A live TTY gets the
// raw positioned frame instead (it paints the actual screen).
function _frameToText(raw, cols, rows) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
  let r = 1, c = 1, i = 0;
  while (i < raw.length) {
    const pos = raw.slice(i).match(/^\x1b\[(\d+);(\d+)H/);
    if (pos) { r = +pos[1]; c = +pos[2]; i += pos[0].length; continue; }
    const csi = raw.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]|^\x1b[=>]/);
    if (csi) { i += csi[0].length; continue; }
    const ch = raw[i++];
    if (ch === '\n') { r++; c = 1; continue; }
    if (ch === '\r') { c = 1; continue; }
    if (r >= 1 && r <= rows && c >= 1 && c <= cols) grid[r - 1][c - 1] = ch;
    c++;
  }
  return grid.map(row => row.join('').replace(/\s+$/, '')).join('\n');
}

function runReplay(file, opts = {}) {
  require('../render/paint');   // side effect: registers renderers into the render-queue seam
  _installRuntime();
  const sessionLog = require('../io/session-log');
  const replay = require('../dispatch/runtime/replay');
  const { getModel } = require('../model/store');
  const { render } = require('../render/paint');
  const api = require('../panel/api');

  let log;
  try { log = sessionLog.load(file); }
  catch (e) { console.error(`--replay: cannot read ${file}: ${e.message}`); return 1; }

  const targetSeq = (opts.seq != null && Number.isFinite(opts.seq)) ? opts.seq : Infinity;
  // Fold the full WAL from the bare model (no checkpoint seek — see header).
  replay.replayTo(log, targetSeq, { useCheckpoints: false });

  // Capture the painted frame.
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { render(getModel()); } finally { process.stdout.write = orig; }
  const raw = chunks.join('');

  if (process.stdout.isTTY) {
    orig('\x1b[2J\x1b[H' + raw + '\n');
  } else {
    const dims = (api.serviceSlice('layout') && api.serviceSlice('layout').dims) || {};
    orig(_frameToText(raw, dims.cols || 80, dims.rows || 24) + '\n');
  }
  return 0;
}

module.exports = { runReplay, _frameToText, _installRuntime };
