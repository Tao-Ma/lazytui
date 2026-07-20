/**
 * Action execution — type: run | spawn | background.
 *
 * Streamed output (type: run) lives in stream.js; this module just owns
 * the dispatch and the spawn/background path side effects. Importing
 * stream avoids touching layout, which keeps actions.js cycle-free.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const { appendViewerLines } = require('../../panel/nav-state');
const { streamCommand, killAll } = require('./stream');
const { getInstanceSlice, wrap } = require('../../panel/api');
const { dispatchMsg, applyMsg } = require('./loop');
const { getModel } = require('../../model/store');
const { esc } = require('../../leaves/text/ansi');
const history = require('../../feature/history');
const jobs = require('../../feature/jobs');
const sessionLog = require('../../io/session-log');
// Dataflow fabric (docs/ports-and-wires.md) — a `run:` action resolves its input
// ports and executes as a no-shell argv vector.
const { resolveInputs } = require('../../fabric/resolve');
const { compileCommand, fillCommand } = require('../../fabric/command');
const fabricPorts = require('../../fabric/ports');

// type:spawn uses a real `tmux new-window` ONLY when running under tmux AND we
// are NOT recording. While recording, force the embedded-PTY path even under
// tmux: a tmux window's output is external to the app (never in the WAL), so it
// would not replay — and a recording is meant to replay anywhere, possibly on a
// different host with no tmux. The embedded PTY's output IS captured (the WAL
// side-channel), so the recorded session stays fully replayable + position-
// independent. v0.6.6 replay arc.
function _spawnUsesTmux() { return !!process.env.TMUX && !sessionLog.isEnabled(); }

function runAction(actionKey, action, args = []) {
  // Event log (PRINCIPLES.md §11 + CHANGELOG v0.2.0). Record the user
  // invocation here — at the entry point, before confirm gating —
  // so the log captures "user pressed Enter on action X" once. The
  // doRun() path is the response.
  require('../../io/event-log').record('action', { actionKey, args, type: action.type });
  // Component Msg dispatch (v0.3.0). Action invocations fan out to
  // every Component's update() as an 'action' Msg.
  dispatchMsg({ type: 'action', actionKey, args, actionType: action.type });
  // Gate on action.confirm — show modal y/N overlay; user-confirmed
  // execution re-enters this fn through doRun(). Cancel is a no-op.
  // Re-read getModel() AFTER the dispatchMsg above so a Component
  // action-handler that flipped confirmMode (or any future cross-layer
  // apply_msg) is visible here. Same hazard class as 2be348a.
  if (action.confirm && !getModel().modes.confirmMode) {
    // Stage the confirm through the reducer — `y` re-emits the do_run Cmd
    // (a DATA descriptor, not a closure). Lazy require breaks the
    // dispatch↔actions load cycle; this is "an effect dispatches a Msg".
    require('../control/dispatch').applyMsg({
      type: 'confirm_enter',
      message: action.confirm,
      cmd: { type: 'do_run', actionKey, action, args },
    });
    return;
  }
  doRun(actionKey, action, args);
}

/**
 * POSIX single-quote escape for embedding a string into a shell command
 * line — used only on the tmux-spawn path where we have to interpolate
 * args into a single string handed to `tmux new-window`.
 */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// U2c P1 (docs/one-tab-system.md) — sanitize a hint component into a poolId-safe
// token so the reuse id is a pure function of (group, actionKey).
function _san(s) { return String(s).replace(/[^A-Za-z0-9_-]+/g, '_'); }

/**
 * Ensure the action's output text-view tab exists in the viewer's slot and is the
 * visible tab, then return the stream opts targeting it. Lifecycle: accrete +
 * persist + hint — the tab is minted on first run (keyed by a stable hint-derived
 * poolId `tv-act-<group>-<key>`, so reuse is the mint_tab id-collision no-op),
 * persists across group switches, and is reused (reseeded) on re-run. Focus is
 * handled INSIDE the focus-following mint_tab / set_active_tab arms — a background
 * run shows its output without stealing keyboard focus from another pane.
 *
 * Returns stream opts: `slotKey` (the concurrency/preempt slot — the deterministic
 * per-action id, so distinct actions run concurrently and a re-run preempts its own
 * slot), `tabInstId` (the DISPLAY target — set only when the instance actually
 * exists, so a degenerate no-layout env streams to the viewer's Transcript rather
 * than a void), plus `tabKey`/`groupName` for the jobs owner.
 */
function ensureActionTab(group, actionKey) {
  const route = require('../../panel/route');
  const mpane = require('../../leaves/wm/pane');
  const poolId = `tv-act-${_san(group)}-${_san(actionKey)}`;
  const tabInstId = mpane.newPaneId(poolId);
  const container = route.resolveViewerPaneId();
  if (container) {
    if (!route.getInstance(tabInstId)) {
      dispatchMsg(wrap('layout', {
        type: 'mint_tab', paneId: container, paneType: 'text-view',
        poolId, title: actionKey, hint: { origin: 'action', group, key: actionKey },
      }));
    } else {
      // Re-run → re-activate so the fresh run is visible (no-op if already active).
      dispatchMsg(wrap('layout', { type: 'set_active_tab', paneId: container, tabPoolId: poolId }));
    }
  }
  // slotKey is the stable per-action key (pure function of group+actionKey) — always
  // distinct, independent of whether the display could be minted. The display target
  // is set only if the instance now exists (mint succeeded); otherwise the stream
  // still runs on its own slot but its display falls back to the Transcript.
  const display = route.getInstance(tabInstId) ? tabInstId : null;
  return { slotKey: tabInstId, tabInstId: display, tabKey: actionKey, groupName: group };
}

function doRun(actionKey, action, args = []) {
  // Fabric consumer/producer (decision A): a `run:` action resolves its input
  // ports and runs as a no-shell argv vector. Distinct from the legacy
  // cmd/script shell path below.
  if (action.run) return doRunFabric(actionKey, action);

  // Parser normalizes both YAML `cmd:` and `script:` into `action.script`
  const cmd = action.script || '';
  const actionType = action.type || 'run';

  if (actionType === 'spawn') {
    // Wrap so the temp script removes itself before running the command —
    // works for both the tmux and bare-spawn paths, and survives crashes
    // (the rm runs even if cmd later fails). Args reach the script body
    // as positional params: bare-spawn passes them via argv, tmux path
    // shell-escapes them into the new-window command string.
    const tmp = `/tmp/tui-${process.pid}-${Date.now()}.sh`;
    const body = `#!/bin/sh\nrm -- "$0"\ncd ${getModel().projectDir} && ${cmd}\n`;
    fs.writeFileSync(tmp, body, { mode: 0o700 });
    if (_spawnUsesTmux()) {
      appendViewerLines(`[dim]$ ${esc(actionKey)}[/]\n[yellow]Spawned in new tmux window.[/]`);
      const argStr = args.length ? ' ' + args.map(shQuote).join(' ') : '';
      spawn('tmux', ['new-window', '-n', actionKey, `${tmp}${argStr}; read`], { detached: true, stdio: 'ignore' });
      history.start(actionKey, cmd, { detached: true });
      // Jobs registry — pid=null because the spawn returned is the tmux
      // client which exits immediately after handing off to the server;
      // the actual window lives inside tmux. tmuxWindowName is the
      // durable handle for Phase 4.3+ liveness polling.
      jobs.register({
        kind: 'tmux',
        label: actionKey,
        pid: null,
        owner: { tmuxWindowName: actionKey, cmd },
      });
    } else {
      // Outside tmux: spawn into an embedded PTY tab in the detail
      // panel, auto-zoomed to viewMode='full' so the child gets the
      // whole terminal. Replaces the pre-v0.3.1 suspend/spawnSync/
      // resume dance, which blocked Node's event loop for the
      // child's entire lifetime. The child now runs alongside the
      // TUI: `_` steps back to half/normal layout while the child
      // keeps running; `+` re-zooms; the tab auto-closes on clean
      // exit (terminal.js#onExit → tabs.handleSessionCleanExit).
      // Non-zero exit keeps the tab so the user can read the error,
      // but drops viewMode so the rest of the TUI is reachable.
      // The tmux branch above is still preferred when $TMUX is set —
      // a real OS-level new window beats an in-process tab for
      // long-lived interactive sessions.
      // U2d P1b — mint a `terminal` PANE into the viewer's slot (the position-tab
      // analog of the retired ephemeral content-tab). The PTY id is the tab-instance
      // id; the finalizer spawns it once it's the slot's active tab.
      const route = require('../../panel/route');
      const argStr = args.length ? ' ' + args.map(shQuote).join(' ') : '';
      const group = getModel().currentGroup;
      // The viewer slot (matches the legacy detail-panel placement); fall back to
      // the focused slot when no viewer is placed.
      const container = route.resolveViewerPaneId() || getInstanceSlice('layout').focus;
      if (container) {
        // Reducer-derived poolId (idPrefix `term`, NO Date.now()) → replay-
        // deterministic AND fresh per run, so two spawns of one action open two
        // distinct terminals. The hint tags origin for later tab-groups clustering;
        // it does NOT drive reuse (the fresh poolId means every spawn is new).
        dispatchMsg(wrap('layout', {
          type: 'mint_tab', paneId: container, paneType: 'terminal', idPrefix: 'term',
          title: actionKey, config: { cmd: `${tmp}${argStr}`, label: actionKey },
          hint: { origin: 'spawn', group, key: actionKey },
        }));
        // mint_tab activates the tab but focus-FOLLOWS only a pre-focused slot; the
        // spawner's focus is on the actions/groups list, so focus the terminal
        // explicitly — view_set='full' projects the FOCUSED pane, and terminal_enter
        // captures keystrokes for it. view_set emits force_full_repaint on the
        // normal/half → full transition (no-op when already full).
        dispatchMsg(wrap('layout', { type: 'focus_set', focus: container }));
        dispatchMsg(wrap('layout', { type: 'view_set', mode: 'full' }));
        // terminal_enter is a ROOT-reducer Msg (mode flag), so applyMsg — not
        // dispatchMsg, which fans a WRAPPED Msg out to a Component.
        applyMsg({ type: 'terminal_enter' });
      }
      // T27 / B19 — detached: the embedded PTY's exit lives in terminal.js with no
      // link back to this record, so treat like the tmux spawn (the entry closes
      // immediately; the user scrolls the tab for output).
      history.start(actionKey, cmd, { detached: true });
    }
    return;
  }

  if (actionType === 'terminal') {
    // U2d P2 — a `group.terminals` entry (auto-generated action, api._terminalActions).
    // Opens the configured shell as a REUSED `terminal` pane — the P2.5 docker-exec
    // pattern: mint (a no-op when already open) + set_active_tab (bring a backgrounded
    // one forward) + focus + terminal_enter. No temp-script wrapper (persistent, not a
    // one-shot) and NO full-zoom (matches the legacy YAML-terminal activation). Reused
    // per (group, name) via a stable poolId, so the pane persists across group switches.
    const route = require('../../panel/route');
    const group = getModel().currentGroup;
    const poolId = `term-yaml-${_san(group)}-${_san(actionKey)}`;
    const container = route.resolveViewerPaneId() || getInstanceSlice('layout').focus;
    if (container) {
      const label = action.label || actionKey;
      dispatchMsg(wrap('layout', {
        type: 'mint_tab', paneId: container, paneType: 'terminal', poolId,
        title: label, config: { cmd, label },
        hint: { origin: 'yaml-terminal', group, key: actionKey },
      }));
      dispatchMsg(wrap('layout', { type: 'set_active_tab', paneId: container, tabPoolId: poolId }));
      dispatchMsg(wrap('layout', { type: 'focus_set', focus: container }));
      applyMsg({ type: 'terminal_enter' });
    }
    return;
  }

  if (actionType === 'background') {
    appendViewerLines(`[dim]$ ${esc(actionKey)}[/]\n[yellow]Started in background.[/]`);
    // -- delimiter so $0 = "--", $1 = first arg, $@ = arg list (POSIX).
    const bgProc = spawn('sh', ['-c', cmd, '--', ...args], { cwd: getModel().projectDir, detached: true, stdio: 'ignore' });
    history.start(actionKey, cmd, { detached: true });
    jobs.register({
      kind: 'background',
      label: actionKey,
      pid: bgProc.pid,
      owner: { cmd },
    });
    return;
  }

  // type: run — stream stdout/stderr. action.tab → route into a text-view
  // instance minted/reused in the viewer's slot (U2c P1); tabless → the unrouted
  // Transcript accumulator (viewerStreamBuffer).
  const opts = action.tab ? ensureActionTab(getModel().currentGroup, actionKey) : {};
  streamCommand(actionKey, cmd, args, opts);
}

// Fabric run (docs/ports-and-wires.md). Resolve the consumer's input ports
// against the current model (injects > wire > default), gate on readiness
// (error-and-tell the precise reasons, decision 5), then fill the `run:` argv
// template and stream it with no shell (opts.argv → execve). The DISPLAY routes
// to the component's text-view instance (U2c P1); its RAW output routes separately
// to model.fabric.output[group][name] via opts.fabric (flushed on close) — that is
// what fabric output ports derive from (fabric host componentLines), independent of
// the display buffer. Producers (no input ports) resolve ready immediately. P1
// resolves within the current group.
function doRunFabric(actionKey, action) {
  const model = getModel();
  const group = model.currentGroup;
  const inputs = (action.ports && action.ports.in) || {};

  const { ready, values, missing } = resolveInputs(actionKey, inputs, {
    injects: (model.fabric && model.fabric.injects) || {},
    // config + runtime wires, MERGED by the fabric host — the SAME source the
    // component-ports pane / wire-list resolve against. Reading config-only here
    // would ignore a wire created interactively (the pane's "connect to…" writes
    // model.fabric.wires): the input would show ✓ready in the UI yet resolve as
    // unset at run. listWires() is host-bound to the current group.
    wires: fabricPorts.listWires(),
    portValue: fabricPorts.portValue,
  });
  if (!ready) {
    appendViewerLines(`[dim]$ ${esc(actionKey)}[/]\n` +
      missing.map(m => `[yellow]not ready: ${m.reason}[/]`).join('\n'));
    return;
  }

  let argv;
  try {
    argv = fillCommand(compileCommand(action.run), values);
  } catch (e) {
    // e.g. a list value bound to an EMBEDDED hole (M4) — surface, don't run.
    appendViewerLines(`[dim]$ ${esc(actionKey)}[/]\n[red]${esc(e.message)}[/]`);
    return;
  }
  // cmd string is display/history only; opts.argv is the executed vector. opts.fabric
  // routes the RAW output to model.fabric.output[group][actionKey] for parsing;
  // ensureActionTab routes the DISPLAY to the component's text-view instance.
  streamCommand(actionKey, argv.join(' '), [], {
    ...ensureActionTab(group, actionKey),
    argv, fabric: { group, name: actionKey },
  });
}

// Re-export streaming helpers so existing import sites
// (dispatch.js, plugins/docker.js, cleanup.js) keep working.
module.exports = { runAction, doRun, killAll, streamCommand, _spawnUsesTmux, doRunFabric };
