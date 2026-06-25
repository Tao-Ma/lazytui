/**
 * History smoke test — exercises the hub-backed history module: start,
 * append, end, kill, detached, ring trim, output cap, newest-first
 * ordering. Verifies hub schema is registered.
 *
 * Run: node js/test/test-history.js
 */
'use strict';

const hub = require('../leaves/infra/hub');
const { describe, it, assert, eq, report } = require('./test-runner');

// Per-suite harness: history.js subscribes to actions.lifecycle on first
// `start()` and caches `_initialized` in module scope. Tests that need a
// clean hub re-require history (after deleting its require-cache entry)
// so the subscribe runs again against the freshly-reset hub.
function freshHistory() {
  hub._reset();
  delete require.cache[require.resolve('../feature/history')];
  return require('../feature/history');
}

const h1 = freshHistory();

describe('[1] start() returns handle + entry with stable fields', () => {
  it('entry shape and handle methods are present', () => {
    const r = h1.start('build', 'make all');
    assert(r.entry.id >= 1, 'entry has id');
    assert(typeof r.entry.startedAt === 'number', 'entry has startedAt');
    eq(r.entry.label, 'build', 'entry label preserved');
    eq(r.entry.cmd, 'make all', 'entry cmd preserved');
    eq(r.entry.exitCode, null, 'exitCode null while running');
    eq(r.entry.endedAt, null, 'endedAt null while running');
    assert(typeof r.append === 'function', 'handle exposes append()');
    assert(typeof r.end === 'function', 'handle exposes end()');
    assert(typeof r.kill === 'function', 'handle exposes kill()');
    // Mutate via the handle so subsequent tests can observe lifecycle.
    r.append('hello');
    r.append('world');
    r.end(0);
    eq(r.entry.output, ['hello', 'world'], 'two output lines captured');
    eq(r.entry.exitCode, 0, 'exit code recorded');
    assert(r.entry.endedAt >= r.entry.startedAt, 'endedAt set on close');
  });
});

describe('[2] newest-first ordering', () => {
  it('snapshot() returns entries with newest at index 0', () => {
    h1.start('second', '');
    h1.start('third', '');
    const list = h1.snapshot();
    assert(list.length >= 3, 'at least 3 entries present');
    eq(list[0].label, 'third', 'newest first');
    eq(list[1].label, 'second', 'second-newest next');
  });
});

describe('[3] detached entry semantics', () => {
  it('endedAt set immediately, append() is no-op, exitCode marked', () => {
    const det = h1.start('spawn-vim', 'vim', { detached: true });
    eq(det.entry.exitCode, 'detached', 'detached marker on exitCode');
    assert(det.entry.endedAt !== null, 'endedAt set immediately for detached');
    assert(det.entry._detached === true, 'internal _detached flag');
    det.append('this should be ignored');
    eq(det.entry.output, [], 'append() is a no-op on detached entry');
  });
});

describe('[4] kill() marks as killed', () => {
  it('exitCode === "killed", endedAt set', () => {
    const k = h1.start('runaway', 'sleep 999');
    k.kill();
    eq(k.entry.exitCode, 'killed', 'killed marker');
    assert(k.entry.endedAt !== null, 'endedAt set on kill');
  });
});

describe('[5] end()/kill() idempotent', () => {
  it('second close does not change endedAt or exitCode', () => {
    const i = h1.start('once', '');
    i.end(7);
    const firstEnd = i.entry.endedAt;
    i.end(99);
    i.kill();
    eq(i.entry.exitCode, 7, 'second end() ignored');
    eq(i.entry.endedAt, firstEnd, 'endedAt unchanged on second close');
  });
});

describe('[6] output line cap (200 lines max)', () => {
  it('appends past cap are dropped', () => {
    const lc = h1.start('noisy', 'yes');
    for (let n = 0; n < 250; n++) lc.append(`line ${n}`);
    assert(lc.entry.output.length <= 200, `line count <= 200 (got ${lc.entry.output.length})`);
    lc.end(0);
  });
});

describe('[7] output byte cap → truncation marker', () => {
  it('truncation marker appears once, not duplicated', () => {
    const bc = h1.start('big', 'cat huge');
    const bigLine = 'x'.repeat(500);
    for (let n = 0; n < 20; n++) bc.append(bigLine);
    const last = bc.entry.output[bc.entry.output.length - 1];
    eq(last, '… (output truncated)', 'truncation marker appended');
    bc.append('more');
    const stillLast = bc.entry.output[bc.entry.output.length - 1];
    eq(stillLast, '… (output truncated)', 'truncation marker not duplicated');
    bc.end(0);
  });
});

describe('[8] ring trim past HISTORY_MAX', () => {
  it('newest survives, oldest evicted at 100-entry cap', () => {
    const h2 = freshHistory();
    for (let n = 1; n <= 130; n++) h2.start(`run-${n}`, '');
    const trimmed = h2.snapshot();
    eq(trimmed.length, 100, 'ring trimmed to 100 entries');
    eq(trimmed[0].label, 'run-130', 'newest survives');
    eq(trimmed[trimmed.length - 1].label, 'run-31', 'oldest 30 evicted');
  });
});

describe('[9] defineTopic schema present', () => {
  it('actions.lifecycle schema registered with column metadata', () => {
    const sch = hub.schema('actions.lifecycle');
    assert(sch !== null, 'schema registered');
    assert(sch.columns && sch.columns.label, 'columns defined');
  });
});

describe('[10] entries stored on actions.lifecycle topic', () => {
  it('hub direct read returns the same entries', () => {
    const direct = hub.history('actions.lifecycle', '_', 5);
    assert(direct.length > 0, 'hub direct read returns samples');
    assert(direct[direct.length - 1].label.startsWith('run-'), 'hub stores the same entries');
  });
});

describe('[11] setOnChange contract (store-mirror seam, FIX-1)', () => {
  it('fires cb on start + end, NOT on per-line append; null unregisters', () => {
    const h = freshHistory();
    let fires = 0;
    h.setOnChange(() => { fires++; });
    const r = h.start('mirrored', '');   // list-shape change → fire
    eq(fires, 1, 'start() fired the change cb');
    r.append('line-a'); r.append('line-b');
    eq(fires, 1, 'per-line append() does NOT fire (high-frequency, §8.1)');
    r.end(0);                            // completed → fire
    eq(fires, 2, 'end() fired the change cb');
    // The cb sees the current snapshot via the store's reader.
    eq(h.snapshot()[0].label, 'mirrored', 'snapshot reflects the entry');
    h.setOnChange(null);                 // unregister
    h.start('after-unregister', '');
    eq(fires, 2, 'no fire after setOnChange(null)');
  });
});

report();
