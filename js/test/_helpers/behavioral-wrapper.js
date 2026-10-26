/**
 * Shared bash-subprocess harness for behavioral tests that need real OS
 * signals (SIGINT delivery, process-group kill, subprocess orphan
 * detection). Factored from the Z-BUG1 (Ctrl-C mid-TAB) and TERM-trap
 * (SIGKILL cascade) regression tests in test-completion.js.
 *
 * Why: those tests spawn `node tui.js … --complete …`, send signals,
 * wait past a sleep, and check whether a sentinel file was touched by
 * the subprocess. Each test did ~20 lines of inline bash + two unlink
 * calls (prior-run guard + post-run cleanup). Collision on
 * `pid+timestamp` is real; forgetting a cleanup leaks files. This
 * helper gives both for free.
 *
 * Usage:
 *   const { makeSentinel, runProbe } = require('./_helpers/behavioral-wrapper');
 *   const sentinel = makeSentinel('termtrap');
 *   const yaml = `… choices_cmd: 'trap "" TERM; sleep 2 && touch ${sentinel}' …`;
 *   // ...write config file...
 *   const r = runProbe({
 *     sentinel,
 *     bash: `
 *       node ${TUI} ${cfg} --complete 3 -- do g slow '' >/dev/null 2>&1
 *       sleep 2.5
 *       if [ -f ${sentinel} ]; then echo REGRESSION; exit 1; fi
 *       echo OK
 *     `,
 *     timeoutMs: 10000,
 *   });
 *   // r.status, r.stdout, r.stderr — assert as needed
 *
 * The helper does NOT impose an assertion shape — call sites still use
 * eq/assert. All it owns: (1) unique sentinel path per call (tag + pid +
 * timestamp + random tail), (2) pre-run unlink so a stale file can't
 * fool the test, (3) post-run unlink so files don't accumulate.
 */
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

/**
 * Build a unique sentinel file path. Caller interpolates it into
 * configs/scripts; runProbe below unlinks it before + after the run.
 */
function makeSentinel(tag, dir) {
  const t = String(tag || 'probe').replace(/[^a-zA-Z0-9_-]/g, '_');
  const d = dir || '/tmp';
  return `${d}/behavioral-${t}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * @param {object} opts
 * @param {string} opts.sentinel — path from makeSentinel (or caller-built).
 * @param {string} opts.bash — bash body to run under `bash -c`.
 * @param {number} [opts.timeoutMs=10000]
 */
function runProbe(opts) {
  if (!opts || typeof opts.bash !== 'string') throw new Error('runProbe: opts.bash required');
  if (typeof opts.sentinel !== 'string') throw new Error('runProbe: opts.sentinel required (use makeSentinel)');
  try { fs.unlinkSync(opts.sentinel); } catch (_) { /* didn't exist */ }
  try {
    const r = spawnSync('bash', ['-c', opts.bash], {
      encoding: 'utf8',
      timeout: opts.timeoutMs || 10000,
    });
    return {
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      signal: r.signal,
    };
  } finally {
    try { fs.unlinkSync(opts.sentinel); } catch (_) { /* best-effort */ }
  }
}

module.exports = { makeSentinel, runProbe };
