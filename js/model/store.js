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
 *
 * Replayability boundary (#D5 — what the frame ACTUALLY depends on):
 *   The render path is a pure function of `(model + the terminal island)`. As of
 *   v0.6.6 FIX-1 the frame is `f(model)` for EVERYTHING except the irreducible
 *   PTY (#D14, below). Replaying the Msg log reconstructs the model (Msgs →
 *   reducer → model) and so reconstructs the frame; the terminal contents are
 *   reconstructed from a SEPARATE recorded byte-stream side-channel (NOT the Msg
 *   log — the terminal stays off-model), so the full frame replays. (v0.6.6
 *   replay arc — docs/v0.6.6-replay.md.)
 *
 *   How the formerly-off-model live stores got here — the `store-mirror` Sub
 *   (app/state.js#_appSubscriptions): each store exposes the `{snapshot,
 *   setOnChange}` contract (docs/v0.6.6.md §8.1), fires an injected cb on
 *   mutation, the cb applyMsg's a whole-snapshot `*_synced` Msg, the reducer
 *   lands it on the model, and render reads `model.*`. The overlays still update
 *   live mid-display ON PURPOSE (a job/warning arriving while the window is open
 *   shows without re-opening) — now because the cb fires per mutation, via Msg:
 *     - feature/history → model.history (history navigator)         [store-mirror]
 *     - io/diag-log     → model.diagLog (leader-e diagnostics overlay) [store-mirror]
 *     - feature/jobs    → model.jobs    (Running overlay + viewer running-glyph) [store-mirror]
 *     - hub metrics     → model.metrics[topic] (stats graph)        [metrics-mirror,
 *                         v0.6.6 Finding B — a continuous sampler, so a THROTTLED
 *                         snapshot Sub, not per-publish; see docs/v0.6.6.md §9]
 *   `model.now` (frame clock, via the `clock` interval Sub) and `model.theme`
 *   (projected to the leaves/infra/themes palette cache at the render entry, #D8)
 *   are likewise replay-safe — the wall clock and theme are read off the model.
 *
 *   The one remaining off-model render read is the terminal island:
 *     - io/terminal.getSession(id) — terminal-pane screen contents (paint.js / footer.js)
 *     - io/term.cols()/rows()      — terminal dims mirror (render reads this, not model.dims)
 *
 *   Terminal panes are an explicitly NON-TEA region — the reference FOREIGN
 *   COMPONENT (the documented non-TEA-region contract, docs/foreign-components.md):
 *   the model holds the PTY *lifecycle* (which tab, session id), but the screen
 *   contents live in the off-model emulator buffer (io/terminal, behind the
 *   io/term-screen port), mutated by the PTY `onData` callback OUTSIDE the Msg
 *   loop and painted by reading `getSession()` live. Replay reconstructs the
 *   contents by re-feeding the recorded PTY byte stream (the foreign-component
 *   side-channel), never via the Msg log.
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
 *   - now                            — frame clock (docs/model-now-tick.md; cadence = the `clock` interval Sub)
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
  const { MODES } = require('../leaves/input/modes');
  const { DEFAULT_THEME } = require('../leaves/infra/themes');
  const initialModes = {};
  for (const md of MODES) initialModes[md.flag] = false;
  const m = {
    modes: initialModes,
    currentGroup: '',
    // Frame clock (model.now / tick arc — docs/model-now-tick.md). `now`
    // is the last-ticked wall-clock ms; the render path reads it instead
    // of Date.now() so the frame is pure of the WALL CLOCK — the one read
    // that would otherwise differ on every paint. (This does NOT make the
    // frame a pure function of the model: it still reads named off-model
    // live stores — see the §Replayability boundary note in the module
    // header. model.now removes the wall-clock read specifically.)
    // model.now is written only by the reducer's clock_tick arm; the tick
    // CADENCE is the model-conditional `clock` interval Sub (FIX-3 Phase 6,
    // app/state.js#_appSubscriptions), declared while an age-display overlay
    // (jobs/diag) is open so an idle TUI emits no ticks and the replay log
    // stays quiet.
    now: 0,
    // Active theme NAME — the single source of truth for theme selection
    // (replayable: a `set_theme` Msg in the log reproduces it). The palette
    // OBJECT the pure render leaves read lives in leaves/infra/themes (`active`),
    // which can't import the model — so render projects it from model.theme at
    // the frame entry (#D8: paint.render(model) → themes.setTheme(model.theme)),
    // a per-frame derivation, the same shape as model.now driving the frame
    // clock. (Was synced by a `set_theme` effect, which replay skips; #D8 moved
    // the sync to render so the palette is replay-safe.) Seeded to match the
    // leaf cache's module default; boot dispatches set_theme(config.theme).
    theme: DEFAULT_THEME,
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
      // E14 — the modal result continuation: the serializable Cmd DESCRIPTOR
      // a modal emits on a successful dismissal. Opener-staged for
      // confirm/prompt (the caller passes what to run on `y`/submit); a fixed
      // base for copy/cmdline/menu that the terminal arm patches with the
      // user's selection (idx / sel+args / verb) before emitting. ONE shared
      // slot (modals are flat — one at a time). The five result-emitting modals
      // (confirm/prompt/copy/cmdline/menu) set it on enter and clear it on every
      // exit; `filter` routes its result via the `filter_exit` cascade and never
      // touches this slot. NEVER a closure — it must round-trip a checkpoint's
      // JSON, so a fold reproduces the same Cmd (replay-safe). Pinned by
      // test-modal-continuation.js via the model-ops.findModalClosure guard
      // helper (asserts no function under model.modal after each transition).
      continuation: null,
      // The pending confirm: just the display message now — the Cmd to emit on
      // `y` lives on `continuation` (E14).
      confirm: { message: '' },
      // The args prompt: label/spec (display), text (typed), ghost
      // (autosuggest, seeded by the caller from the yank register). The base
      // Cmd descriptor lives on `continuation` (E14); submit parses args from
      // text + merges them into it.
      prompt: { label: '', spec: '', text: '', ghost: '' },
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
      // Running overlay (Phase 4.2) — cursor + scroll into the jobs list. The
      // list itself is NOT stored here; it lives on model.jobs (FIX-1 — the
      // feature/jobs registry mirrored in via the store-mirror Sub), which the
      // renderer reads at frame time so the overlay reflects mid-overlay
      // arrivals + status flips.
      jobs: { cursor: 0, scroll: 0 },
      // Diagnostics window (leader e) — cursor + scroll into the diag list.
      // Like jobs, the list lives on model.diagLog (FIX-1 — io/diag-log
      // mirrored in), read at frame time so a warning/error arriving while the
      // window is open shows live.
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
    // v0.6.6 FIX-1 — module-local live stores mirrored into the model by the
    // store-mirror Sub (app/state.js#_appSubscriptions), so the readers render
    // f(model) instead of reading the off-model store live (#D5). Seeded []
    // (each store is empty at boot); the store's setOnChange cb drives every
    // update via the *_synced Msg. Both newest-first.
    history: [],     // operation history (feature/history) → history navigator
    diagLog: [],     // diagnostics ring (io/diag-log)      → leader-e overlay
    jobs: [],        // live-jobs registry (feature/jobs)   → Running overlay
    // v0.6.7 Phase 3 — navigation history (jumplist back/forward over visited
    // group/pane/tab/item locations). Pure model state, single-writer = the
    // reducer (nav_record/nav_back/nav_forward/nav_prune arms via the
    // leaves/wm/nav-history ring leaf). Born on the model (NOT a store-mirror)
    // and written only on the Msg path, so checkpoint + WAL-fold reconstruct it
    // identically; plain JSON (no Sets) so it rides structuredClone. Namespaced
    // under `.nav` to avoid the unrelated `model.history` action navigator.
    nav: { history: [], cursor: -1, cap: 100 },
    // v0.6.6 Finding B — hub metrics time-series, keyed by topic, sampled in by
    // the throttled `metrics-mirror` Sub: { [topic]: { series:{rowKey:samples[]},
    // schema } }. The stats panel renders f(model.metrics[topic]) instead of
    // reading the off-model hub bus live. Seeded {} (no topic until a consumer
    // pane is placed + its first sample lands).
    metrics: {},
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
