/**
 * The root model store — the bottom of the layer stack.
 *
 * Holds the single owned root-model object behind a mutable ref, plus
 * its `init()` shape and the `getModel()` / `setModel()` accessors. This
 * is the most-depended-on module in the system: every Component, every
 * dispatcher, every overlay/render reader calls `getModel()`. It lives
 * here — below `panel/` and `dispatch/` — so those layers depend *down*
 * on the store instead of reaching *up* into the reducer. Extracting it
 * (v0.6.5 §1) is what cut the {app, dispatch, panel} require cycle:
 * the store imports only `leaves/modes` (a pure leaf), nothing upward.
 *
 * The reducer `update(model, msg)` lives in `dispatch/update/reducer.js` (F3 —
 * docs/reducer-cleanup-relocation.md) — it reads `panel/route`, so it sits
 * at `dispatch`, above this store but below `app`. The store knows nothing
 * about the reducer; `setModel` is called by the dispatch boundary
 * (`dispatch/dispatch.applyMsg`) after the reducer returns.
 *
 * Contract:
 *   - Readers use `getModel()` (no caching across Msg dispatches — the
 *     ref is swapped per state-changing Msg; see v0.5-layering.md).
 *   - All writes flow through the reducer; `setModel` commits its result.
 */
'use strict';

/**
 * The root model.
 *
 * Single owned object; the reducer (`dispatch/reducer.update`) is its single
 * writer. Component slices (detail / groups / docker / files /
 * config-status / layout) live in the instance store (panel/route.js)
 * and are written only by their own `update`. The layout slice owns the
 * grid (arrange, focus, viewMode, freeConfig); per-panel chrome
 * (cursor/scroll/multiSel/filter) lives on each Navigator's `slice.nav`.
 *
 * Field map:
 *   - modes{}                        — 14 modal flags (single registry; see leaves/modes.js)
 *   - currentGroup                   — current group (chrome)
 *   - now / clockArmed               — frame clock + gated-tick latch (docs/model-now-tick.md)
 *   - modal{ filter, menu, confirm, prompt, copy, registerPopup, cmdline }
 *                                    — modal sub-model editing buffers
 *   - config / projectDir / configPath — parsed config + paths
 *   - focused / prefixNode / prefixSeq — misc
 *   - register                       — yank register
 */
function init() {
  // Derive the initial modes bag from leaves/modes.js MODES registry —
  // the registry is the single source of truth. Hardcoding the list
  // here let v0.6.3 D1's paneSelectMode drift: the registry had it but
  // init() didn't, so the mode_set Cmd's `flag in modes` guard refused
  // to arm the flag, and the pane-select overlay never painted in
  // production. (Tests pre-set the property in their setup() so they
  // missed the bug.)
  const { MODES } = require('../leaves/modes');
  const initialModes = {};
  for (const md of MODES) initialModes[md.flag] = false;
  const m = {
    modes: initialModes,
    currentGroup: '',
    // Frame clock (model.now / tick arc — docs/model-now-tick.md). `now`
    // is the last-ticked wall-clock ms; the render path reads it instead
    // of Date.now() so a frame is a pure function of the model (and thus
    // of the Msg log → replayable). `clockArmed` gates the self-re-arming
    // tick: it runs ONLY while an age-display overlay (jobs/diag) is open,
    // so an idle TUI emits no ticks and the replay log stays quiet. Both
    // are written only by the reducer (clock_tick / *_open arms).
    now: 0,
    clockArmed: false,
    // Transient per-mode editing buffers (the modal sub-models). The
    // reducer owns them; each modal handler is an update branch.
    // `filter` here is the live `/`-filter draft (text + which panel
    // is being filtered); the COMMITTED filter text lives on each
    // Navigator's `slice.nav[panel].filter`.
    modal: {
      // `route` caches the filtered pane's {compName, panelType, target}
      // bundle for the session (stamped by the filter handler at
      // filter_enter), so the filter arms route without re-reading topology
      // — blessed-A elimination (docs/reducer-route-purity.md).
      filter: { text: '', panel: '', route: null },
      menu: { items: [], idx: 0, anchor: null, title: null },
      // The pending confirm: a message + the Cmd DESCRIPTOR to emit on `y`
      // (data, not a closure — e.g. {type:'do_run', actionKey, action, args}).
      confirm: { message: '', cmd: null },
      // The args prompt: label/spec (display), text (typed), ghost
      // (autosuggest, seeded by the caller from the yank register), and the
      // base Cmd descriptor — submit parses args from text + merges them in.
      prompt: { label: '', spec: '', text: '', ghost: '', cmd: null },
      // Copy menu: only the render-safe {label, cancel} options + idx. The
      // actual content thunks (plugin closures) stay module-held in copy.js;
      // copy_commit invokes the selected one by index.
      copy: { options: [], idx: 0 },
      // Register-history popup (the `"` yank popup): the highlighted row +
      // the scroll offset of the fixed-height viewport. The register history
      // itself lives on model.register (manipulated only via register.js +
      // OSC52 — those stay effects, emitted as register_* Cmds).
      registerPopup: { idx: 0, scroll: 0 },
      // `:` cmdline: the typed text, the selected dropdown row, and the
      // render-safe match projection ({display, desc, kind} — NO run
      // closures). The closures stay module-held in cmdline.js (rebuilt from
      // the plugin facade each keystroke); cmdline_run invokes the selected
      // one by index. Mirrors the copy split.
      cmdline: { text: '', sel: 0, scroll: 0, matches: [] },
      // Design-mode state lives on the layout Component's slice —
      // `getInstanceSlice('layout').freeConfig`.
      // Running overlay (Phase 4.2) — cursor + scroll into the live jobs
      // list. Item snapshot is NOT stored here; the renderer reads
      // feature/jobs.list() at frame time so the overlay reflects
      // mid-overlay arrivals + status flips.
      jobs: { cursor: 0, scroll: 0 },
      // Diagnostics window (leader e) — cursor + scroll into the live
      // io/diag-log.js buffer. Like jobs, no item snapshot is
      // stored: the renderer reads diag-log.snapshot() at frame time so
      // a warning/error arriving while the window is open shows live.
      diagLog: { cursor: 0, scroll: 0 },
    },
    // Framework-level state: parsed config, paths, leader-mode buffers,
    // misc flags. The layout struct + freeConfig state + viewMode + focus
    // are on the layout Component's slice (see
    // docs/v0.5-layout-component.md).
    config: null,
    projectDir: '.',
    configPath: '',
    focused: true,
    prefixNode: null,
    prefixSeq: [],
    register: null,                  // yank register {history, cap} (register.js)
  };
  return m;
}

// Container pattern: the root model lives behind a single mutable ref
// the dispatcher swaps for a new snapshot post-reducer. The reducer
// returns new models on every state-changing Msg (pure-TEA); no-op Msgs
// return the same ref so setModel can identity-check.
// getModel() always returns the current snapshot — callers MUST NOT
// cache the returned object across Msg dispatches (see the stale-ref
// hazards documented in v0.5-layering.md).
const _modelRef = { current: init() };

function getModel() { return _modelRef.current; }

/**
 * Replace the root model with a new snapshot. Called by the dispatch
 * boundary (`applyMsg`) after the reducer returns. No-op when the
 * reducer identity-preserves on a no-op Msg; otherwise the
 * reassignment is what makes the new state visible to `getModel()`.
 *
 * Reentrant dispatch ordering: setModel MUST be called BEFORE
 * `runEffects` so cross-layer Cmds (`apply_msg`, `dispatch_msg`) see
 * the post-Msg state when they re-enter the dispatch graph.
 */
function setModel(next) {
  if (next && next !== _modelRef.current) _modelRef.current = next;
}

module.exports = { init, getModel, setModel };
