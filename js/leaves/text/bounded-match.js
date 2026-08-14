/**
 * bounded-match — a wall-clock ceiling on regex matching, so a catastrophic-
 * backtracking pattern typed into `/`-search or the files `/`-filter can never
 * freeze the UI thread.
 *
 * Why a worker (not a shape heuristic): you cannot enumerate every catastrophic
 * pattern with a guard regex — the paren-free sequential shape `a*a*a*…X` slips
 * past shape checks yet backtracks super-polynomially. The only durable bound is
 * on the WORK: run the match in a worker thread and terminate it if it blows a
 * budget. `worker.terminate()` kills even a thread stuck in a synchronous regex
 * exec (a V8 isolate teardown) — which the main thread cannot do to itself.
 *
 * The public calls are a PROBE: they run the match in the worker only to learn
 * whether it terminates within budget, blocking the caller via `Atomics.wait`.
 * The caller then recomputes the real result with the same match-core code (fast,
 * now that it's known-terminating). So there is no result to marshal across the
 * boundary — the SharedArrayBuffer carries a single status word.
 *
 * Callers are memoized (search.matchesFor's WeakMap; the files filter runs once
 * per keystroke), so the worker round-trip happens at most once per pattern.
 * Falls back to `'unavailable'` (caller uses its own sync path, still guarded by
 * regex-guard) only if worker_threads / SharedArrayBuffer are absent — never on
 * a supported Node.
 */
'use strict';

const path = require('path');

// Control protocol — MUST match leaves/text/regex-worker.js. Status at index 0.
const S_WORKING = 1, S_DONE = 2, S_SPAWNING = 3;

const MATCH_BUDGET_MS = 150;    // per-pattern ceiling on the hot path (a bomb costs this once, then memoized)
const READY_BUDGET_MS = 5000;   // one-time worker spawn + module load

let _worker = null;
let _ctrl = null;
let _available = null;          // null=unknown, true/false once probed

function _infra() {
  if (_available !== null) return _available;
  try {
    require('worker_threads');
    _available = (typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object');
  } catch { _available = false; }
  return _available;
}

function _kill() {
  if (_worker) { try { _worker.terminate(); } catch { /* already gone */ } }
  _worker = null; _ctrl = null;
}

function _ensureWorker() {
  if (_worker) return true;
  if (!_infra()) return false;
  try {
    const { Worker } = require('worker_threads');
    const ctrl = new Int32Array(new SharedArrayBuffer(4));   // one Int32 control word
    Atomics.store(ctrl, 0, S_SPAWNING);
    const w = new Worker(path.join(__dirname, 'regex-worker.js'), { workerData: { sab: ctrl.buffer } });
    w.unref();                                               // never keep the process (or a test) alive
    w.on('error', () => { if (_worker === w) _kill(); });
    // Block until the worker flips status off SPAWNING (its ready signal).
    Atomics.wait(ctrl, 0, S_SPAWNING, READY_BUDGET_MS);
    if (Atomics.load(ctrl, 0) === S_SPAWNING) { try { w.terminate(); } catch { /* */ } return false; }
    _worker = w; _ctrl = ctrl;
    return true;
  } catch { _kill(); return false; }
}

/**
 * Run `job` in the worker, blocking the caller up to MATCH_BUDGET_MS.
 * @returns {'safe'|'timedOut'|'unavailable'}
 *   'safe'        — terminated within budget; caller may recompute the real result
 *   'timedOut'    — blew the budget (worker terminated); treat the pattern as too slow
 *   'unavailable' — no worker infra; caller falls back to its own sync path
 */
function _probe(job) {
  if (!_ensureWorker()) return 'unavailable';
  try {
    Atomics.store(_ctrl, 0, S_WORKING);
    _worker.postMessage(job);
    Atomics.wait(_ctrl, 0, S_WORKING, MATCH_BUDGET_MS);
    if (Atomics.load(_ctrl, 0) === S_DONE) return 'safe';
    _kill();                                                 // still WORKING → runaway; kill it
    return 'timedOut';
  } catch { _kill(); return 'unavailable'; }
}

function probeSearch(lines, term)          { return _probe({ op: 'search', lines, term }); }
function probeFilter(names, pattern, flags) { return _probe({ op: 'filter', names, pattern, flags }); }

function _dispose() { _kill(); _available = null; }           // test/teardown hook

module.exports = { probeSearch, probeFilter, _dispose };
