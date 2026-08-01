/**
 * The unified effect/Cmd channel — the side-effect half of every
 * `update(... , msg) → [..., cmds]` path in the system.
 *
 * One registry, two emitters:
 *   - Root reducer (`runtime.update`) returns Cmd descriptors;
 *     `dispatch.applyMsg` runs them via `runEffects` here.
 *   - Component `update(msg, slice)` returns effect descriptors;
 *     `dispatch/runtime/loop.dispatchMsg` runs them via `runEffects` here.
 *
 * Cmds and effects are the same thing — plain descriptors
 * (`{ type: 'show_selected_info' }`, `{ type: 'msg', msg }`).
 * Handlers register by type;
 * the vocabulary grows as Components register their own (e.g.
 * config-status' cfgStatusCompute). Unknown types are logged, not
 * thrown — a misconfigured Component shouldn't wedge dispatch.
 *
 * The handlers route framework writes back through the reducer
 * (`viewer_set_content` / `focus_set` Msgs) so even effect-driven
 * writes go through update — single writer per layer.
 */
'use strict';

// Replay flag (zero-dependency sibling — safe to top-require; no load cycle).
// Read on the hot runEffects path, so top-require avoids a per-call require().
const replay = require('./replay');

const _handlers = Object.create(null);

function registerEffect(type, fn) {
  if (typeof type !== 'string' || typeof fn !== 'function') {
    throw new Error('registerEffect(type, fn) requires a string type and a function');
  }
  _handlers[type] = fn;
}

// The dispatch HOST handed to every effect handler as its 2nd arg — the
// formalized-injection model (Elmish `Sub = Dispatch -> unit`, Hyperapp
// `(dispatch, props)`). A Component's effect handler (which runs HERE, in the
// dispatch layer, often async/off-tick) feeds Msgs back through this host
// instead of importing `panel/api` upward. Built lazily on first runEffects so
// the requires resolve after boot, never eagerly. dispatchMsg comes from
// `dispatch/runtime/loop` (the Component fan-out's home since B/S6).
// See docs/v0.6.5-dispatch-loop.md "formalize injection".
let _host = null;
function _effectHost() {
  if (!_host) {
    const api = require('../../panel/api');
    const { dispatchMsg } = require('./loop');
    const { applyMsg } = require('../control/dispatch');
    const { wrap } = require('../../panel/route');
    const { streamCommand } = require('./stream');
    const { cleanup } = require('./cleanup');
    const { showHelp } = require('../../overlay/help');
    const rc = require('./record-control');
    _host = {
      dispatchMsg, applyMsg, wrap, streamCommand,
      refreshAll: api.refreshAll, cleanup, showHelp,
      // v0.6.6 replay arc — the record-* cmdline verbs call these through the host.
      recordSave: rc.save, recordLoad: rc.load, recordStop: rc.stop,
      // P1.5 — run an action by its key (the full run path: confirm-gating +
      // fabric input resolution/readiness). Lets the component-ports pane's
      // "Run" trigger the existing dispatch without importing dispatch upward.
      runActionByKey: (key) => require('../control/actions')._runActionByKey(key),
    };
  }
  return _host;
}

// C5 — keyed/exclusive effect cancellation registry. Module-local impure shell
// (NOT model/slice state), so a replay fold — which skips runEffects entirely,
// see the early-return below — never populates or reads it. A keyed effect's
// AbortController lives here until its handler releases the key (its async work
// settled) or a same-key supersede / a teardown aborts it. Complements (never
// duplicates) stream slot-preemption + Sub reconciliation, which own their own
// lifecycles; this only kills the transient subprocess/result of async COMPUTE
// effects that have no slot/Sub machinery.
const _inflight = new Map();   // key → AbortController

function runEffects(effects) {
  if (!Array.isArray(effects)) return;
  // Replay: skip ALL effects. Every effect either re-dispatches a Msg (itself
  // recorded) or does IO whose result returns as a recorded Msg, so the
  // recorded Msg stream alone reconstructs state — re-running here would
  // double-apply. (v0.6.6 replay arc; see ./replay.)
  if (replay.isReplaying()) return;
  const host = _effectHost();
  for (const eff of effects) {
    if (!eff || typeof eff.type !== 'string') continue;
    const fn = _handlers[eff.type];
    if (!fn) {
      console.error(`[effects] no handler for '${eff.type}'`);
      _recordError({ where: 'effects', kind: 'no_handler', effectType: eff.type });
      continue;
    }
    // C5 — a keyed effect is EXCLUSIVE by key: abort any in-flight effect with
    // the same key, then run with a fresh AbortSignal injected on a per-call
    // host that inherits the shared one (so the ~40 sync handlers, which read
    // neither field, are untouched). The handler OWNS release: it calls
    // `host.releaseKey()` when its async work settles/aborts — runEffects can't
    // tell sync-done from async-pending, so it must not auto-release here.
    let callHost = host;
    let keyedAc = null;
    if (eff.key) {
      const prior = _inflight.get(eff.key);
      if (prior) prior.abort();
      keyedAc = new AbortController();
      _inflight.set(eff.key, keyedAc);
      callHost = Object.create(host);
      callHost.signal = keyedAc.signal;
      callHost.releaseKey = () => { if (_inflight.get(eff.key) === keyedAc) _inflight.delete(eff.key); };
    }
    try { fn(eff, callHost); }
    catch (e) {
      // A SYNCHRONOUS throw means the handler never reached its releaseKey() —
      // free the controller here so the key can't wedge `_inflight` forever
      // (which would make a future same-key effect abort a dead controller and
      // a non-quit cancelEffect the only way to recover). Identity-guarded, so
      // it never drops a newer same-key controller a later effect installed.
      if (keyedAc && _inflight.get(eff.key) === keyedAc) _inflight.delete(eff.key);
      console.error(`[effects] '${eff.type}' failed: ${e && e.message}`);
      _recordError({ where: 'effects', kind: 'throw', effectType: eff.type,
        message: e && e.message, stack: e && e.stack });
    }
  }
}

// Abort + drop an in-flight keyed effect (pane teardown / quit / tests). No-op
// if the key isn't live (the common case — most panes have no compute running).
function cancelEffect(key) {
  const ac = _inflight.get(key);
  if (ac) { ac.abort(); _inflight.delete(key); }
}
// Abort + clear ALL in-flight keyed effects (quit teardown; test isolation).
function _clearInflight() { for (const [, ac] of _inflight) ac.abort(); _inflight.clear(); }
function _inflightKeys() { return [..._inflight.keys()]; }   // test-only

// Persist the diagnostic to the event log too — console.error gets
// painted over by the next render, so without this a thrown effect
// (ReferenceError class, same as the T6 handleFilterKey bug) is
// invisible to anyone trying to debug from a recorded session.
// Lazy-require keeps effects.js dep-light + importable from tests.
function _recordError(payload) {
  try { require('../../io/event-log').record('error', payload); }
  catch (_) { /* event-log unavailable — already logged to console */ }
  // Also surface in the diagnostics window (leader e) — event-log is the
  // replay firehose (evicted fast); diag-log persists errors for review.
  try {
    const code = (payload && (payload.kind || payload.where)) || 'error';
    const detail = payload && (payload.message || payload.effectType);
    const msg = payload && payload.where && payload.effectType
      ? `${payload.where}: '${payload.effectType}' ${detail || ''}`.trim()
      : (detail || code);
    require('../../io/diag-log').error(code, msg);
  } catch (_) { /* diag-log unavailable */ }
}

// T28 — cyclic apply_msg / dispatch_msg recursion guard. Both effects
// synchronously re-enter the dispatch pipeline; two Components that
// emit cross-layer Msgs at each other would blow the JS stack without
// any depth bound. No in-tree Component does this today, but the
// contract permits it. Cap at 32 — deep enough for any legitimate
// fan-out cascade (the deepest observed is groups → groups_selected →
// reset_group_context → 3x set_cursor + multisel_clear + clear_filter,
// nesting ~4 deep), shallow enough to fail loudly on a runaway loop.
let _crossLayerDepth = 0;
const _CROSS_LAYER_MAX = 32;
function _enterCrossLayer(kind, eff) {
  if (_crossLayerDepth >= _CROSS_LAYER_MAX) {
    console.error(`[effects] ${kind} recursion depth ${_crossLayerDepth} exceeded ${_CROSS_LAYER_MAX} — dropping (cyclic dispatch_msg / apply_msg between Components?)`);
    _recordError({ where: 'effects', kind: 'recursion_cap', effectType: kind,
      depth: _crossLayerDepth, msgType: eff && eff.msg && eff.msg.type });
    return false;
  }
  _crossLayerDepth++;
  return true;
}
function _exitCrossLayer() { if (_crossLayerDepth > 0) _crossLayerDepth--; }

/** Clear all handlers — test isolation only. */
function clearEffects() { for (const k of Object.keys(_handlers)) delete _handlers[k]; }

/**
 * Register the framework's built-in effect handlers. Called once at boot
 * (tui.js). Module references are cached once here so the hot-path
 * handlers (`render` fires per streamed line via viewer_append; `refresh`
 * per refresh tick) don't re-traverse the require cache on each call.
 * Writes go through the reducer so update stays the single writer.
 */
/**
 * Re-fire the cmdline dropdown rebuild — the guarded variant the feature
 * layer triggers after an async completion fetch resolves (docker dir
 * listing). No-op when cmdline isn't open. Owned here (dispatch) and handed
 * to the feature-host port so feature/open-docker doesn't import dispatch.
 * (Was feature/open-docker.js#_refireCmdlineRebuild.)
 */
function refireCmdlineRebuild() {
  const m = require('../../model/store').getModel();
  if (!m.modes.cmdMode) return;
  const matches = require('../control/cmdline').rebuild(m.modal.cmdline.text);
  require('../control/dispatch').applyMsg({ type: 'cmdline_set_matches', matches });
  require('../../leaves/infra/render-queue').scheduleRender();
}

// Live-agent backend registry: descriptor name → AgentBackend object
// (js/agent/protocol.js). The effect resolves the name so io/agent.js stays
// registry-free (it takes the backend OBJECT).
function _agentBackend(name) {
  if (name === 'mock') return require('../../agent/backends/mock');
  if (name === 'pi') return require('../../agent/backends/pi');
  return null;
}

function installBuiltins() {
  const { getModel } = require('../../model/store');
  const api = require('../../panel/api');
  const renderQueue = require('../../leaves/infra/render-queue');
  // Feature-host seam: feature/ workflows trigger a cmdline rebuild through
  // this injected fn instead of importing dispatch (keeps feature a bottom
  // layer). See hosts/feature-host.js + docs/v0.6.5-render-exit.md.
  require('../../hosts/feature-host').setFeatureHost({ refireCmdlineRebuild });
  // render: request a repaint (async effect results landing into a slice).
  registerEffect('render', () => {
    try { renderQueue.scheduleRender(); } catch (_) { /* no renderer */ }
  });
  // msg: cross-layer Msg dispatch. The payload shape picks the routing:
  // a WRAPPED Msg `{kind, msg}` goes through api.dispatchMsg (Component
  // fan-out — e.g. groups → viewer_reset_chrome → detail); a FLAT Msg
  // goes through dispatch.applyMsg (root reducer — e.g. focus_set /
  // mode_set / terminal_enter). The pre-R4.12 vocabulary had two
  // separate Cmd types (`apply_msg`, `dispatch_msg`) where the type
  // name acted as a routing hint — but the actual routing already
  // looked at `msg.kind`, so the discriminator was duplicated.
  registerEffect('msg', (eff) => {
    if (!_enterCrossLayer('msg', eff)) return;
    try {
      if (eff.msg && eff.msg.kind) require('./loop').dispatchMsg(eff.msg);
      else require('../control/dispatch').applyMsg(eff.msg);
    } finally { _exitCrossLayer(); }
  });
  // select_cancel_all: drop EVERY active text selection — more than one pane
  // can hold one, and a hidden tab's persisted selection counts too: per-tab
  // persistence would otherwise carry it across the group switch and re-own it
  // over whatever content the NEW group loads into that instance
  // (docs/pane-selection.md §Clearing). Selection state lives on instance
  // slices, so the root reducer (reset_group_context) can't clear it directly —
  // it emits this Cmd and the shell sweeps the instance REGISTRY (not the
  // visible panes), routing a wrapped select_cancel to each owner; instance ids
  // stay directly addressable through the wrapped-Msg path, so hidden tabs are
  // reachable. Each dispatch synchronously re-enters the pipeline → counted
  // under the T28 cap like the `msg` effect.
  registerEffect('select_cancel_all', (eff) => {
    for (const own of require('../../panel/select-view').allSelections()) {
      if (!_enterCrossLayer('select_cancel_all', eff)) return;
      try {
        require('./loop').dispatchMsg(require('../../panel/route').wrap(own.instId, { type: 'select_cancel' }));
      } finally { _exitCrossLayer(); }
    }
  });
  // show_selected_info: Component-level access to the framework Cmd that
  // refreshes the focused panel's info into the viewer. detail.update emits
  // this when closing the last content tab so the body falls back to Info.
  // Routes to detail.update's viewer_show_info case — single-writer for the
  // viewer slice through the Component fan-out.
  //
  // v0.6.1 Phase 5 — resolveTarget picks the destination viewer (today:
  // 'detail' singleton; multi-viewer in Phase 6+). null → no viewer
  // registered, drop the Cmd silently.
  registerEffect('show_selected_info', (eff) => {
    // eff.paneId (optional) targets a specific viewer — the pane-tabs
    // tab_switch-to-Info path wants info on THE pane whose tab flipped,
    // not whatever resolveTarget picks (viewer-lines-selector P0).
    try { require('../control/dispatch').showSelectedInfo(eff && eff.paneId); } catch (_) { /* no renderer (test) */ }
  });
  // U2e P4 — open a discrete document as a text-view content tab in the content
  // slot (the reducer-side entry: the jobs job-info card emits this Cmd rather than
  // dispatching viewer_set_content to the retired viewerOverride). Impure-shell
  // callers (help / config-status + history effects) use nav-state.setViewerContent
  // directly; both funnel to the same content-tab mint.
  registerEffect('open_doc_tab', (eff) => {
    try {
      require('../../panel/content-tab').addContentTab(
        getModel().currentGroup, eff.key, eff.label, eff.lines || []);
    } catch (_) { /* no content slot / no renderer (test) */ }
  });
  // diag_clear / diag_save: the diagnostics window's `c` / `s` keys.
  // Buffer mutation + file I/O are side-effects, so the diag_log_clear /
  // diag_log_save reducer arms emit these rather than touching the
  // imperative diag-log buffer themselves.
  registerEffect('diag_clear', () => {
    try { require('../../io/diag-log').clear(); } catch (_) {}
  });
  registerEffect('diag_save', () => {
    try { require('../../io/diag-log').save(); }
    catch (e) { _recordError({ where: 'diag_save', kind: 'throw', message: e && e.message }); }
  });
  // (U2d P2b — the `destroy_pty_session` effect is retired: its only emitter was
  // the viewer's removeEphemeral arm (embedded terminals as content tabs). A
  // `terminal` pane's PTY is now torn down by the orphan-dispose destroySession
  // in app/state.js when the instance leaves the layout.)
  // (FIX-3 Phase 6 — the `tick` (generic self-re-arming-timer Cmd) and
  // `arm_clock` (frame-clock self-re-arm) effects are RETIRED. Recurring work
  // is now a declared `interval` subscription (app/state.js#_subKinds.interval):
  // docker's poll and the frame clock both ride it, and the runtime owns the
  // timer + teardown instead of a Component re-emitting a Cmd. See
  // docs/v0.6.6.md §7 + PRINCIPLES §12.)
  // (#D8 — the `set_theme` effect that synced the leaves/infra/themes palette
  // cache from model.theme is RETIRED. The palette is now projected from
  // model.theme at the render entry (paint.js render(model) → themes.setTheme),
  // a per-frame derivation that replay reproduces — so the frame is replay-safe
  // of the theme without an effect. The reducer's set_theme arm just sets
  // model.theme now; no Cmd.)

  // --- Live-agent session control (Slice A3, docs/live-agent.md) ---
  // Thin io calls into io/agent.js — the transcript/status folds happen in
  // the reducer via the recorded `agent_event` Msgs the wired event handler
  // (host-wiring.wireAgentHost) dispatches back. Effects stay side-effect-only,
  // so replay — which skips runEffects wholesale — never re-spawns a backend;
  // the recorded Msg stream alone reconstructs the pane.
  registerEffect('agent_start', (eff, host) => {
    const name = (eff.cfg && eff.cfg.backend) || '(unset)';
    const backend = _agentBackend(name);
    if (!backend) {
      // Config error at start: surface it IN the pane (fold an error event —
      // same shape a backend error takes) + diag, don't throw.
      require('../../io/diag-log').error('agent', `unknown agent backend '${name}'`);
      host.dispatchMsg(host.wrap(eff.id, {
        type: 'agent_event', evt: { type: 'error', message: `unknown agent backend '${name}'` },
      }));
      return;
    }
    // cwd: the agent operates on the workspace (streamCommand's projectDir
    // posture); an explicit cfg.cwd wins.
    require('../../io/agent').start(eff.id, backend, { cwd: getModel().projectDir, ...(eff.cfg || {}) });
  });
  registerEffect('agent_send', (eff) => {
    require('../../io/agent').send(eff.id, eff.text, eff.opts);
  });
  registerEffect('agent_interrupt', (eff) => {
    require('../../io/agent').interrupt(eff.id);
  });
  // (No agent_stop effect: nothing produces it — pane close goes through
  // io/agent.destroy, quit through stopAll, Esc through agent_interrupt.
  // A Phase-B stop-without-close gesture re-adds it WITH its producer;
  // registry entries stay drive-toward-empty.)

  // --- Root-reducer Cmds ---
  // Emitted by `runtime.update` branches; run from `dispatch.applyMsg` via
  // the same `runEffects` interpreter as Component effects.

  registerEffect('force_full_repaint', () => {
    try { require('../../leaves/infra/render-queue').forceFullRepaint(); } catch (_) {}
  });
  // `_claimed` is the framework-internal sentinel a Component returns from
  // its `key` update to suppress the framework default. The normal path
  // consumes + filters it inside `dispatchKeyToFocused` before runEffects
  // sees it; the no-op here covers tests that call `runEffects` on a raw
  // update return without going through the dispatch entry point.
  registerEffect('_claimed', () => {});
  // do_run / run_action: deferred to the next tick so the input pump's
  // trailing render() paints the overlay-gone frame BEFORE spawn() blocks
  // (preserves the pre-TEA setImmediate-on-commit behavior).
  registerEffect('do_run', (eff) => {
    setImmediate(() => require('./action-runner').doRun(eff.actionKey, eff.action, eff.args));
  });
  registerEffect('run_action', (eff) => {
    setImmediate(() => require('./action-runner').runAction(eff.actionKey, eff.action, eff.args));
  });
  // unrouted_preempt_and_run: fired by confirm_accept when the user
  // confirms "Kill running '<label>'?" on an unrouted-slot collision.
  // Kills the prior stream (emits its "Killed previous:" footer into
  // the viewerStreamBuffer), then starts the new stream.
  registerEffect('unrouted_preempt_and_run', (eff) => {
    setImmediate(() => {
      const stream = require('./stream');
      stream.killJob(eff.existingId, { silent: false });
      stream.streamCommand(eff.headerLabel, eff.cmd, eff.args, eff.opts || {});
    });
  });
  // jobs_route: the second half of jobs_activate (Phase C). jobs_activate
  // closed the overlay and queued the group switch; by the time this effect
  // runs, the preceding set_current_group Cmd in the same batch has committed,
  // so getModel() reflects the POST-switch currentGroup. Read the (now
  // correct) viewer slice to resolve the job's destination tab — a
  // view-derived read that must NOT happen in the pure root reducer
  // (PRINCIPLES §12) — and thread tabIdx / targetKey / fromTabKey into the
  // flat `jobs_routed` Msg, whose reducer arm is pure. Mirrors cmdline_rebuild
  // (the canonical "Cmd that reads then produces a Msg").
  registerEffect('jobs_route', (eff) => {
    const job = eff && eff.job;
    if (!job) return;
    const route = require('../../panel/route');
    const m = getModel();
    // U2e P4 — thread the content SLOT paneId (the column pane) for the focus
    // cascade; `viewerTarget` (the active instance id) is no longer a valid focus
    // target post-P1b. The bg/tmux job-info card mints its own text-view tab
    // (open_doc_tab), so the old fromTabKey view-state capture is retired.
    const viewerPaneId = route.resolveViewerPaneId();
    const groupName = m.currentGroup;
    const out = { type: 'jobs_routed', job, now: eff.now | 0, viewerPaneId, groupName };
    // Jump-to-tab: a job that OWNS a position-tab threads its {paneId, poolId}
    // so the pure jobs_routed arm can set_active_tab + focus without a route
    // read. The owner field carrying the tab-instance id differs by kind
    // (agent → agentId, stream-routed → tabInstId, pty → ptyId); a
    // stream-unrouted job's output lives in the Transcript tab. All resolve to
    // the SAME {column paneId, tab poolId} the jump needs.
    const owner = job.owner || {};
    const jumpInstId = job.kind === 'agent'          ? owner.agentId
                     : job.kind === 'stream-routed'  ? owner.tabInstId
                     : job.kind === 'pty'            ? owner.ptyId
                     : null;
    if (jumpInstId) {
      const inst = route.getInstance(jumpInstId);
      if (inst && inst.paneId) {
        out.jumpPaneId = inst.paneId;
        out.jumpPoolId = require('../../leaves/wm/pane').poolIdOf(jumpInstId);
      }
    } else if (job.kind === 'stream-unrouted') {
      const tj = route.resolveTranscriptTab();
      if (tj) { out.jumpPaneId = tj.paneId; out.jumpPoolId = tj.poolId; }
    }
    require('../control/dispatch').applyMsg(out);
  });
  // copy_commit: resolve the selected copy option's (module-held) content
  // thunk → OSC52, then drop the module options. idx<0 = cancel (just clear).
  registerEffect('copy_commit', (eff) => {
    const copy = require('../../overlay/copy');
    if (eff.idx >= 0) copy.copySelect(eff.idx, eff.label);
    copy.clearOptions();
  });
  // emit_osc52: the register's only effect — mirror a value to the OS
  // clipboard. History mutation already happened in the reducer (model-
  // register leaf); this just writes the escape sequence.
  registerEffect('emit_osc52', (eff) => {
    require('../../io/term').emitOSC52(eff.text);
  });
  // cmdline_rebuild: text changed — re-query the registry from the plugin
  // facade and feed the render-safe projection back through update. The
  // one Cmd that produces a Msg.
  registerEffect('cmdline_rebuild', () => {
    const m = getModel();
    const matches = require('../control/cmdline').rebuild(m.modal.cmdline.text);
    require('../control/dispatch').applyMsg({ type: 'cmdline_set_matches', matches });
  });
  // cmdline_run: invoke the held match at the selected index.
  registerEffect('cmdline_run', (eff) => {
    require('../control/cmdline').runAt(eff.sel, eff.args, eff.display);
  });
  // cmdline_clear: drop the held registry + reset render residue (submit/cancel).
  registerEffect('cmdline_clear', () => { require('../control/cmdline').clear(); });
  // cmdline_preview: drive the live-preview teardown/apply for the selected
  // match. Emitted from cmdline_set_matches + cmdline_nav (any sel change).
  // Generic — the framework knows nothing about themes; entries opt in by
  // exporting `preview: () => () => void` (effect + teardown closure).
  registerEffect('cmdline_preview', (eff) => {
    require('../control/cmdline').previewAtSel(eff.sel);
  });
  // cmdline_revert_preview: call any active teardown without dropping the
  // registry — emitted from cmdline_cancel so Esc restores previewed state.
  registerEffect('cmdline_revert_preview', () => {
    require('../control/cmdline').revertPreview();
  });
  // menu_action: the verb the user picked in the menu. focus_panel carries
  // its hotkey as a suffix; context-menu rows carry an explicit `eff.arg`
  // (e.g. copy_text's text); everything else is a bare handleAction verb.
  registerEffect('menu_action', (eff) => {
    const dispatch = require('../control/dispatch');
    if (eff.action.startsWith('focus_panel:')) dispatch.handleAction('focus_panel', eff.action.split(':')[1]);
    else dispatch.handleAction(eff.action, eff.arg, eff.from);
  });
  // run_binding: a resolved leader leaf. Surface sync throws + async
  // rejections (mirrors the `:` cmdline path) rather than swallowing them.
  registerEffect('run_binding', (eff) => {
    try {
      Promise.resolve(eff.run()).catch(e => console.error('[leader]', e && e.message));
    } catch (e) {
      console.error('[leader]', e && e.message);
    }
  });

  // --- v0.6.7 Phase 3: navigation history (jumplist) -------------------------
  // Two "Cmd that reads then produces a Msg" effects (the jobs_route pattern):
  // the topology/view reads a pure reducer must not do happen HERE, and the
  // result is threaded onto a flat Msg whose reducer arm is pure + recorded
  // (so the WAL fold reproduces model.nav without re-running these effects).

  // nav_capture: a group/focus/tab transition committed — mark a capture
  // pending. The ACTUAL coordinate read + nav_record push is deferred to
  // `flushNavCapture()`, run ONCE at the outermost-dispatch boundary (loop's
  // global depth-0 exit). A single user gesture often cascades across arms
  // (set_current_group + tab_switch + focus_set), each emitting nav_capture; if
  // each pushed immediately the jumplist would gain an intermediate half-state
  // record per arm (one back would only partly reverse the jump). Deferring to
  // the boundary coalesces a same-gesture cascade into ONE record stamped with
  // the FINAL coordinates. Replay-safe: the effect is suppressed during a fold,
  // and the single emitted `nav_record` is what the WAL records + replays.
  registerEffect('nav_capture', () => { _navDirty = true; });

  // nav_restore: a back/forward step resolved to a target location — resolve
  // each stable coordinate to a LIVE address and fire the existing primitive
  // Msgs (set_current_group / focus_set / tab_switch / set_cursor), all stamped
  // noCapture so retracing doesn't push new history. Per-coordinate best-effort
  // (pane/tab/item gone → land on the nearest); a record whose GROUP is gone is
  // the spine missing → prune it and continue the travel in `dir`.
  const navRestoreEff = (eff) => {
    const loc = eff && eff.loc;
    if (!loc) return;
    const dir = eff.dir || 0;
    const route = require('../../panel/route');
    const dispatch = require('../control/dispatch');
    const loop = require('./loop');
    const m = getModel();

    // 404 — group gone (config reloaded / group removed): prune the stale spine
    // record and continue the travel in `dir` onto the next live record.
    if (loc.group && m.config && m.config.groups && !(loc.group in m.config.groups)) {
      dispatch.applyMsg({ type: 'nav_prune', index: m.nav.cursor });
      // After the prune the cursor index is unchanged (clamped). For BACK the
      // older neighbor didn't move, so step again (nav_back keeps the cursor
      // synced). For FORWARD the next record shifted DOWN into the cursor slot,
      // so the cursor ALREADY points at the forward target — re-resolve it in
      // place; stepping again (nav_forward) would overshoot/skip it. Both
      // continuations re-enter this restore, so a run of stale records recurses
      // until a live one (or the ring end).
      if (dir < 0) { dispatch.applyMsg({ type: 'nav_back' }); return; }
      const nm = getModel();
      const c = nm.nav.cursor;
      if (dir > 0 && c >= 0 && c < nm.nav.history.length) navRestoreEff({ loc: nm.nav.history[c], dir: +1 });
      return;
    }

    // 1. group (stable name; no-ops if already current).
    if (loc.group) dispatch.applyMsg({ type: 'set_current_group', name: loc.group, noCapture: true });

    // 2. focus — prefer the exact paneId if it still resolves; else fall back to
    //    the stable TYPE and let layout._resolvePaneIdForFocus pick a live pane.
    if (loc.focus) {
      const arg = route.hasInstance(loc.focus.paneId) ? loc.focus.paneId : loc.focus.type;
      if (arg) loop.dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: arg, skipInfo: true, noCapture: true }));
    }

    // 3. tab — re-activate the captured position-tab by its stable poolId.
    //    set_active_tab no-ops if the tab is gone (a closed content tab) or
    //    already active, and doesn't emit nav_capture, so no re-push guard needed.
    if (loc.tab && loc.tab.tabPoolId) {
      const slotPaneId = route.resolveViewerPaneId();
      if (slotPaneId) loop.dispatchMsg(route.wrap('layout',
        { type: 'set_active_tab', paneId: slotPaneId, tabPoolId: loc.tab.tabPoolId }));
    }

    // 4. sel — find the item by stable id in the CURRENT list; nearest (clamp to
    //    0) if it's gone. set_cursor doesn't push, so no noCapture needed.
    if (loc.sel && loc.sel.panel) {
      const api = require('../../panel/api');
      const b = route.bundle(loc.sel.panel);
      if (b) {
        const items = api.getItems(loc.sel.panel);
        let index = items.findIndex(it => api.idOf(loc.sel.panel, it) === loc.sel.id);
        if (index < 0) index = 0;
        loop.dispatchMsg(route.wrap(b.target, { type: 'set_cursor', panel: loc.sel.panel, index }));
        try { dispatch.showSelectedInfo(); } catch (_) { /* no renderer (test) */ }
      }
    }
  };
  registerEffect('nav_restore', navRestoreEff);
}

// Exposed so boot-wired subscription handlers that AREN'T started by an effect
// (e.g. pty-lifecycle, wired in tui.js#main) get the same injected dispatch host
// the effect runner hands to effect handlers. Effect-STARTED subscriptions
// (docker events) capture the host from their starting handler instead.
function effectHost() { return _effectHost(); }

// --- v0.6.7 nav-history capture coalescing -----------------------------------
// `nav_capture` (emitted by the group/focus/tab transition arms) only sets this
// flag; the real work runs once per outermost dispatch via flushNavCapture(),
// called at loop's global depth-0 exit. This collapses a same-gesture arm
// cascade into a SINGLE jumplist record holding the final coordinates.
let _navDirty = false;

// Read the POST-commit coordinates by STABLE identity (group name, tab
// targetKey, focused-item idOf) and stamp them onto a nav_record Msg. The
// fragile paneId rides along only as a hint behind the stable `type` (the
// restore falls back to type). Module-scope so flushNavCapture() and the loop
// share it; runs at the boundary, so getModel()/getFocus() are fully settled.
function _captureNavLocation() {
  const route = require('../../panel/route');
  const m = require('../../model/store').getModel();
  const focusId = route.getFocus();
  if (focusId == null) return;
  const type = route.instanceKind(focusId);
  const loc = { v: 1, kind: 'loc', group: m.currentGroup || '',
    focus: { paneId: focusId, type: type || null }, tab: null, sel: null };
  if (route.isViewerKind(focusId)) {
    // U2f — focus is on the content slot → capture its ACTIVE position-tab by its
    // stable poolId (deterministic across group switches / re-seeds). The old flat
    // `slice.tab`→resolveTabKey capture retired with the viewer's flat strip; the
    // slot's tabs are position-tabs (info / transcript / minted text-views) now.
    const slotPaneId = route.resolveViewerPaneId();
    const layoutSlice = route.getInstanceSlice('layout');
    const arr = layoutSlice && layoutSlice.arrange;
    const slotLoc = (slotPaneId && arr)
      ? require('../../leaves/wm/pool').findPaneLocation(arr, p => p.paneId === slotPaneId)
      : null;
    if (slotLoc && slotLoc.pane.activeTabId) loc.tab = { tabPoolId: slotLoc.pane.activeTabId };
  } else if (type) {
    // Focus is on a navigator → capture the highlighted item by stable id.
    const api = require('../../panel/api');
    const navState = require('../../panel/nav-state');
    const items = api.getItems(type);
    const item = items[navState.getSel(type)];
    if (item != null) loc.sel = { panel: type, id: api.idOf(type, item) };
  }
  require('../control/dispatch').applyMsg({ type: 'nav_record', loc });
}

// Flush a pending nav capture (called at the outermost-dispatch boundary). The
// nav_record's consecutive-dup no-op (navHist.push) absorbs a capture that
// lands on the current top, so an idempotent gesture pushes nothing.
function flushNavCapture() {
  if (!_navDirty) return;
  _navDirty = false;
  _captureNavLocation();
}

module.exports = { registerEffect, runEffects, clearEffects, installBuiltins, effectHost, _handlers,
  cancelEffect, _clearInflight, _inflightKeys, flushNavCapture };
