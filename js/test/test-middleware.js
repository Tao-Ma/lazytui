/**
 * Inbound dispatch middleware (C7, v0.6.7) — the link list that wraps every Msg
 * entering the loop. Verifies: onion ordering (first registered = outermost,
 * terminal innermost), entry transformation reaches the terminal, the empty-list
 * fast path, and the two built-in links (WAL record self-gated on enable; crash
 * reporter re-throws without swallowing).
 *
 * Run: node js/test/test-middleware.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const mw = require('../dispatch/runtime/middleware');
const sessionLog = require('../io/session-log');

describe('middleware — ordering, transform, fast path', () => {
  it('runs links in registration order (first = outermost), terminal innermost', () => {
    mw._reset();
    const trace = [];
    mw.use((e, next) => { trace.push('A-before'); const r = next(e); trace.push('A-after'); return r; });
    mw.use((e, next) => { trace.push('B-before'); const r = next(e); trace.push('B-after'); return r; });
    const out = mw.run({ lane: 'root', msg: { type: 'x' } }, () => { trace.push('term'); return 'done'; });
    eq(out, 'done', 'run threads the terminal result back out');
    eq(trace.join(','), 'A-before,B-before,term,B-after,A-after', 'onion order: A outermost, terminal innermost');
    mw._reset(); mw.installBuiltins();
  });

  it('a transforming link rewrites the entry the terminal sees', () => {
    mw._reset();
    mw.use((e, next) => next({ ...e, msg: { type: 'rewritten' } }));
    let seen = null;
    mw.run({ lane: 'root', msg: { type: 'orig' } }, (e) => { seen = e.msg.type; });
    eq(seen, 'rewritten', 'terminal sees the transformed msg');
    mw._reset(); mw.installBuiltins();
  });

  it('empty link list calls the terminal directly', () => {
    mw._reset();
    let ran = false;
    const out = mw.run({ lane: 'root', msg: {} }, () => { ran = true; return 7; });
    assert(ran, 'terminal ran with no links');
    eq(out, 7, 'fast path returns the terminal result');
    mw._reset(); mw.installBuiltins();
  });
});

describe('middleware — built-in WAL record link', () => {
  it('records the entering Msg per lane when recording is enabled', () => {
    mw._reset(); mw.installBuiltins();
    sessionLog.clear(); sessionLog.enable(true);
    mw.run({ lane: 'root', msg: { type: 'foo' } }, () => {});
    mw.run({ lane: 'comp', msg: { kind: 'viewer', msg: { type: 'bar' } } }, () => {});
    mw.run({ lane: 'key', key: 'down', seq: '\x1b[B' }, () => {});
    const snap = sessionLog.snapshot();
    sessionLog.enable(false); sessionLog.clear();
    eq(snap.length, 3, 'three Msgs recorded');
    eq(snap[0].lane, 'root', 'root lane recorded');
    eq(snap[0].msg.type, 'foo', 'root msg payload preserved');
    eq(snap[2].lane, 'key', 'key lane recorded');
    eq(snap[2].keySeq, '\x1b[B', 'key seq mapped to keySeq (recordMsg contract)');
  });

  it('record link is inert when recording is disabled (the default)', () => {
    mw._reset(); mw.installBuiltins();
    sessionLog.clear(); sessionLog.enable(false);
    mw.run({ lane: 'root', msg: { type: 'foo' } }, () => {});
    eq(sessionLog.snapshot().length, 0, 'nothing recorded when disabled');
  });
});

describe('middleware — built-in crash reporter', () => {
  it('re-throws a terminal error without swallowing (control flow preserved)', () => {
    mw._reset(); mw.use(mw.crashReporterLink);
    let threw = false;
    try {
      mw.run({ lane: 'root', msg: { type: 'boom' } }, () => { throw new Error('kaboom'); });
    } catch (e) {
      threw = true;
      eq(e.message, 'kaboom', 'original error propagates unchanged');
    }
    assert(threw, 'crash-reporter re-throws, does not swallow');
    mw._reset(); mw.installBuiltins();
  });
});

report();
