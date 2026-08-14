/**
 * regex-worker — the worker-thread half of leaves/text/bounded-match.
 *
 * Node has no per-call regex timeout, so a catastrophic-backtracking pattern
 * (e.g. the sequential `a*a*a*…X` shape the heuristic guard can't detect) freezes
 * whatever thread runs it. This worker runs the SAME match the main thread would,
 * to completion — if the pattern backtracks forever, THIS thread hangs and the
 * main thread (blocked on Atomics with a budget) terminates it. So the freeze is
 * confined to a disposable worker and capped at the budget, never the UI thread.
 *
 * Protocol: a 1-word Int32 control in a SharedArrayBuffer (workerData.sab),
 * index 0 = status. On load we flip it off SPAWNING to signal ready; per job we
 * run the work then set DONE + notify. The RESULT is discarded — this is a
 * termination probe; the main thread recomputes the real result with the same
 * (match-core) code once it knows the pattern is safe.
 */
'use strict';

const { parentPort, workerData } = require('worker_threads');
const { computeMatches } = require('./match-core');
const { safeRegex } = require('./regex-guard');

// Control protocol — MUST match leaves/text/bounded-match.js.
const S_IDLE = 0, S_DONE = 2;
const ctrl = new Int32Array(workerData.sab);

parentPort.on('message', (job) => {
  try {
    if (job.op === 'search') {
      computeMatches(job.lines, job.term);                         // run to completion; result discarded
    } else if (job.op === 'filter') {
      const rx = safeRegex(job.pattern, job.flags);
      if (rx) for (let i = 0; i < job.names.length; i++) rx.test(job.names[i]);
    }
  } catch { /* a bad/invalid pattern is just "no work" — still signal done */ }
  Atomics.store(ctrl, 0, S_DONE);
  Atomics.notify(ctrl, 0);
});

// Ready: flip status off SPAWNING so the main thread's spawn-wait wakes. Done
// AFTER the message handler is registered, so no job can race ahead of it.
Atomics.store(ctrl, 0, S_IDLE);
Atomics.notify(ctrl, 0);
