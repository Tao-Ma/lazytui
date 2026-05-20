/**
 * Bare-spawn (outside tmux) regression test for type: spawn.
 *
 * The bug this pins: before the fix, the no-tmux branch of doRun()
 * used `spawn(..., { detached: true, stdio: 'ignore' })`. Interactive
 * subprocesses (psql, less, $EDITOR) got /dev/null for stdin/stdout,
 * saw no input, and silently exited — making the action feel like
 * it "had no effect".
 *
 * The fix: outside tmux, the spawn path now suspends the TUI's
 * terminal modes, runs the subprocess SYNCHRONOUSLY with
 * stdio: 'inherit' (so the child gets our actual TTY), then restores
 * the modes and forces a full repaint.
 *
 * This test asserts:
 *   1. spawnSync is called (not the async spawn), with stdio:'inherit'
 *      and the right cwd.
 *   2. suspendTerminal() runs BEFORE the subprocess, resumeTerminal()
 *      runs AFTER.
 *   3. The exit status is reflected in the detail panel — clean exit,
 *      non-zero, signal, and ENOENT-style spawn errors each produce a
 *      distinct message (so "no effect" can never come back).
 *
 * Run: node js/test/test-spawn-bare.js
 */
'use strict';

// --- Mock child_process BEFORE actions.js loads ---
const child_process = require('child_process');
const spawnCalls = [];
const spawnSyncCalls = [];
let nextResult = { status: 0 };
child_process.spawn = (...args) => { spawnCalls.push(args); return { on() {}, kill() {} }; };
child_process.spawnSync = (...args) => { spawnSyncCalls.push(args); return nextResult; };

// --- Mock suspend.js to record the lifecycle ---
const suspend = require('../suspend');
const lifecycle = [];
suspend.suspendTerminal = () => { lifecycle.push('suspend'); };
suspend.resumeTerminal  = () => { lifecycle.push('resume'); };

// --- Mock layout.js so we don't actually try to paint ---
const layout = require('../layout');
let repaints = 0;
layout.forceFullRepaint = () => { repaints++; };
layout.render = () => {};

// --- Mock history.js so we capture the detached flag ---
const history = require('../history');
const historyStarts = [];
history.start = (key, cmd, opts) => { historyStarts.push({ key, cmd, opts }); };

// --- Ensure no TMUX env so we always hit the bare-spawn branch ---
delete process.env.TMUX;

// --- Load the unit under test ---
const { runAction } = require('../actions');
const { S } = require('../state');
S.projectDir = '/tmp/spawn-test-cwd';

const { describe, it, assert, eq, report } = require('./test-runner');

describe('[1] bare-spawn uses spawnSync + stdio:inherit (not detached spawn)', () => {
  it('clean exit (status 0)', () => {
    spawnCalls.length = 0;
    spawnSyncCalls.length = 0;
    lifecycle.length = 0;
    repaints = 0;
    nextResult = { status: 0 };

    runAction('test:psql', { type: 'spawn', script: 'psql' }, []);

    eq(spawnCalls.length, 0, 'async spawn NOT used on bare-spawn path');
    eq(spawnSyncCalls.length, 1, 'spawnSync called exactly once');

    const [bin, argv, opts] = spawnSyncCalls[0];
    eq(bin, 'sh', 'invoked through sh');
    assert(opts.stdio === 'inherit', `stdio is 'inherit' (got ${JSON.stringify(opts.stdio)})`);
    eq(opts.cwd, '/tmp/spawn-test-cwd', 'cwd is S.projectDir');
    assert(!opts.detached, 'NOT detached — must block on child');
  });

  it('terminal is suspended around the subprocess (in that order)', () => {
    eq(lifecycle.join(','), 'suspend,resume',
       'suspendTerminal then resumeTerminal — TUI mode released for the child, then restored');
  });

  it('full repaint forced after child returns', () => {
    assert(repaints >= 1, 'forceFullRepaint called at least once');
  });

  it('history records non-detached (vs the tmux path)', () => {
    const last = historyStarts[historyStarts.length - 1];
    eq(last.opts.detached, false, 'detached:false — we waited for the child');
  });
});

describe('[2] exit status flows into the detail panel', () => {
  // Pulls the detail panel post-action via state.S.detail so we
  // verify the user actually sees what happened.
  it('clean exit → "Exited cleanly"', () => {
    nextResult = { status: 0 };
    runAction('a:ok', { type: 'spawn', script: 'true' }, []);
    assert(S.detailLines.join('\n').includes('Exited cleanly'),
      `detail mentions clean exit (got: ${JSON.stringify(S.detailLines)})`);
  });

  it('non-zero status → "Exited with status N"', () => {
    nextResult = { status: 7 };
    runAction('a:err', { type: 'spawn', script: 'false' }, []);
    assert(S.detailLines.join('\n').includes('Exited with status 7'),
      `detail mentions exit 7 (got: ${JSON.stringify(S.detailLines)})`);
  });

  it('signal → "Exited on signal X"', () => {
    nextResult = { status: null, signal: 'SIGTERM' };
    runAction('a:sig', { type: 'spawn', script: 'sleep 9999' }, []);
    assert(S.detailLines.join('\n').includes('Exited on signal SIGTERM'),
      `detail mentions SIGTERM (got: ${JSON.stringify(S.detailLines)})`);
  });

  it('ENOENT-style failure → "Spawn failed: ..."', () => {
    nextResult = { error: new Error('ENOENT: not found') };
    runAction('a:nox', { type: 'spawn', script: 'nope' }, []);
    assert(S.detailLines.join('\n').includes('Spawn failed'),
      `detail mentions spawn failure (got: ${JSON.stringify(S.detailLines)})`);
    assert(S.detailLines.join('\n').includes('ENOENT'),
      `detail includes the underlying error (got: ${JSON.stringify(S.detailLines)})`);
  });
});

report();
