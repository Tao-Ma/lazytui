/**
 * Kill-path history fidelity — a KILLED streaming command's final unterminated
 * output line must land in the history record's `output`, not only on the display.
 *
 * Regression (2026-09 deferred cosmetic #3): killJob() used to call
 * `ctx.record.kill()` (endEntry) BEFORE flushing the StringDecoder tail, and the
 * flushed tail was pushed only to the display batch (appendDetailLines) — so a
 * command killed mid-line lost its last partial line from history.output entirely.
 * The fix flushes the tail INTO the record before closing it, mirroring the normal
 * `close` path (rec.append(buffer) precedes rec.end()).
 *
 * Real `sh -c` spawn: the command writes a partial line (no trailing newline) then
 * blocks, so the byte sits in the stream's decoder buffer when we kill it.
 *
 * Run: node js/test/test-kill-history-tail.js
 */
'use strict';

const { section, assert, eq, report } = require('./test-runner');
const stream = require('../dispatch/runtime/stream');
const jobs = require('../feature/jobs');
const history = require('../feature/history');
const runtime = require('../app/runtime');
const api = require('../panel/api');

// Unrouted streams need a placed content slot (the Transcript target); routed
// streams run regardless. This test uses a ROUTED slotKey, but seed a real layout
// anyway so the history subscription + hub are fully wired (mirrors the sibling
// multi-job test's boot).
api.registerComponent(require('../panel/info/info'));
api.registerComponent(require('../panel/text-view/text-view'));

function seedModel() {
  const { parse } = require('../parser/index');
  const { initState } = require('../app/state');
  const m = runtime.init();
  m.config = parse(require('path').resolve(__dirname, '../../test/test.yml'));
  m.config.groups = { g: { label: 'G', actions: {} } };
  m.currentGroup = 'g';
  m.projectDir = '.';
  runtime.setModel(m);
  initState();
}

const TAIL = 'partial-tail-xyz';

section('[kill-tail] a killed command\'s last unterminated line is recorded in history');

seedModel();
jobs._reset();

// printf writes the tail with NO newline, then sleep keeps the proc alive so the
// byte stays buffered (unterminated) until we kill it.
stream.streamCommand('killme', `printf '${TAIL}'; sleep 5`, [], {
  slotKey: 'pane-tv-act-g-killme', tabKey: 'killme', groupName: 'g',
});
const jobId = jobs.snapshot().filter((j) => j.status === 'running')[0].id;

// Give the printf byte time to arrive on the pipe (onData buffers it as a partial
// line), THEN kill and assert the flushed tail reached history.output.
setTimeout(() => {
  stream.killJob(jobId, { silent: true });

  const entry = history.snapshot().find((e) => e.label === 'killme');
  assert(entry, 'a history entry was recorded for the killed command');
  if (entry) {
    assert(entry.output.includes(TAIL),
      `the killed command's decoder tail is in history.output (got ${JSON.stringify(entry.output)})`);
    assert(entry.endedAt !== null, 'the entry is closed (endedAt stamped)');
    // Final-state convergence: endEntry's mirror snapshot carries the full output,
    // so a from-snapshot replay reconstructs a finished entry WITH the tail.
    eq(entry.output[entry.output.length - 1], TAIL, 'the tail is the last recorded line');
  }

  stream.killAll({ silent: true });
  report();
}, 250);
