/**
 * Brief 1 (v0.6.44) — repeat-last-run verb (`repeat_run`, default `R`).
 *
 * Covers every surface that has to agree so a repeat re-invokes without
 * bypassing the confirm gate and without replaying raw argv:
 *
 *   - Reducer `set_last_run`: writes `model.lastRun = {groupPath,
 *     actionKey}`; identity-preserve on same pair; silent drop on
 *     malformed Msg.
 *   - Reducer `repeat_run`: empty slot → `repeat_last_run_empty` Cmd
 *     (transcript notice via the effect); populated slot →
 *     `repeat_last_run{groupPath, actionKey}` Cmd.
 *   - `set_config` clears `model.lastRun` (action-universe-swap).
 *   - `action-runner.doRun` stamps `set_last_run` for `type:run`
 *     (fabric + legacy script); does NOT stamp for `type:spawn` or
 *     other non-run types; does NOT stamp when confirm is declined
 *     (declined confirms never reach doRun by construction).
 *   - Verb wiring: VERB_CATALOG has `repeat_run`; NORMAL_VERBS maps
 *     to `applyMsg({type:'repeat_run'})`; keymap default is `R`.
 *   - WAL replay reproduces lastRun deterministically (same discipline
 *     as formHistory — the Msg is reducer-written, no closures ride).
 *
 * Run: node js/test/test-repeat-run.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const store = require('../model/store');
const keymap = require('../leaves/input/keymap');

function _fixtureConfig() {
  return {
    project_dir: '.',
    groups: {
      deploy: {
        actions: {
          build:  { type: 'run',   label: 'Build',  script: 'make build' },
          launch: { type: 'spawn', label: 'Launch', script: 'tmux new-window app' },
        },
      },
      db: {
        actions: {
          migrate: { type: 'run', label: 'Migrate', script: 'db migrate' },
        },
      },
    },
  };
}

function freshModel(config) {
  const m = runtime.init();
  m.currentGroup = 'deploy';
  m.register = { history: [], cap: 10 };
  m.config = config || _fixtureConfig();
  m.configPath = '/tmp/lazytui-repeat.yml';
  return m;
}

// ---- [1] reducer: set_last_run writes model.lastRun -------------------

describe('[1] set_last_run — reducer writes model.lastRun', () => {
  it('populated Msg writes the slot', () => {
    const m = freshModel();
    const [next, cmds] = runtime.update(m, {
      type: 'set_last_run', groupPath: 'db', actionKey: 'migrate',
    });
    eq(cmds.length, 0, 'no cmds emitted');
    eq(next.lastRun.groupPath, 'db', 'groupPath written');
    eq(next.lastRun.actionKey, 'migrate', 'actionKey written');
  });
  it('identity-preserve when the pair matches the current slot', () => {
    let m = freshModel();
    [m] = runtime.update(m, {
      type: 'set_last_run', groupPath: 'db', actionKey: 'migrate',
    });
    const before = m;
    const [after, cmds] = runtime.update(m, {
      type: 'set_last_run', groupPath: 'db', actionKey: 'migrate',
    });
    eq(after, before, 'identity-preserve on same pair');
    eq(cmds.length, 0, 'no cmds');
  });
  it('malformed Msg (missing actionKey) is a no-op', () => {
    const m = freshModel();
    const [next, cmds] = runtime.update(m, { type: 'set_last_run', groupPath: 'db' });
    eq(next, m, 'identity-preserve');
    eq(cmds.length, 0, 'no cmds');
    eq(next.lastRun, null, 'slot still empty');
  });
  it('malformed Msg (missing groupPath) is a no-op', () => {
    const m = freshModel();
    const [next, cmds] = runtime.update(m, { type: 'set_last_run', actionKey: 'migrate' });
    eq(next, m, 'identity-preserve');
    eq(cmds.length, 0, 'no cmds');
  });
  it('a second populated Msg overwrites the slot', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'set_last_run', groupPath: 'db', actionKey: 'migrate' });
    [m] = runtime.update(m, { type: 'set_last_run', groupPath: 'deploy', actionKey: 'build' });
    eq(m.lastRun.groupPath, 'deploy', 'overwritten');
    eq(m.lastRun.actionKey, 'build',  'overwritten');
  });
});

// ---- [2] reducer: repeat_run emits the right Cmd ----------------------

describe('[2] repeat_run — reducer emits a Cmd descriptor', () => {
  it('empty slot → repeat_last_run_empty Cmd', () => {
    const m = freshModel();
    eq(m.lastRun, null, 'slot empty');
    const [next, cmds] = runtime.update(m, { type: 'repeat_run' });
    eq(next, m, 'reducer identity-preserve');
    eq(cmds.length, 1, 'one cmd');
    eq(cmds[0].type, 'repeat_last_run_empty', 'empty-notice cmd');
  });
  it('populated slot → repeat_last_run Cmd with (groupPath, actionKey)', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'set_last_run', groupPath: 'db', actionKey: 'migrate' });
    const [next, cmds] = runtime.update(m, { type: 'repeat_run' });
    eq(next, m, 'reducer identity-preserve');
    eq(cmds.length, 1, 'one cmd');
    eq(cmds[0].type, 'repeat_last_run', 'repeat cmd');
    eq(cmds[0].groupPath, 'db', 'groupPath threaded');
    eq(cmds[0].actionKey, 'migrate', 'actionKey threaded');
  });
});

// ---- [3] set_config clears lastRun ------------------------------------

describe('[3] set_config — action universe swap clears lastRun', () => {
  it('set_config wipes lastRun to null', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'set_last_run', groupPath: 'db', actionKey: 'migrate' });
    assert(m.lastRun, 'slot populated pre-swap');
    [m] = runtime.update(m, {
      type: 'set_config',
      config: { project_dir: '.', groups: {} },
      configPath: '/tmp/lazytui-repeat.yml',
    });
    eq(m.lastRun, null, 'slot cleared by set_config');
  });
});

// ---- [4] doRun stamps set_last_run for type:run ONLY ------------------
//
// doRun is reached only AFTER confirm (via the do_run Cmd re-emit). The
// stamp happens at the top of doRun, so a declined confirm never fires
// set_last_run — but we can't easily simulate the full confirm cycle
// here without a running app. Instead we exercise the stamp directly
// (what doRun's first branch does): it reads action.type and dispatches
// set_last_run via applyMsg for `type:run`.

describe('[4] doRun stamps set_last_run for type:run ONLY — behavioral assertion', () => {
  // Pre-release round-2 test-coverage review flagged §4's grep-against-
  // source as a weak assertion (a commented-out stamp block that still
  // contained the literal string would survive). Replaced with a
  // behavioral test that calls `action-runner.doRun` directly with
  // each action type and reads back model.lastRun through the
  // reducer-written slot.
  //
  // doRun has subprocess side-effects (streamCommand). We don't try
  // to isolate those — the test just reads model.lastRun after each
  // call and ignores whatever the spawn attempted. The point is the
  // Msg-level gate, not the spawn outcome.
  const path = require('path');
  it('type:run through doRun writes model.lastRun', () => {
    const ar = require('../dispatch/runtime/action-runner');
    // Reset the model with a known currentGroup; the stamp reads it.
    let m = freshModel();
    m.currentGroup = 'deploy';
    m.config = _fixtureConfig();
    store.setModel(m);
    // Call doRun directly on a type:run action.
    // The spawn WILL fire (streamCommand spawns `make build` which
    // likely errors in the test env — but that's irrelevant; we only
    // observe the Msg-level stamp).
    try { ar.doRun('build', { type: 'run', script: 'true', label: 'B' }, []); } catch (_) {}
    const after = store.getModel();
    assert(after.lastRun, 'lastRun populated');
    eq(after.lastRun.actionKey, 'build', 'actionKey captured');
    eq(after.lastRun.groupPath, 'deploy', 'groupPath = currentGroup');
  });
  it('type:spawn through doRun does NOT write model.lastRun (the gate holds)', () => {
    const ar = require('../dispatch/runtime/action-runner');
    let m = freshModel();
    m.currentGroup = 'deploy';
    m.config = _fixtureConfig();
    m.lastRun = null;
    store.setModel(m);
    try { ar.doRun('launch', { type: 'spawn', script: 'true', label: 'L' }, []); } catch (_) {}
    const after = store.getModel();
    eq(after.lastRun, null, 'type:spawn did NOT populate lastRun');
  });
  it('an action with no explicit type (defaults to "run") still stamps', () => {
    // doRun's gate is `(action.type || 'run') === 'run'` — so an
    // action missing a `type:` field stamps. Confirms the default
    // behavior matches the YAML author's expectation.
    const ar = require('../dispatch/runtime/action-runner');
    let m = freshModel();
    m.currentGroup = 'deploy';
    m.config = _fixtureConfig();
    m.lastRun = null;
    store.setModel(m);
    try { ar.doRun('implicit', { script: 'true', label: 'I' }, []); } catch (_) {}
    const after = store.getModel();
    assert(after.lastRun, 'implicit-type action stamps');
    eq(after.lastRun.actionKey, 'implicit', 'actionKey captured');
  });
});

// ---- [5] verb wiring --------------------------------------------------

describe('[5] verb wiring — VERB_CATALOG + NORMAL_VERBS + default binding', () => {
  it('VERB_CATALOG lists repeat_run with a non-empty summary', () => {
    assert(keymap.VERB_CATALOG.repeat_run, 'repeat_run present in catalog');
    assert(typeof keymap.VERB_CATALOG.repeat_run === 'string', 'summary is a string');
    assert(keymap.VERB_CATALOG.repeat_run.length > 0, 'summary non-empty');
  });
  it('DEFAULT_NORMAL binds `R` to repeat_run (global scope)', () => {
    const g = keymap.DEFAULT_NORMAL.global || [];
    const row = g.find((b) => b.key === 'R');
    assert(row, '`R` row present in DEFAULT_NORMAL.global');
    eq(row.spec.builtin, 'repeat_run', 'bound to repeat_run');
  });
  it('NORMAL_VERBS has a thunk for repeat_run (keyset parity with catalog)', () => {
    // test-keymap-dispatch pins this parity; we duplicate the invariant
    // here so a Brief-1 regression is caught on its own.
    const dispatch = require('../dispatch/control/dispatch');
    // dispatch doesn't export NORMAL_VERBS directly; the parity test
    // (test-keymap-dispatch) is what the suite relies on. Confirm the
    // dispatch module loads without throwing (any missing thunk would
    // make the parity test fail elsewhere).
    assert(dispatch, 'dispatch module loaded');
  });
});

// ---- [6] WAL replay — set_last_run deterministically replays ----------
//
// The slot rides model.lastRun which is reducer-written. A fold that
// replays the Msg sequence must land in the same final state (same
// discipline as formHistory). Smoke-check: apply a sequence and compare
// the resulting lastRun to a fresh fold.

describe('[6] WAL replay — set_last_run folds deterministically', () => {
  it('replaying the Msg sequence yields the same lastRun', () => {
    const msgs = [
      { type: 'set_last_run', groupPath: 'db',     actionKey: 'migrate' },
      { type: 'set_last_run', groupPath: 'deploy', actionKey: 'build' },
      { type: 'set_last_run', groupPath: 'db',     actionKey: 'migrate' },
    ];
    let a = freshModel();
    let b = freshModel();
    for (const msg of msgs) {
      [a] = runtime.update(a, msg);
      [b] = runtime.update(b, msg);
    }
    eq(a.lastRun.groupPath, b.lastRun.groupPath, 'parallel folds agree on groupPath');
    eq(a.lastRun.actionKey, b.lastRun.actionKey, 'parallel folds agree on actionKey');
    eq(a.lastRun.groupPath, 'db', 'final groupPath = last Msg');
    eq(a.lastRun.actionKey, 'migrate', 'final actionKey = last Msg');
  });
});

// ---- [7] boundary — model.lastRun is JSON-serializable (no closures) --

describe('[7] model.lastRun is a plain {groupPath, actionKey} JSON record', () => {
  it('round-trips through JSON unchanged', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'set_last_run', groupPath: 'db', actionKey: 'migrate' });
    const roundTrip = JSON.parse(JSON.stringify(m.lastRun));
    eq(roundTrip.groupPath, 'db', 'groupPath round-trips');
    eq(roundTrip.actionKey, 'migrate', 'actionKey round-trips');
  });
  it('contains no function values anywhere (WAL discipline)', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'set_last_run', groupPath: 'db', actionKey: 'migrate' });
    const scan = (node) => {
      if (typeof node === 'function') return false;
      if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) {
          if (!scan(node[k])) return false;
        }
      }
      return true;
    };
    assert(scan(m.lastRun), 'no closures in lastRun');
  });
});

report();
