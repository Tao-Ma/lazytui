/**
 * Recording control — save / load / stop, the runtime side of the `record-*`
 * triggers (the `--record-save`/`--record-load` flags and the `record-save`/
 * `record-load`/`record-stop` cmdline verbs). Exposed to the panel layer through
 * the effect host (panel → dispatch is injection-only), so the cmdline verbs
 * call `_host.recordSave/recordLoad/recordStop`.
 *
 * Orchestrates io/session-log (the WAL) + ./replay (checkpoint + fold). Lives in
 * dispatch/runtime so it can reach both without an up-edge. v0.6.6 replay arc.
 *
 *   record-save [file]  → checkpoint the full current state, then stream
 *                         follow-up Msgs to a self-contained file.
 *   record-load [file]  → clear the windows and recover: re-apply the recorded
 *                         WAL into the LIVE registry/model (mint-on-restore),
 *                         then repaint. (A future replay-control pane will add
 *                         interactive stepping.)
 *   record-stop         → stop recording (detach the stream, disable).
 */
'use strict';

const sessionLog = require('../../io/session-log');
const replay = require('./replay');

/** Already actively recording to a file? */
function isRecording() { return sessionLog.isEnabled() && !!sessionLog.streamPath(); }

/** Start recording to `file` (default: the conventional session file). Records
 *  a checkpoint of the full current state first, so the file replays from here
 *  even mid-session, then streams subsequent Msgs + auto-cadence checkpoints.
 *  A repeated record-save while already recording is SKIPPED (returns the
 *  in-progress path). Returns `{ path, skipped }`. */
function save(file) {
  if (isRecording()) return { path: sessionLog.streamPath(), skipped: true };
  const path = file || sessionLog.DEFAULT_SESSION_FILE;
  sessionLog.enable(true);
  sessionLog.setCheckpointCadence(sessionLog.DEFAULT_CHECKPOINT_CADENCE);
  replay.checkpointNow();        // full current state → self-contained from here
  sessionLog.streamTo(path);     // seed the file with the buffer (incl. checkpoint) + stream
  return { path, skipped: false };
}

/** Recover a recorded session into the LIVE TUI: clear the windows and re-apply
 *  the WAL (seeking the nearest checkpoint; mint-on-restore rebuilds the pane
 *  set), then repaint. Runs off the current dispatch tick so the fold lands at
 *  depth-0. Returns the resolved path, or null if the file can't be read. */
function load(file) {
  const path = file || sessionLog.streamPath() || sessionLog.DEFAULT_SESSION_FILE;
  stop();                        // don't record the reconstruction itself
  let log;
  try { log = sessionLog.load(path); }
  catch (e) {
    try { require('../../io/diag-log').error('replay', `record-load: ${e.message}`); } catch (_) {}
    return null;
  }
  setImmediate(() => {
    try {
      replay.replayTo(log, Infinity, { useCheckpoints: true });
      require('../../panel/api').scheduleRender();
    } catch (e) {
      try { require('../../io/diag-log').error('replay', `record-load fold: ${e.message}`); } catch (_) {}
    }
  });
  return path;
}

/** Stop recording: detach the stream, disable the recorder, clear auto-cadence. */
function stop() {
  sessionLog.detachStream();
  sessionLog.enable(false);
  sessionLog.setCheckpointCadence();   // both thresholds off
}

module.exports = { save, load, stop };
