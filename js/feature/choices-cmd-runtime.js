/**
 * Runtime for shell-backed port choices (`choices_cmd:` in YAML, args→ports
 * slice 3).
 *
 * Owns the `fetch_choices_cmd` effect: spawns `sh -c <cmd>` with the port's
 * `depends_on:` values bound onto the child env (same env-shadow denylist as
 * action `script:`), collects stdout, splits via the `choices-lines` leaf,
 * caps at MAX_CHOICES_CMD (= 32, see UX principle below), and dispatches
 * `fabric_form_choices_resolved` back through applyMsg — the SAME reducer
 * arm `fetch_choices` resolves into, so the arm doesn't branch on which
 * channel the choices came from.
 *
 * Why 32 (not 1024 like choices_fn):
 *   Humans realistically scan ≤ ~32 items; past that the author's command
 *   is mis-shaped and must narrow at the shell (`grep`, `head`, filter).
 *   The cap is a signal to the AUTHOR to tighten the command, not an
 *   invitation for the user to scroll — the popover paints a trailing
 *   `[+more…]` row when the cap applies. slice-2 `choices_fn:`'s 1024
 *   cap stays unchanged for backcompat; a future ticket may align them.
 *
 * Trust model:
 *   Same bar as action `script:` — if you can author the YAML you already
 *   have arbitrary shell. The env-shadow denylist (filterShadowedPortValues
 *   from action-runner) is enforced on the child env; a port named `PATH`
 *   or `LD_PRELOAD` is refused as a hijack class even here, same as the run
 *   path (parser warns at load; this is defense-in-depth at spawn).
 *
 * Timeout:
 *   Default 5000 ms (brief §3); overridable per-port via `choices_timeout:`
 *   on the YAML. Expiry sends SIGTERM; the handler resolves with a timeout
 *   error so the user sees `[timeout]` in the popover. Free-type always
 *   wins — the user can still type a value even on timeout.
 *
 * Replay-determinism (mirrors choices-fn-runtime):
 *   This handler is skipped on replay (runEffects early-returns under
 *   replay.isReplaying()); the recorded `fabric_form_choices_resolved` Msg
 *   replays verbatim with its captured items/labels/error. The shell never
 *   re-runs on replay — the recorded Msg is the source of truth.
 *
 * Stale-reply guard:
 *   Each fetch carries the same monotonic `requestId` the reducer attaches;
 *   a reply whose requestId no longer matches is dropped by the reducer arm
 *   (see fabric-form.js `fabric_form_choices_resolved`). The C5 keyed-effect
 *   registry aborts the prior spawn on dep change / submit / cancel.
 *
 * Observability:
 *   Every error path writes a `diag-log.error('choices_cmd', …)` entry so
 *   authors can trace shell failures in `:diag`. The `[error]` / `[timeout]`
 *   chip is UX; diag-log is the trail.
 */
'use strict';

const { spawn } = require('child_process');
const { parseChoicesStdout } = require('../leaves/text/choices-lines');
// Pure leaf — no upward require. The action-runner wraps this same predicate
// in `filterShadowedPortValues`; here we filter directly so feature/ doesn't
// have to require dispatch/.
const { isShadowedEnvName } = require('../leaves/security/env-shadow');

// Items cap — see the file comment for why 32 (not 1024). Trimmed on landing,
// not on allocation (the shell has already materialized its stdout by the
// time we read it); the cap only prevents it from reaching the WAL / overlay.
const MAX_CHOICES_CMD = 32;

// Hard ceiling on stdout bytes — stops a buggy or hostile command (`cat
// /dev/urandom`, `find /`) from pinning memory before we even reach the
// splitter. 1 MiB is >> MAX_CHOICES_CMD × a long line (even 32 × 1024 chars
// = 32 KiB), so the cap is defensive, not a UX ceiling. On overflow we
// kill the child and resolve with an error.
const MAX_STDOUT_BYTES = 1024 * 1024;

// Hard ceiling on timeout — matches parser's MAX_CHOICES_TIMEOUT so a Msg
// hand-built with a huge timeout (bypassing the parser) can't wedge the
// effect key forever. Belt-and-suspenders.
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 5000;

const EMPTY_RESOLVE = { items: [], labels: null, error: null, truncated: false };

function _diagError(code, message) {
  try { require('../io/diag-log').error(code, message); }
  catch (_) { /* diag-log unavailable (CLI mode, early boot) — chip is primary */ }
}

/**
 * Register the `fetch_choices_cmd` effect handler. Called from
 * installBuiltins() in dispatch/runtime/effects.js, sibling of the
 * `fetch_choices` registration.
 *
 * eff shape (built in the reducer, consumed here):
 *   { type: 'fetch_choices_cmd', key, cmd, labeled, timeout, env, cwd,
 *     port, requestId, actionKey, group }
 */
function registerFetchChoicesCmdEffect(registerEffect) {
  registerEffect('fetch_choices_cmd', (eff, host) => {
    const dispatchResolved = (payload) => {
      host.applyMsg({
        type: 'fabric_form_choices_resolved',
        port: eff.port,
        actionKey: eff.actionKey,         // cross-form stale-reply guard
        requestId: eff.requestId,
        items: payload.items,
        labels: payload.labels,
        error: payload.error,
        truncated: !!payload.truncated,
      });
    };

    // Validate the Cmd shape — a hand-built Msg (test harness, future
    // Component) must not crash the handler. Treat any shape violation as
    // an error payload so the field paints `[error]` instead of hanging in
    // `[fetching…]` forever.
    const cmd = eff && typeof eff.cmd === 'string' ? eff.cmd : '';
    if (!cmd || !cmd.trim()) {
      const msg = 'empty or non-string choices_cmd';
      _diagError('choices_cmd.empty_cmd', `${eff.actionKey}.${eff.port}: ${msg}`);
      dispatchResolved({ ...EMPTY_RESOLVE, error: msg });
      host.releaseKey();
      return;
    }

    // Env binding — port name → env var verbatim (brief §3.3). Only string
    // values are bound. Shadow-named deps (`PATH`, `LD_PRELOAD`, …) are
    // dropped here as defense-in-depth against a Msg built outside the
    // parser (test harness, future Component) that bypassed the load-time
    // env-shadow refusal.
    //
    // `!Array.isArray` guard: `typeof [] === 'object'`, so a Msg with
    // `env: [null, 'x']` would otherwise reach `Object.entries` and bind
    // numeric index keys as env vars (`$0`, `$1`). No security impact (the
    // shadow denylist still applies) but a surprising surface.
    const rawEnv = (eff.env && typeof eff.env === 'object' && !Array.isArray(eff.env)) ? eff.env : {};
    const envBindings = {};
    for (const [k, v] of Object.entries(rawEnv)) {
      if (typeof v !== 'string') continue;
      if (isShadowedEnvName(k)) continue;
      envBindings[k] = v;
    }
    const childEnv = { ...process.env, ...envBindings };

    // Timeout clamp — reducer should already have validated; clamp again
    // defensively so a test Msg can't wedge the key.
    let timeoutMs = typeof eff.timeout === 'number' && Number.isFinite(eff.timeout)
      && eff.timeout > 0 && eff.timeout <= MAX_TIMEOUT_MS
      ? Math.floor(eff.timeout) : DEFAULT_TIMEOUT_MS;

    const labeled = !!eff.labeled;

    // cwd parity with script: (stream.js:339 / action-runner.js:239) — project-
    // relative paths in choices_cmd resolve the same way they do in the action
    // the port belongs to. Non-string / empty → inherit (pre-fix behavior; also
    // keeps old WALs' payload shape harmless).
    const cwd = typeof eff.cwd === 'string' && eff.cwd ? eff.cwd : undefined;

    let child;
    try {
      // `detached: true` puts the child in its own process group (pgid === pid).
      // Required so timeout / abort kills can reach grand-children: a shell
      // wrapping a long-running binary (`sh -c 'sleep 10'`) doesn't always
      // exec-replace itself with the binary, so SIGTERM to the SHELL may not
      // propagate to the actual worker. Killing the whole group (via
      // `process.kill(-child.pid, …)` below) covers both cases uniformly.
      // We MUST kill the child on every exit path, which we do — detached
      // doesn't leak because the handler always settles.
      child = spawn('sh', ['-c', cmd], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        ...(cwd ? { cwd } : {}),
      });
    } catch (e) {
      const em = String((e && e.message) || e);
      _diagError('choices_cmd.spawn_throw', `${eff.actionKey}.${eff.port}: ${em}`);
      dispatchResolved({ ...EMPTY_RESOLVE, error: em });
      host.releaseKey();
      return;
    }

    let stdoutLen = 0;
    const stdoutChunks = [];
    let stderrBytes = 0;
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let killTimer = null;

    // Kill the whole process group so grand-children (`sh` → `sleep`) die too.
    // Falls back to a direct child.kill if group-signal throws (ESRCH on
    // already-exited groups). SIGTERM is TRAPPABLE — a `choices_cmd:` that
    // runs `trap "" TERM; sleep 10` would swallow it and the child would
    // keep running until it chose to exit; close never fires → settle never
    // runs → `host.releaseKey()` wedges the slot. So after a SIGTERM we
    // schedule a SIGKILL on the pgroup 500ms later as a hard floor. Cleared
    // in settle so a child that DID die to TERM doesn't get a redundant kill
    // signal after close has already fired.
    const scheduleHardKill = () => {
      if (killTimer || settled) return;
      killTimer = setTimeout(() => {
        killTimer = null;
        if (settled) return;
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (_) {
          try { child.kill('SIGKILL'); } catch (__) { /* already gone */ }
        }
      }, 500);
    };
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); }
      catch (_) {
        try { child.kill(sig); } catch (__) { /* already gone */ }
      }
      if (sig === 'SIGTERM') scheduleHardKill();
    };

    // AbortSignal from the effect host (C5 keyed-effects). A dep change / form
    // cancel / form submit emits cancel_effect which aborts the controller.
    // We respond by SIGTERM-ing the child group; settling runs through the
    // normal close path (which sees `aborted` and resolves silently).
    const onAbort = () => {
      if (settled) return;
      killGroup('SIGTERM');
    };
    if (host.signal) {
      if (host.signal.aborted) {
        // Already aborted before we even spawned — kill immediately and
        // return without dispatching (the key is being replaced).
        onAbort();
      } else {
        host.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Timeout alarm — SIGTERM at expiry; the close handler notices `timedOut`
    // and dispatches a timeout error.
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killGroup('SIGTERM');
    }, timeoutMs);

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (host.signal && !host.signal.aborted) {
        try { host.signal.removeEventListener('abort', onAbort); } catch (_) { /* no-op */ }
      }
      // If the signal fired before we settled (abort path), skip dispatch so
      // we don't write stale items to the WAL. The reducer requestId guard
      // would also drop it, but no-dispatch is cleaner.
      if (host.signal && host.signal.aborted) {
        host.releaseKey();
        return;
      }
      dispatchResolved(payload);
      host.releaseKey();
    };

    child.stdout.on('data', (buf) => {
      // Overflow check runs BEFORE push so the first overshooting chunk is
      // dropped too — otherwise `stdoutLen > MAX` fires AFTER a push already
      // retained the overshoot (up to one buffer, typically 16 KiB past
      // the cap). Minor but the written invariant is "the cap only prevents
      // overshoot bytes from reaching the WAL."
      if (stdoutLen + buf.length > MAX_STDOUT_BYTES) {
        if (!overflowed) {
          overflowed = true;
          killGroup('SIGTERM');
        }
        return;   // drop this chunk + any subsequent
      }
      stdoutLen += buf.length;
      stdoutChunks.push(buf);
    });
    child.stderr.on('data', (buf) => {
      // Keep a small amount of stderr for the diag-log on error. Discarded
      // on success — authors don't need to see stderr noise when the command
      // succeeded. 4 KiB is generous for a one-liner's complaint; truncate
      // past that so a `cat /dev/urandom` on stderr can't bloat the diag.
      if (stderrBytes >= 4096) return;
      stderrChunks.push(buf);
      stderrBytes += buf.length;
    });

    child.on('error', (e) => {
      // spawn-level failure (e.g. ENOENT on `sh`). Rare in practice; path to
      // handle for test coverage and belt-and-suspenders.
      const em = String((e && e.message) || e);
      _diagError('choices_cmd.spawn_error', `${eff.actionKey}.${eff.port}: ${em}`);
      settle({ ...EMPTY_RESOLVE, error: em });
    });

    child.on('close', (code, signal) => {
      if (overflowed) {
        const em = `choices_cmd output exceeded ${MAX_STDOUT_BYTES} bytes — killed`;
        _diagError('choices_cmd.overflow', `${eff.actionKey}.${eff.port}: ${em}`);
        settle({ ...EMPTY_RESOLVE, error: em });
        return;
      }
      if (timedOut) {
        const em = `choices_cmd timed out after ${timeoutMs}ms`;
        _diagError('choices_cmd.timeout', `${eff.actionKey}.${eff.port}: ${em}`);
        settle({ ...EMPTY_RESOLVE, error: em });
        return;
      }
      // Non-zero exit (including signal termination that WASN'T our abort) —
      // report as error. The signal path reaches here with code=null; if we
      // didn't initiate the kill (not timedOut / overflowed / aborted), the
      // child died unexpectedly.
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        const hint = signal ? `signal=${signal}` : `exit=${code}`;
        const em = stderr ? `${hint}: ${stderr}` : `choices_cmd exited ${hint}`;
        _diagError('choices_cmd.nonzero_exit', `${eff.actionKey}.${eff.port}: ${em}`);
        settle({ ...EMPTY_RESOLVE, error: em });
        return;
      }
      // Happy path — parse the collected stdout and apply the items cap.
      let items, labels;
      try {
        const parsed = parseChoicesStdout(Buffer.concat(stdoutChunks).toString('utf8'), { labeled });
        items = parsed.items;
        labels = parsed.labels;
      } catch (e) {
        const em = String((e && e.message) || e);
        _diagError('choices_cmd.parse_throw', `${eff.actionKey}.${eff.port}: ${em}`);
        settle({ ...EMPTY_RESOLVE, error: em });
        return;
      }
      let truncated = false;
      if (items.length > MAX_CHOICES_CMD) {
        items = items.slice(0, MAX_CHOICES_CMD);
        if (labels) labels = labels.slice(0, MAX_CHOICES_CMD);
        truncated = true;
      }
      settle({ items, labels, error: null, truncated });
    });
  });
}

module.exports = {
  registerFetchChoicesCmdEffect,
  MAX_CHOICES_CMD,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
};
