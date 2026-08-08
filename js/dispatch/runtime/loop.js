/**
 * The Component fan-out pump — the TEA runtime for the Component layer (#D4:
 * renamed from `fanout.js`; this is "the loop", a routing name undersold it).
 *
 * Route a Msg to the right Component instance, run its `update`, run the
 * returned effects. Components return `[slice, effects]` and never call back up;
 * the few async/subscription paths receive dispatch via an injected host (see
 * docs/v0.6.5-dispatch-loop.md "formalize injection"). The once-per-dispatch
 * after-update phase (scroll clamp + viewer innerH + PTY + instance reconcile)
 * was split out to `./finalize` (#D4 — it's the after-update phase, not
 * routing); this file gates it at depth-0 exit via the shared depth counter.
 *
 * v0.6.5 domain-detangle Stage 2-B relocated this here from `panel/api.js`: it
 * is *runtime* code — it belongs in the dispatch layer, ABOVE the Components it
 * drives, not among them. Reads the Component registry from `panel/api`
 * (dispatch→panel, a legal down-edge) and runs effects via `./effects`
 * (intra-dispatch). The root-Msg pump (`applyMsg`) is its twin and now lives in
 * this same file (#D4b co-located the two pumps here; `./dispatch` re-exports
 * `applyMsg`). `applyMsg` does NOT run the finalizer (root Msgs don't move panes);
 * only the Component path here does.
 */
'use strict';

const route = require('../../panel/route');
const { wrap } = route;
const { getModel, setModel } = require('../../model/store');
const runtime = require('../update/reducer');
const { runEffects, flushNavCapture } = require('./effects');
// #D4 — the post-dispatch invariant pass (scroll clamp + viewer innerH + PTY +
// instance reconcile) lives in its own after-update-phase module now; the loop
// only gates it at depth-0 exit. One-way edge: loop → finalize.
const { finalizeDispatch } = require('./finalize');
// Inbound dispatch middleware (C7, v0.6.7) — the ordered link list wrapping every
// Msg entering the loop, before the reducer runs. The WAL recorder + a crash-
// reporter are built-in links (see ./middleware). This replaces the 3 hardcoded
// sessionLog.recordMsg calls that were the only inbound tap. The record link
// self-gates when recording is disabled (the default) and during replay folds, so
// it stays a near-no-op off the record path. v0.6.6 replay arc + v0.6.7 C7.
const mw = require('./middleware');

// Component registry lives in panel/api; read it lazily (the object ref is
// stable — registerComponent mutates it in place) so this module never eagerly
// drags api in at load. Cached after first dispatch (post-boot).
let _comps = null;
function _reg() { return _comps || (_comps = require('../../panel/api')._components()); }

// Broadcast lane — the framework signals that fan out to every Component;
// every Component-specific Msg must arrive wrapped (via wrap()). The `hub`
// broadcast was removed (#D17 — no Component consumed it; hub publishes now
// reach observers only via the onUpdate→render subscription path).
const BROADCAST_TYPES = new Set(['refresh', 'action']);

// Dispatch depth counter: ALL THREE top-level entries (applyMsg + dispatchMsg +
// dispatchKeyToFocused) share it, so effect-chained nested dispatches resolve
// boundary work ONCE, at depth-0 exit. Two boundary concerns ride it:
//   - the after-update phase (scroll clamp + viewer innerH + PTY + instance
//     reconcile, in ./finalize) — comp/key lanes only (root Msgs don't move
//     panes); finalize's own re-entrancy guard skips its set_scroll re-dispatch;
//   - the nav-history capture flush (flushNavCapture) — ALL lanes, since a
//     navigable transition (e.g. boot's root `set_current_group`) can be a
//     top-level root Msg, and a cascade mixes root + comp arms under one
//     gesture. Coalescing at the shared boundary makes one gesture = one record.
// applyMsg is counted but never runs the after-update phase.
let _dispatchDepth = 0;

// ——— The root-Msg pump (#D4b — moved here from control/dispatch.js) ———
//
// applyMsg is the root reducer's driver — the twin of the Component pump
// below. The reducer (`runtime.update`) is pure and returns Cmd DESCRIPTORS;
// the interpreter is `./effects` (shared with the Component path so both run
// through one registry). control/dispatch.js re-exports applyMsg for its
// input-handler ecosystem + the test API, but the loop is its home: this is
// where the two pumps live side by side.
//
// The reducer is pure; the natural source of truth is getModel() (a stale
// captured ref would lose intermediate writes across cascades), so callers pass
// only `msg`. setModel commits the snapshot BEFORE runEffects so cross-layer
// Cmds (apply_msg / dispatch_msg) re-entering the dispatch graph see post-Msg
// state. A root Msg's OWN reducer never moves panes — BUT its EFFECTS can dispatch
// a pane-moving Component Msg (a cmdline verb minting a tab via _host.dispatchMsg:
// `:terminal`, `:text-view`, `:add-column`, …). That nested dispatch runs at depth
// ≥1 so it never hits the depth-0 finalize gate, and applyMsg historically skipped
// the finalizer entirely — orphaning the mint from the per-pane instance reconcile
// + the terminal PTY spawn (both live only in finalizeDispatch). So: track the
// arrange across the OUTERMOST root dispatch and finalize iff it changed under us.
// Gated on the arrange ref → a root Msg that moves nothing (the common case) stays
// finalizer-free, no added cost on the hot root-Msg path.
function _layoutArrange() {
  const ls = route.getInstanceSlice('layout');
  return ls ? ls.arrange : undefined;
}
// Second cheap ref for the same gate class: nav Msgs. A root Msg's effects
// can move a CURSOR at depth ≥1 the same way they can move a pane (the whole
// per-keystroke nav path — nav_select's reducer-emitted set_cursor Cmd — is
// exactly this), and that nested dispatch never hits dispatchMsg's depth-0
// finalize. Without this the keep-in-view scroll clamp ran one GESTURE late
// (the next key-lane dispatch), so walking down past the fold left the
// selected row permanently one row below the window — no visible cursor
// (user-reported 2026-08-05; latent since the finalize/lane split). The ref
// is a counter bumped in the Component pump for every wrapped nav-shaped Msg
// (leaves/wm/nav.isNavMsg — the same predicate the nav reducer keys on), so
// it counts the write at the ONE choke point every origin passes through.
// Unchanged counter → no finalize, no added cost on the hot root-Msg path.
const _mnav = require('../../leaves/wm/nav');
let _navMsgSeq = 0;
function applyMsg(msg) {
  _dispatchDepth++;
  const arrangeBefore = _dispatchDepth === 1 ? _layoutArrange() : undefined;
  const navBefore = _dispatchDepth === 1 ? _navMsgSeq : undefined;
  // The app-global `clock` Sub arms/tears down on `_liveActionStatus(model)` (a
  // running stream job + action_status config), reconciled only by finalize. A
  // job's lifecycle lands via the jobs store-mirror's `jobs_synced` applyMsg —
  // a ROOT-lane Msg that moves neither arrange nor nav, so without this it would
  // NOT finalize, and the live-status clock's arm/teardown would ride on some
  // incidental accompanying dispatch instead of the job change that gates it.
  // `jobs_synced` replaces `model.jobs` wholesale, so a cheap reference compare
  // (no _liveActionStatus recompute on the hot path) catches every job change.
  const jobsBefore = _dispatchDepth === 1 ? getModel().jobs : undefined;
  try { mw.run({ lane: 'root', msg }, _termRoot); }
  finally {
    _dispatchDepth--;
    if (_dispatchDepth === 0) {
      flushNavCapture();
      if ((arrangeBefore !== undefined && _layoutArrange() !== arrangeBefore)
        || (navBefore !== undefined && _navMsgSeq !== navBefore)
        || (jobsBefore !== undefined && getModel().jobs !== jobsBefore)) finalizeDispatch();
    }
  }
}

// Stable lane-terminal (cached by identity in the middleware): the actual root
// dispatch the inbound link chain terminates in. Reads `entry.msg` so an outer
// link may transform it. NOT depth-counted, does NOT finalize (root Msgs don't
// move panes).
function _termRoot(entry) {
  const [next, cmds] = runtime.update(getModel(), entry.msg);
  setModel(next);
  runEffects(cmds);
}

/**
 * Dispatch a Msg. Two shapes: a WRAPPED Msg `{ kind, msg }` routes only to the
 * Component named `kind` (its update() sees the unwrapped inner); a BROADCAST
 * Msg (refresh / action) fans out to every instance. Every other flat Msg
 * is a missed wrap site (logged + dropped). Failures in one Component's update
 * don't stop the others.
 */
function dispatchMsg(msg) {
  // Depth counter + finalize gate are the OUTER (loop-structural) frame; the
  // inbound middleware wraps only the inner dispatch (record/crash links etc.).
  _dispatchDepth++;
  try { mw.run({ lane: 'comp', msg }, _termComp); }
  finally {
    _dispatchDepth--;
    // Flush nav capture BEFORE finalize: finalize's nested set_scroll dispatch
    // would otherwise hit depth-0 and fire the flush mid-finalize.
    if (_dispatchDepth === 0) { flushNavCapture(); finalizeDispatch(); }
  }
}

// Stable lane-terminal for the Component fan-out path.
function _termComp(entry) { _dispatchMsgInner(entry.msg); }

function _dispatchMsgInner(msg) {
  const components = _reg();
  // Free-config freeze gate. While free-config mode is active, only layout-
  // wrapped Msgs flow (they drive the mode itself). Broadcasts + wrapped Msgs
  // to non-layout components are dropped so the canvas stays stable under
  // drag/resize. Mode entry/exit ride apply_msg Cmds through the root reducer.
  const m = getModel();
  if (m && m.modes && m.modes.freeConfigMode) {
    const isLayoutWrap = msg && msg.kind === 'layout' && msg.type === undefined;
    // (U2f — the free-config tab-reorder exception retired with the flat
    // content-tab drag: content is position-tabs, reordered via the position-tab
    // drag path, not a viewer_reorder_content_tab dispatch through this gate.)
    //
    // Live-agent exemption: a backend's async `agent_event` stream must keep
    // folding under free-config — the events are not re-derivable (a dropped
    // assistant-message is transcript loss; a dropped exit/settled wedges the
    // modeled status machine). The fold touches only the agent slice — no
    // pane moves — which is all this gate protects. User-gesture agent Msgs
    // (agent_input/agent_activate) can't fire in free-config (its mode owns
    // the keys), so only the event lane needs the pass.
    const isAgentEvent = msg && msg.msg && msg.msg.type === 'agent_event' && msg.type === undefined;
    if (!isLayoutWrap && !isAgentEvent) return;
  }
  // Wrapped-Msg path. Routes to exactly one Component instance. Discriminator:
  // `{ kind: string, msg: any }` AND no top-level `type`.
  if (msg && typeof msg.kind === 'string' && msg.msg !== undefined && msg.type === undefined) {
    // Nav-ref for applyMsg's finalize gate (see the comment there): count every
    // nav-shaped Msg at the pump — the one choke point every origin (nav-state
    // facade, reducer-emitted Cmds, effects) passes through.
    if (_mnav.isNavMsg(msg.msg)) _navMsgSeq++;
    const kind = msg.kind;
    // `kind` may be a Component name (legacy primary-instance routing) OR a
    // paneId (post-B3 multi-instance routing). Try paneId lookup first. U2b —
    // resolve a column paneId to its ACTIVE tab's instance (symmetric with the
    // focused-key path); a Component name or a tab-instance id passes through
    // activeInstanceOf unchanged, so a non-active tab stays directly addressable.
    let inst = route.getInstance(route.activeInstanceOf(kind));
    let comp;
    if (inst) {
      // paneId form. Find the Component for this instance's kind — by direct
      // Component-name match, or via the panel-type → Component-name table.
      comp = components[inst.kind] || components[route.componentForPanel(inst.kind)];
    } else {
      // Component-name form. Look up via _primaryByKind for the canonical
      // instance.
      comp = components[kind];
      let primaryKind = kind;
      if (!comp) {
        // `kind` may be a paneId whose per-pane instance wasn't minted
        // (docker-style panes, or a kind-keyed singleton harness). Resolve the
        // Component + panel-type via the arrange, then route to the primary.
        comp = components[route.componentForPanel(kind)];
        primaryKind = route.paneTypeOf(kind) || primaryKind;
      }
      const id = comp ? route.getPrimaryByKind(primaryKind) : undefined;
      if (id !== undefined) inst = route.getInstance(id);
    }
    if (!comp || !inst) {
      console.error(`[dispatch] wrapped Msg targeting unknown Component '${kind}'; dropped`);
      return;
    }
    _runInstance(inst, comp, msg.msg);
    return;
  }
  // Broadcast path. Only the 3 framework signals fan out; everything else must
  // arrive wrapped. Iterates instances so a multi-instance Component has each
  // one's update called independently.
  if (msg && BROADCAST_TYPES.has(msg.type)) {
    route.eachInstance(inst => {
      // Resolve panelType-aliased instances (e.g. a `file-browser` instance
      // owned by the `files` Component) via the panel-type → Component table.
      const comp = components[inst.kind] || components[route.componentForPanel(inst.kind)];
      if (!comp) return;  // defensive: orphan instance (Component unregistered)
      _runInstance(inst, comp, msg);
    });
    return;
  }
  // Any other flat Msg is a missed wrap site.
  const ty = msg && msg.type ? `'${msg.type}'` : '(no type)';
  console.error(`[dispatch] unwrapped Component-specific Msg ${ty}; dropped. Wrap with api.wrap('<component>', msg).`);
}

/**
 * Dispatch a `key` Msg to the focused Component and return whether the
 * Component claimed the keystroke (asked the framework to skip its default).
 * The claim is a `_claimed` sentinel effect in the Component's return.
 */
function dispatchKeyToFocused(key, seq) {
  _dispatchDepth++;
  try { return mw.run({ lane: 'key', key, seq }, _termKey); }
  finally {
    _dispatchDepth--;
    if (_dispatchDepth === 0) { flushNavCapture(); finalizeDispatch(); }
  }
}

// Stable lane-terminal for the focused-key path; returns the `claimed` bool the
// chain threads back out (the input layer uses it to gate the framework default).
function _termKey(entry) { return _dispatchKeyToFocusedInner(entry.key, entry.seq); }

// blessed-exceptions #3 — apply a Component's optional augmentMsg enrichment
// hook in ONE place (the impure shell). When a Component declares
// augmentMsg(msg, model, slice), the shell reads the model and lets it thread
// model-derived facts into the Msg, so update(msg, slice) stays pure of
// getModel(); the instance's own slice is passed so per-pane Components (files)
// resolve pane-specific facts. `model` lets a caller that already read it (the
// key path, for terminalMode/focusKind) avoid a second read.
function _augment(comp, msg, slice, model) {
  if (!comp || !comp.augmentMsg) return msg;
  return comp.augmentMsg(msg, model || getModel(), slice);
}

function _dispatchKeyToFocusedInner(key, seq) {
  const components = _reg();
  const focus = route.getFocus();
  const compName = route.componentForPanel(focus);
  if (!compName) return false;
  const comp = components[compName];
  if (!comp) return false;
  // Route the keystroke to the FOCUSED slot's ACTIVE tab instance (U2b): focus is
  // a column paneId; activeInstanceOf resolves it to the active tab's instance id
  // (identity for a single-tab pane). Else fall back to the kind's primary
  // (docker-style panelTypes panes mint kind-keyed, not per-pane).
  const id = route.hasInstance(focus) ? route.activeInstanceOf(focus) : route.getPrimaryByKind(compName);
  if (id === undefined) return false;
  const inst = route.getInstance(id);

  let claimed = false;
  try {
    // Phase D1 — thread terminalMode + focusKind so the viewer's `key` arm
    // doesn't need getModel()/getFocus().
    const _m = getModel();
    let keyMsg = {
      type: 'key', key, seq,
      terminalMode: !!_m.modes.terminalMode,
      focusKind: route.instanceKind(route.getFocus()),
    };
    keyMsg = _augment(comp, keyMsg, inst.slice, _m);
    const result = comp.update(keyMsg, inst.slice);
    if (result === undefined) return false;
    if (Array.isArray(result)) {
      const [next, effects] = result;
      if (next !== undefined) route.setInstanceSlice(inst.id, next);
      const filtered = [];
      for (const e of (effects || [])) {
        if (e && e.type === '_claimed') claimed = true;
        else if (e) filtered.push(e);
      }
      if (filtered.length) runEffects(filtered);
    } else {
      route.setInstanceSlice(inst.id, result);
    }
  } catch (e) {
    console.error(`[component:${compName}] key update error: ${e.message}`);
    _recordError({ where: 'component_key', component: compName, instance: inst.id,
      message: e && e.message, stack: e && e.stack });
  }
  return claimed;
}

// Generic per-pane selection fallback (docs/pane-selection.md). The three
// select_* state arms apply to ANY pane: a Component that models selection
// itself (the content panes — info / text-view / agent) claims them in its own
// update, clamped against its buffer; every other Component leaves them
// unclaimed and gets the shared pure transition applied to its slice HERE —
// one seam, zero per-Component edits, single-writer preserved (the write still
// rides the update spine of exactly one dispatch). "Unclaimed" is detected by
// SLICE IDENTITY, not just an undefined return: most Components `return slice`
// unchanged for Msgs they don't own (e.g. ports-pane / wire-list defaults) —
// and a content pane whose own select arm no-ops by identity would no-op in
// reduceSelect too, so the identity test can't double-apply.
const SELECT_FALLBACK_TYPES = new Set(['select_begin', 'select_extend', 'select_cancel']);
function _selectFallback(inst, msg) {
  if (!msg || !SELECT_FALLBACK_TYPES.has(msg.type)) return;
  const sel = inst.slice && inst.slice.select;
  const next = require('../../leaves/text/select-core').reduceSelect(msg, sel);
  if (next === undefined || next === sel) return;
  route.setInstanceSlice(inst.id, { ...inst.slice, select: next });
}

// Inner helper — runs ONE instance's update, handles the
// undefined / slice / [slice, effects] return contract, and isolates throws.
// Shared by the wrapped and broadcast dispatch paths.
function _runInstance(inst, comp, msg) {
  try {
    msg = _augment(comp, msg, inst.slice);
    const before = inst.slice;
    const result = comp.update(msg, inst.slice);
    let claimed;   // did the Component's own update produce a NEW slice?
    if (result === undefined) {
      claimed = false;
    } else if (Array.isArray(result)) {
      const [next, effects] = result;
      if (next !== undefined) route.setInstanceSlice(inst.id, next);
      claimed = next !== undefined && next !== before;
      runEffects(effects);
    } else {
      route.setInstanceSlice(inst.id, result);
      claimed = result !== before;
    }
    if (!claimed) _selectFallback(inst, msg);
  } catch (e) {
    console.error(`[component:${inst.kind}] update error: ${e.message}`);
    _recordError({ where: 'component_update', component: inst.kind, instance: inst.id,
      message: e && e.message, stack: e && e.stack });
  }
}

// Persist diagnostics from the Component fan-out paths to the event log — the
// console.error above is painted over by the next render; the event log is the
// only place a thrown Component update is inspectable post-mortem.
function _recordError(payload) {
  try { require('../../io/event-log').record('error', payload); }
  catch (_) { /* event-log unavailable — already logged to console */ }
}

module.exports = { applyMsg, dispatchMsg, dispatchKeyToFocused, wrap };
