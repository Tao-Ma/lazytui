/**
 * Stream error-path history fidelity — a producer that streams a partial (unterminated)
 * line and then hits a stream `'error'` (e.g. EPIPE) must keep that last line in the
 * history record, exactly like the close/kill termination seams.
 *
 * Regression (2026-09 deep review, finding #5): stream.js `proc.on('error')` called
 * `rec.end('error')` without draining the decoder/`buffer`, so the last partial line
 * reached neither history.output nor the display — the lone termination seam that
 * didn't flush its tail (close and killJob both do). The fix flushes the tail into the
 * record + display before the Error footer.
 *
 * The ChildProcess `'error'` event does not fire mid-stream under real spawning (it is a
 * spawn/kill-failure signal), so this test STUBS `child_process.spawn` with a controllable
 * fake proc — the stub is set BEFORE any module that captures `spawn` is required, and is
 * process-local (run-tests.js isolates each file), so it affects only this test.
 *
 * Run: node js/test/test-stream-error-tail.js
 */
'use strict';

// --- stub spawn FIRST, before stream.js (or anything) destructures it ---
const cp = require('child_process');
const { EventEmitter } = require('events');
let lastProc = null;
cp.spawn = function stubSpawn() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.pid = 4242;
  p.kill = () => {};
  lastProc = p;
  return p;
};

const { describe, it, assert, eq, report } = require('./test-runner');   // auto-registers layout/detail/groups + wires the host
const stream = require('../dispatch/runtime/stream');
const jobs = require('../feature/jobs');
const history = require('../feature/history');
const runtime = require('../app/runtime');
const api = require('../panel/api');

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

describe('[error-tail] a stream error after a partial line keeps that line in history', () => {
  it('proc \'error\' flushes the decoder tail into the record, like close/kill', () => {
    seedModel();
    jobs._reset();
    stream.streamCommand('errjob', 'whatever', [], {
      slotKey: 'pane-tv-act-g-errjob', tabKey: 'errjob', groupName: 'g',
    });
    assert(lastProc, 'the (stubbed) proc was created');
    // A full line, then a PARTIAL line (no trailing newline) that sits in the decoder
    // buffer, then the stream errors before it could be flushed by a newline/close.
    lastProc.stdout.emit('data', Buffer.from('first-line\npartial-ERR-tail'));
    lastProc.emit('error', new Error('synthetic EPIPE'));

    const entry = history.snapshot().find((e) => e.label === 'errjob');
    assert(entry, 'a history entry was recorded');
    assert(entry.output.includes('first-line'), 'the terminated line was recorded');
    assert(entry.output.includes('partial-ERR-tail'),
      `the partial tail reached history.output on the error path (got ${JSON.stringify(entry.output)})`);
    assert(entry.output.some((l) => l.startsWith('Error:')), 'the Error footer is recorded after the tail');
    assert(entry.endedAt !== null, 'the entry is closed (endedAt stamped)');
  });
});

report();
