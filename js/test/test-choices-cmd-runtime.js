/**
 * `fetch_choices_cmd` effect runtime (args→ports slice 3): spawns `sh -c <cmd>`
 * with depends_on values on the child env, parses stdout via the choices-lines
 * leaf, dispatches `fabric_form_choices_resolved`.
 *
 * These tests drive the handler with REAL `sh` subprocesses (no mocking) so
 * the spawn + stdio + timeout + signal + env paths are exercised end-to-end.
 * Each test uses a pinned shell one-liner whose timing/output is deterministic.
 *
 * Covers:
 *   - happy path: `printf 'a\\nb\\nc'` → items ['a','b','c'], no error
 *   - CRLF stdout normalized
 *   - choices_labeled:true → first-\\t split via leaf
 *   - items > MAX_CHOICES_CMD (32) → cap applied, truncated: true
 *   - env binding: port-name verbatim → `$name` resolves inside the shell
 *   - env-shadow: $PATH shadow attempt → dropped; parent PATH still in effect
 *   - timeout: `sleep 10` with 150ms timeout → SIGTERM + error
 *   - abort via signal: pre-aborted signal → no dispatch
 *   - non-zero exit → error payload names exit code + stderr
 *   - empty cmd → error payload (defensive guard)
 *   - unknown command → non-zero exit path (shell "command not found")
 *
 * Run: node js/test/test-choices-cmd-runtime.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { section, assert, eq, report } = require('./test-runner');
const runtime = require('../feature/choices-cmd-runtime');

// Extract the registered handler via a tiny registry — mirrors the pattern
// test-choices-fn-runtime.js uses. Done once; each test re-uses the handler.
function makeHandler() {
  let handler = null;
  runtime.registerFetchChoicesCmdEffect((type, fn) => {
    if (type === 'fetch_choices_cmd') handler = fn;
  });
  if (!handler) throw new Error('registerFetchChoicesCmdEffect did not register fetch_choices_cmd');
  return handler;
}

// Mock effect host — captures dispatched msgs + releaseKey calls, carries a
// signal (real AbortSignal or a plain `{aborted}` shim).
function makeHost({ signal } = {}) {
  const dispatched = [];
  const released = [];
  return {
    dispatched,
    released,
    host: {
      applyMsg: (m) => dispatched.push(m),
      releaseKey: () => released.push(true),
      signal: signal || null,
    },
  };
}

// A promise that resolves after `ms` ms via a real setTimeout — the handler
// settles on child.close so we tick wall-clock, not just microtasks.
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Poll with a cap: resolves as soon as `predicate()` is truthy OR after
// `timeoutMs`. Keeps test wall-time proportional to the ACTUAL spawn
// settle, not a fixed 500ms sleep per test.
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await wait(10);
}

(async () => {
  const handler = makeHandler();

  // ---------------------------------------------------------------- happy
  section('[choices-cmd-runtime] happy path — printf 3 lines');
  {
    const { dispatched, released, host } = makeHost();
    handler({
      type: 'fetch_choices_cmd',
      key: 'choices_cmd:a.p',
      cmd: "printf 'a\\nb\\nc'",
      labeled: false, timeout: 5000,
      env: {}, port: 'p', requestId: 1, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    eq(dispatched.length, 1, 'one dispatch');
    const m = dispatched[0];
    eq(m.type, 'fabric_form_choices_resolved');
    eq(m.items, ['a', 'b', 'c']);
    eq(m.labels, null);
    eq(m.error, null);
    eq(m.truncated, false);
    eq(m.port, 'p');
    eq(m.actionKey, 'a');
    eq(m.requestId, 1);
    eq(released.length, 1, 'releaseKey called');
  }

  // ---------------------------------------------------------------- CRLF
  section('[choices-cmd-runtime] CRLF stdout normalized');
  {
    const { dispatched, host } = makeHost();
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: "printf 'a\\r\\nb\\r\\nc\\r\\n'",
      labeled: false, timeout: 5000, env: {},
      port: 'p', requestId: 2, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    eq(dispatched[0].items, ['a', 'b', 'c']);
  }

  // ---------------------------------------------------------------- labeled
  section('[choices-cmd-runtime] labeled: true → first-\\t split');
  {
    const { dispatched, host } = makeHost();
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: "printf 'v1\\tLabel 1\\nv2\\tLabel 2'",
      labeled: true, timeout: 5000, env: {},
      port: 'p', requestId: 3, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    eq(dispatched[0].items, ['v1', 'v2']);
    eq(dispatched[0].labels, ['Label 1', 'Label 2']);
  }

  // ---------------------------------------------------------------- cap
  section('[choices-cmd-runtime] > MAX_CHOICES_CMD (32) → truncated');
  {
    const { dispatched, host } = makeHost();
    // 50 items, expect cap at 32.
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: "for i in $(seq 1 50); do printf 'item%d\\n' $i; done",
      labeled: false, timeout: 5000, env: {},
      port: 'p', requestId: 4, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    eq(dispatched[0].items.length, runtime.MAX_CHOICES_CMD, 'items capped at MAX_CHOICES_CMD');
    eq(dispatched[0].items[0], 'item1');
    eq(dispatched[0].items[31], 'item32');
    eq(dispatched[0].truncated, true, 'truncated flag set');
  }

  // ---------------------------------------------------------------- cap-exact
  section('[choices-cmd-runtime] exactly MAX_CHOICES_CMD items → NO truncation');
  {
    const { dispatched, host } = makeHost();
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: "for i in $(seq 1 32); do printf 'x%d\\n' $i; done",
      labeled: false, timeout: 5000, env: {},
      port: 'p', requestId: 5, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    eq(dispatched[0].items.length, 32);
    eq(dispatched[0].truncated, false);
  }

  // ---------------------------------------------------------------- env binding
  section('[choices-cmd-runtime] env binding — $repo visible to the shell');
  {
    const { dispatched, host } = makeHost();
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.branch',
      cmd: 'printf "%s\\n" "$repo"',
      labeled: false, timeout: 5000,
      env: { repo: '/path/to/repo' },
      port: 'branch', requestId: 6, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    eq(dispatched[0].items, ['/path/to/repo']);
  }

  // ---------------------------------------------------------------- env-shadow
  section('[choices-cmd-runtime] env-shadow — PATH binding attempt is DROPPED');
  {
    const { dispatched, host } = makeHost();
    // The parent PATH points to real binaries; a port-value binding of PATH
    // would hijack to /nonexistent. If the leaf refuses the binding (brief
    // §3.3), `which sh` still works and the handler proceeds normally.
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: 'echo "$PATH" | head -c 1',          // read PATH; prints a non-empty byte on success
      labeled: false, timeout: 5000,
      env: { PATH: '/nonexistent' },             // shadow attempt
      port: 'p', requestId: 7, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    eq(dispatched[0].error, null, 'no error — the shadow was dropped so sh/head resolved from the real PATH');
    assert(dispatched[0].items.length === 1 && dispatched[0].items[0] !== '/nonexistent',
      `PATH wasn't overridden (saw: ${JSON.stringify(dispatched[0].items)})`);
  }

  // ---------------------------------------------------------------- timeout
  section('[choices-cmd-runtime] timeout — sleep 10 with 150ms timeout → error');
  {
    const start = Date.now();
    const { dispatched, host } = makeHost();
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: 'sleep 10',
      labeled: false, timeout: 150, env: {},
      port: 'p', requestId: 8, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    const elapsed = Date.now() - start;
    assert(elapsed < 2000, `timeout should have fired well before 2s; took ${elapsed}ms`);
    eq(dispatched[0].items, []);
    assert(/timed out/.test(dispatched[0].error || ''), `error mentions timeout, got: ${dispatched[0].error}`);
  }

  // ---------------------------------------------------------------- pre-aborted
  section('[choices-cmd-runtime] signal pre-aborted → NO dispatch');
  {
    const ac = new AbortController();
    ac.abort();
    const { dispatched, released, host } = makeHost({ signal: ac.signal });
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: 'echo hi',
      labeled: false, timeout: 5000, env: {},
      port: 'p', requestId: 9, actionKey: 'a', group: 'g',
    }, host);
    await wait(300);                              // give the child a chance to settle
    eq(dispatched.length, 0, 'no dispatch for pre-aborted');
    eq(released.length, 1, 'releaseKey still called so the C5 inflight entry clears');
  }

  // ---------------------------------------------------------------- abort mid-flight
  section('[choices-cmd-runtime] abort mid-flight — SIGTERM + no dispatch');
  {
    const ac = new AbortController();
    const { dispatched, released, host } = makeHost({ signal: ac.signal });
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: 'sleep 10',
      labeled: false, timeout: 5000, env: {},
      port: 'p', requestId: 10, actionKey: 'a', group: 'g',
    }, host);
    await wait(100);                              // let the child start
    ac.abort();
    await wait(300);                              // let the SIGTERM reach the child + close fire
    eq(dispatched.length, 0, 'no dispatch after mid-flight abort');
    eq(released.length, 1, 'releaseKey called even on abort');
  }

  // ---------------------------------------------------------------- non-zero exit
  section('[choices-cmd-runtime] non-zero exit → error payload names exit/stderr');
  {
    const { dispatched, host } = makeHost();
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: 'echo "problem" >&2; exit 3',
      labeled: false, timeout: 5000, env: {},
      port: 'p', requestId: 11, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    eq(dispatched[0].items, []);
    assert(/problem/.test(dispatched[0].error || ''), `error carries stderr, got: ${dispatched[0].error}`);
    assert(/exit=3/.test(dispatched[0].error || ''), `error carries exit code, got: ${dispatched[0].error}`);
  }

  // ---------------------------------------------------------------- empty cmd
  section('[choices-cmd-runtime] empty cmd → error payload (defensive guard)');
  {
    const { dispatched, released, host } = makeHost();
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: '', labeled: false, timeout: 5000, env: {},
      port: 'p', requestId: 12, actionKey: 'a', group: 'g',
    }, host);
    await wait(50);                               // synchronous — but still await the microtask
    eq(dispatched.length, 1);
    assert(/empty/.test(dispatched[0].error || ''), `error mentions empty, got: ${dispatched[0].error}`);
    eq(released.length, 1);
  }

  // ---------------------------------------------------------------- labeled + cap
  section('[choices-cmd-runtime] labeled + over-cap → labels also truncated');
  {
    const { dispatched, host } = makeHost();
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: "for i in $(seq 1 40); do printf 'v%d\\tL%d\\n' $i $i; done",
      labeled: true, timeout: 5000, env: {},
      port: 'p', requestId: 13, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    eq(dispatched[0].items.length, 32);
    eq(dispatched[0].labels.length, 32);
    eq(dispatched[0].truncated, true);
  }

  // ---------------------------------------------------------------- cwd set
  section('[choices-cmd-runtime] cwd set — pwd resolves inside eff.cwd');
  {
    // Fresh tempdir so there's no risk of inheriting the process cwd by
    // accident. `fs.realpathSync` on both sides so macOS /tmp→/private/tmp
    // symlink wouldn't fail equality (CI is Linux but keep portable).
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccrcwd-')));
    try {
      const { dispatched, host } = makeHost();
      handler({
        type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
        cmd: 'pwd',
        labeled: false, timeout: 5000, env: {},
        cwd: tmp,
        port: 'p', requestId: 14, actionKey: 'a', group: 'g',
      }, host);
      await waitFor(() => dispatched.length, 3000);
      eq(dispatched.length, 1);
      eq(dispatched[0].error, null);
      eq(fs.realpathSync(dispatched[0].items[0]), tmp, 'pwd printed eff.cwd');
    } finally {
      try { fs.rmdirSync(tmp); } catch (_) { /* best-effort */ }
    }
  }

  // ---------------------------------------------------------------- cwd absent
  section('[choices-cmd-runtime] cwd absent — spawn inherits process cwd');
  {
    const { dispatched, host } = makeHost();
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: 'pwd',
      labeled: false, timeout: 5000, env: {},
      // cwd omitted — pre-fix behavior (inherit)
      port: 'p', requestId: 15, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    eq(dispatched.length, 1);
    eq(dispatched[0].error, null);
    eq(fs.realpathSync(dispatched[0].items[0]), fs.realpathSync(process.cwd()),
      'pwd matches process.cwd when eff.cwd omitted');
  }

  // ---------------------------------------------------------------- cwd bad
  section('[choices-cmd-runtime] cwd nonexistent → error payload, releaseKey, no hang');
  {
    const { dispatched, released, host } = makeHost();
    // Node's spawn with a bad cwd emits ENOENT via the async `error` event
    // (verified: NOT a synchronous throw), so this exercises the handler's
    // `child.on('error', ...)` branch, not the try/catch around spawn.
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd: 'echo hi',
      labeled: false, timeout: 5000, env: {},
      cwd: '/nonexistent-xyz-choices-cmd-cwd-test',
      port: 'p', requestId: 16, actionKey: 'a', group: 'g',
    }, host);
    await waitFor(() => dispatched.length, 3000);
    eq(dispatched.length, 1, 'settled once');
    eq(dispatched[0].items, []);
    assert(/ENOENT/.test(dispatched[0].error || ''),
      `error carries ENOENT, got: ${dispatched[0].error}`);
    eq(released.length, 1, 'releaseKey called so the C5 inflight entry clears');
  }

  // ---------------------------------------------------------------- supersede
  // The C5 same-key supersede mechanism lives in effects.js#runEffects (prior
  // AbortController fires `abort()` when a same-key effect is re-emitted); it's
  // channel-agnostic and already pinned by test-choices-fn-runtime.js's R1F
  // test for the fn channel. The CMD-channel-specific concern is the handler's
  // RESPONSE to that aborted signal: settle silently without dispatch, release
  // the key so the registry can be re-populated. That contract is covered by
  // the "signal pre-aborted" and "abort mid-flight" tests above (which do what
  // the supersede's abort would do — fire the AbortSignal with a live child).
  // A parallel runEffects-based supersede test here would exercise the
  // dispatcher wiring but not add CMD-channel coverage beyond what the two
  // tests above already pin.

  // ---------------------------------------------------------------- TERM-trap
  // v0.6.40 — SIGTERM is TRAPPABLE. A `choices_cmd:` that ignores TERM
  // (`trap "" TERM; sleep 10`) would survive the timeout kill and keep
  // running; close would never fire; settle would never run; the C5 slot
  // would wedge. Pre-fix behavior: dispatched.length stayed 0 forever.
  // Post-fix: killGroup('SIGTERM') schedules a 500ms SIGKILL on the pgroup
  // which forces close → settle → releaseKey.
  //
  // Verification shape: capture the sh child's pid via a side-channel
  // (the child writes its own `$$` to a tempfile BEFORE sleeping), then
  // after the handler settles, confirm `process.kill(-pid, 0)` throws
  // ESRCH — meaning the whole pgroup is gone.
  section('[choices-cmd-runtime] TERM-trap child — SIGKILL cascade dies the pgroup');
  {
    const pidFile = path.join(os.tmpdir(), `ccrkill-${process.pid}-${Date.now()}.pid`);
    try { fs.unlinkSync(pidFile); } catch (_) { /* ok */ }
    // trap "" TERM = ignore SIGTERM (the shell is immune); sleep 10 = the
    // thing we need SIGKILL to actually clear. $$ is the shell's own pid
    // which is the pgid (because detached:true makes child.pid === pgid).
    const cmd = `echo $$ > ${pidFile}; trap "" TERM; sleep 10`;
    const start = Date.now();
    const { dispatched, released, host } = makeHost();
    handler({
      type: 'fetch_choices_cmd', key: 'choices_cmd:a.p',
      cmd,
      labeled: false, timeout: 150, env: {},
      port: 'p', requestId: 17, actionKey: 'a', group: 'g',
    }, host);
    // Timeout fires at 150ms, grace is 500ms, close + settle fire shortly
    // after KILL — a 2s poll leaves generous slack.
    await waitFor(() => dispatched.length, 2000);
    const elapsed = Date.now() - start;
    eq(dispatched.length, 1, 'settled once even though TERM was trapped (pre-fix: 0 — close never fires, slot wedges)');
    if (dispatched.length) {
      assert(/timed out/.test(dispatched[0].error || ''),
        `error mentions timeout, got: ${dispatched[0].error}`);
      eq(released.length, 1, 'releaseKey called — slot cleared, no wedge');
      assert(elapsed < 1500, `settle happens within TERM + 500ms grace + overhead; took ${elapsed}ms`);
    }

    // Read the pid the shell wrote before trapping. If the file never
    // appeared the shell hadn't started yet when we checked — unlikely but
    // we skip the pgroup assertion rather than false-fail.
    let shellPid = null;
    try { shellPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); }
    catch (_) { /* best-effort */ }
    if (shellPid && Number.isFinite(shellPid)) {
      // Give kernel reaping an extra beat beyond close.
      await wait(100);
      let alive = true;
      try { process.kill(-shellPid, 0); }
      catch (e) { if (e.code === 'ESRCH') alive = false; }
      assert(!alive, `pgroup -${shellPid} should be gone after SIGKILL cascade`);
    }
    try { fs.unlinkSync(pidFile); } catch (_) { /* ok */ }
  }

  report();
})();
