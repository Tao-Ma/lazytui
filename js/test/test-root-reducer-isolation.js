/**
 * Root-reducer error isolation — a throw in a root-reducer arm must NOT propagate out of
 * applyMsg and tear down the dispatch loop (which would wedge all input). It is recorded
 * (event-log) and swallowed, leaving the model unchanged — mirroring the Component paths
 * (_termComp / _termKey), which already catch + record.
 *
 * Regression (2026-09 deep review, smell S2): the root pump `_termRoot` ran
 * `runtime.update()` with no try/catch, so a throwing arm crashed the whole dispatch while
 * a Component throw was merely logged — an asymmetry. This drives the path by stubbing
 * runtime.update to throw for one sentinel Msg.
 *
 * Run: node js/test/test-root-reducer-isolation.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const loop = require('../dispatch/runtime/loop');
const runtime = require('../app/runtime');       // === dispatch/update/reducer — what loop.js calls
const eventLog = require('../io/event-log');

describe('[root-isolation] a throwing root-reducer arm is recorded, not propagated', () => {
  sm.bootFresh();

  const realUpdate = runtime.update;
  const realRecord = eventLog.record;
  const errs = [];
  eventLog.record = (type, payload) => { if (type === 'error') errs.push(payload); };
  // Throw only for the sentinel Msg; delegate everything else so boot-adjacent
  // dispatches still work.
  runtime.update = (model, msg) => {
    if (msg && msg.type === '__boom__') throw new Error('kaboom');
    return realUpdate(model, msg);
  };

  const before = runtime.getModel();
  let threw = false;
  try { loop.applyMsg({ type: '__boom__' }); } catch (_) { threw = true; }

  runtime.update = realUpdate;
  eventLog.record = realRecord;

  it('applyMsg does not propagate the reducer throw', () => assert(!threw, 'no throw escaped applyMsg'));
  it('the model is left unchanged (the bad Msg is a no-op)', () => {
    assert(runtime.getModel() === before, 'model reference unchanged');
  });
  it('the error is recorded as root_update with the Msg type', () => {
    const rec = errs.find((e) => e && e.where === 'root_update');
    assert(rec, 'a root_update error was recorded');
    if (rec) eq(rec.msgType, '__boom__', 'records the offending Msg type');
  });
});

report();
