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
const { runEffects } = require('./effects');
// #D4 — the post-dispatch invariant pass (scroll clamp + viewer innerH + PTY +
// instance reconcile) lives in its own after-update-phase module now; the loop
// only gates it at depth-0 exit. One-way edge: loop → finalize.
const { finalizeDispatch } = require('./finalize');

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

// Dispatch depth counter: both top-level entries (dispatchMsg +
// dispatchKeyToFocused) share it, so effect-chained nested dispatches run the
// after-update phase ONCE, at depth-0 exit. The pass itself (scroll clamp +
// viewer innerH + PTY + instance reconcile) lives in ./finalize; the loop just
// gates it here. finalize's own re-entrancy guard makes the set_scroll Msgs it
// dispatches skip re-finalizing.
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
// state. applyMsg does NOT run the finalizer (root Msgs don't move panes).
function applyMsg(msg) {
  const [next, cmds] = runtime.update(getModel(), msg);
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
  _dispatchDepth++;
  try { _dispatchMsgInner(msg); }
  finally {
    _dispatchDepth--;
    if (_dispatchDepth === 0) finalizeDispatch();
  }
}

function _dispatchMsgInner(msg) {
  const components = _reg();
  // Free-config freeze gate. While free-config mode is active, only layout-
  // wrapped Msgs flow (they drive the mode itself). Broadcasts + wrapped Msgs
  // to non-layout components are dropped so the canvas stays stable under
  // drag/resize. Mode entry/exit ride apply_msg Cmds through the root reducer.
  const m = getModel();
  if (m && m.modes && m.modes.freeConfigMode) {
    const isLayoutWrap = msg && msg.kind === 'layout' && msg.type === undefined;
    // Narrow exception: the free-config tab-reorder gesture lives on layout's
    // slice but emits a viewer_reorder_content_tab dispatch_msg back through
    // this gate to permute detail's contentTabs.
    const isTabReorder = msg && msg.msg
      && msg.msg.type === 'viewer_reorder_content_tab'
      && typeof msg.kind === 'string' && route.isViewerKind(msg.kind);
    if (!isLayoutWrap && !isTabReorder) return;
  }
  // Wrapped-Msg path. Routes to exactly one Component instance. Discriminator:
  // `{ kind: string, msg: any }` AND no top-level `type`.
  if (msg && typeof msg.kind === 'string' && msg.msg !== undefined && msg.type === undefined) {
    const kind = msg.kind;
    // `kind` may be a Component name (legacy primary-instance routing) OR a
    // paneId (post-B3 multi-instance routing). Try paneId lookup first.
    let inst = route.getInstance(kind);
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
  try { return _dispatchKeyToFocusedInner(key, seq); }
  finally {
    _dispatchDepth--;
    if (_dispatchDepth === 0) finalizeDispatch();
  }
}

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
  // Route the keystroke to the FOCUSED instance: prefer the focused paneId
  // directly (per-pane mint), else fall back to the kind's primary (docker-
  // style panelTypes panes mint kind-keyed, not per-pane).
  const id = route.hasInstance(focus) ? focus : route.getPrimaryByKind(compName);
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

// Inner helper — runs ONE instance's update, handles the
// undefined / slice / [slice, effects] return contract, and isolates throws.
// Shared by the wrapped and broadcast dispatch paths.
function _runInstance(inst, comp, msg) {
  try {
    msg = _augment(comp, msg, inst.slice);
    const result = comp.update(msg, inst.slice);
    if (result === undefined) return;
    if (Array.isArray(result)) {
      const [next, effects] = result;
      if (next !== undefined) route.setInstanceSlice(inst.id, next);
      runEffects(effects);
    } else {
      route.setInstanceSlice(inst.id, result);
    }
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
