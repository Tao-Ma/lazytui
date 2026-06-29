/**
 * Async exec utilities for plugin authors.
 *
 * Plugins should NEVER call execSync / readFileSync / etc. in refresh()
 * or any other handler that runs in the main event loop. Sync I/O blocks
 * the loop — keys queue up, renders freeze, terminal overlays stutter.
 * The TUI feels "stuck" while the syscall is in flight.
 *
 * Use these helpers (or your own Promise-returning equivalents) instead.
 * Zero dependencies.
 */
'use strict';

const { spawn } = require('child_process');

/**
 * Run a shell command without blocking the event loop. Captures stdout
 * even on non-zero exit (partial output preserved — useful for batch
 * commands like `docker inspect a b c` where one might be missing).
 * Never rejects — errors / timeouts resolve with whatever stdout was
 * gathered. Pass `cwd`, `env`, `timeout` (ms; default 5000) in options.
 * Pass `signal` (an AbortSignal) to let a caller KILL the subprocess on
 * cancellation (C5 — keyed effect cancellation): an abort fires the child's
 * `error` event, which resolves with the partial stdout (never-reject intact).
 *
 * @returns {Promise<string>} stdout
 */
function execAsync(cmd, options = {}) {
  const { timeout = 5000, cwd, env, signal } = options;
  return new Promise((resolve) => {
    const opts = {};
    if (cwd) opts.cwd = cwd;
    if (env) opts.env = env;
    if (signal) opts.signal = signal;   // abort → SIGTERM the child → 'error' → resolve
    const proc = spawn('sh', ['-c', cmd], opts);
    let stdout = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
    proc.stdout.on('data', d => stdout += d.toString('utf8'));
    // Drain stderr — without a consumer the pipe buffer fills (typically
    // 64KB) and the child blocks on its next stderr write, holding the
    // function until `timeout` kicks in. Silent discard matches what the
    // function already does on non-zero exit (caller only sees stdout).
    proc.stderr.on('data', () => {});
    proc.on('close', () => { clearTimeout(timer); resolve(stdout); });
    proc.on('error', () => { clearTimeout(timer); resolve(stdout); });
  });
}

module.exports = { execAsync };
