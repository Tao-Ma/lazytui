/**
 * Loop trailing-render contract — overlay-compositor migration Release 1
 * (docs/overlay-compositor-migration.md).
 *
 * applyMsg schedules exactly ONE render per top-level dispatch (via the
 * render-queue's debounced scheduleRender), and NESTED dispatches do NOT
 * re-schedule (depth counter gates the call). The guarantee covers the
 * setImmediate-dispatched-applyMsg hazard (Class C in the plan) that
 * reducer arms used to work around with per-arm `force_full_repaint` +
 * `render` Cmds (v0.6.48).
 *
 * We intercept scheduleRender at the render-queue module and count calls.
 * loop.js reads it via lazy property access (same pattern replay-control
 * uses for its `_render` seam), so the swap takes effect without a
 * module reload.
 *
 * The test uses a stub root reducer that always returns `[model, []]`.
 * This isolates the counter from any production Msg that happens to emit
 * a `render` Cmd of its own (clock_tick, *_synced mirror arms), which
 * would double-count against the ambient scheduleRender call we are
 * trying to pin.
 *
 * Run: node js/test/test-loop-schedule.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const renderQueue = require('../leaves/infra/render-queue');
const loop = require('../dispatch/runtime/loop');
const runtime = require('../app/runtime');
const { setModel } = require('../model/store');
const reducer = require('../dispatch/update/reducer');

let _schedCount = 0;
const _origSched = renderQueue.scheduleRender;
renderQueue.scheduleRender = () => { _schedCount++; };

// Stub root reducer — every arm returns [model, []], so the only
// scheduleRender call during a dispatch is the one from loop.js. The
// nested-depth test overrides this stub for one Msg type to re-enter
// applyMsg from inside the reducer.
const _origUpdate = reducer.update;
let _nestedTrigger = null;        // {outerType, innerMsg} | null
reducer.update = (model, msg) => {
  if (_nestedTrigger && msg && msg.type === _nestedTrigger.outerType) {
    loop.applyMsg(_nestedTrigger.innerMsg);     // nested dispatch at depth 2
    return [model, []];
  }
  return [model, []];
};

function freshModel() {
  setModel(runtime.init());
}

describe('[loop-schedule] applyMsg schedules one trailing render per top-level dispatch', () => {
  it('one applyMsg → one scheduleRender()', () => {
    freshModel();
    _schedCount = 0;
    loop.applyMsg({ type: '_test_tick_1' });
    eq(_schedCount, 1, 'exactly one scheduleRender call per top-level applyMsg');
  });

  it('three sequential applyMsg calls → three scheduleRender()', () => {
    freshModel();
    _schedCount = 0;
    loop.applyMsg({ type: '_test_tick_1' });
    loop.applyMsg({ type: '_test_tick_2' });
    loop.applyMsg({ type: '_test_tick_3' });
    eq(_schedCount, 3, 'one scheduleRender per top-level applyMsg');
  });

  it('a reducer that throws still schedules a trailing render (error-isolation path)', () => {
    freshModel();
    _schedCount = 0;
    // Install a one-shot throwing reducer; applyMsg's error-isolation swallows
    // the throw and the finally block must still schedule the trailing render.
    const prev = reducer.update;
    reducer.update = () => { throw new Error('_test_throw_'); };
    try { loop.applyMsg({ type: '_test_throw_msg_' }); }
    finally { reducer.update = prev; }
    eq(_schedCount, 1,
      'scheduleRender fires in the finally block even when the reducer throws');
  });
});

describe('[loop-schedule] nested dispatches do NOT re-schedule', () => {
  it('outer applyMsg containing a nested applyMsg → ONE schedule, not two', () => {
    freshModel();
    _nestedTrigger = { outerType: '_test_outer_', innerMsg: { type: '_test_inner_' } };
    _schedCount = 0;
    loop.applyMsg({ type: '_test_outer_' });
    _nestedTrigger = null;
    eq(_schedCount, 1,
      'nested applyMsg at depth > 0 does not schedule — only the outer depth-0 exit fires');
  });
});

// Restore originals so later test files + the test-runner report path see
// the real scheduler + reducer.
renderQueue.scheduleRender = _origSched;
reducer.update = _origUpdate;
report();
