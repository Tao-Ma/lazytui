/**
 * Single source of truth for lazytui's modal UI states.
 *
 * A pure, dependency-free leaf: the MODES table + derivations over it.
 * v0.6.5 §4 — re-homed here from `dispatch/modes.js`. It has no dispatch
 * behavior (it's a registry consumed by dispatch / render / state alike),
 * so living under `dispatch/` made `render → dispatch` read as a layer
 * violation. The move also dropped the old `_modes()` `getModel()` default
 * on the predicates — a leaf must not reach up into `app/runtime`, so
 * every predicate now takes its modes-bag explicitly (callers already had
 * one in hand; only `render/footer.js` relied on the default).
 *
 * Each mode is a boolean flag on the root model's `modes` bag. Historically
 * the set of modes was duplicated across four hand-maintained lists that
 * drifted apart (a mode added to the dispatch chain but forgotten in the
 * overlay-residue list left stale pixels on close; forgotten in the reset
 * list leaked across re-init). This table is the one place a mode is
 * declared; the consumers derive their lists from it:
 *
 *   - dispatch.js  modeChain     ← CHAIN_MODES (array order = precedence)
 *   - layout.js    overlayActive ← isOverlayActive (centered box → must
 *                                   force a full repaint when it closes)
 *   - render/footer inModal      ← isModal (footer owns the row → suppress
 *                                   panel hints + footer decorators)
 *   - input.js     chrome clicks ← suppressesChromeClicks
 *
 * `chain:false` modes are real modes but not key-claiming modeChain
 * entries: terminalMode is handled before the chain (input.js routes
 * keys to the PTY), and listSelectMode is a gate inside handleNormalKey
 * rather than a modal that swallows keys. They still participate in the
 * overlay / modal / reset derivations.
 *
 * The booleans below reproduce the pre-registry behavior exactly; the
 * point of the table is that changing or adding a mode is now a
 * one-line edit in one file instead of four.
 */
'use strict';

// `suppressChrome` — chrome-glyph clicks ([_]/[+]/[x]) are blocked while
// this mode is active (the mode owns input or paints a centered popup over
// the chrome). NARROWER than overlay/chain: free-config + the in-grid modes
// (filter / search / prefix / listSelect / tab-list / pane-select / jobs)
// deliberately let chrome clicks through.
const MODES = [
  { flag: 'confirmMode',             chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: true  },
  { flag: 'freeConfigTitleEditMode', chain: true,  overlay: false, modal: true,  reset: true, suppressChrome: true  },
  { flag: 'freeConfigMode',          chain: true,  overlay: true,  modal: true,  reset: true, suppressChrome: false },
  { flag: 'menuOpen',                chain: true,  overlay: true,  modal: true,  reset: true, suppressChrome: true  },
  { flag: 'filterMode',              chain: true,  overlay: false, modal: true,  reset: true, suppressChrome: false },
  { flag: 'copyMode',                chain: true,  overlay: true,  modal: true,  reset: true, suppressChrome: true  },
  { flag: 'detailSearchMode',        chain: true,  overlay: false, modal: false, reset: true, suppressChrome: false },
  { flag: 'registerPopupMode',       chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: true  },
  { flag: 'prefixMode',              chain: true,  overlay: true,  modal: true,  reset: true, suppressChrome: false },
  { flag: 'cmdMode',                 chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: true  },
  // Fabric field-edit — one flag covers TWO renderers: the P1.5 ports-pane in-grid
  // editor (ports-pane renders its own cell), AND the args→ports P2 (v0.6.30)
  // invoke-time centered popup (overlay/fabric-field.js, gated on paneId==null).
  // overlay:true so paint.js's forceFull repaint fires when the mode closes —
  // without it, the invoke-time popup's directly-written cells linger after Esc
  // because the cell-diff cache for the panels underneath never saw them change
  // (the user-reported "popup won't disappear" + "text out of popup" residue).
  // The in-grid path pays only a trivial full repaint on close — cosmetic, no leak.
  { flag: 'fabricFieldMode',         chain: true,  overlay: true,  modal: true,  reset: true, suppressChrome: true  },
  // Fabric multi-field FORM (args→ports slice 1) — the invoke-time popup for an
  // action with 2+ declared `ports.in`, OR a 1-port action whose port declares
  // `choices_fn:` / `choices_cmd:` (slice-3 follow-up: the lean fabric-field
  // popup has no choices machinery, so 1-port + choices routes here to reach
  // the chip + popover). Opens N named/typed inputs at once with required-first
  // grouping + per-field chips/defaults; submits atomically. The 1-port
  // NO-choices invoke path keeps `fabricFieldMode`; the ports-pane in-grid
  // edit also stays on it (unchanged).
  { flag: 'fabricFormMode',          chain: true,  overlay: true,  modal: true,  reset: true, suppressChrome: true  },
  // v0.6.4 #1 Step 2 — the one `[≡]` pane-menu (unioned the former
  // tabListMode + paneSelectMode; same column profile).
  { flag: 'paneMenuMode',            chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: false },
  // Fuzzy action palette (v0.6.44 Brief 2) — type-to-jump across every
  // group:action. overlay:true so paint.js's forceFull repaint fires on
  // close (same lesson as fabricFieldMode's v0.6.33 fix — a centered
  // popup leaves residue in the cell-diff cache otherwise). suppressChrome
  // because the popup covers chrome glyphs. modal:true so the footer row
  // yields.
  { flag: 'paletteMode',             chain: true,  overlay: true,  modal: true,  reset: true, suppressChrome: true  },
  { flag: 'jobsMode',                chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: false },
  // diagLog is a read-only modal you Esc out of — NOT a pane selector like
  // jobs/tabList/paneSelect — so it suppresses chrome-glyph clicks behind it
  // (a stray click shouldn't collapse/close a pane underneath the window).
  { flag: 'diagLogMode',             chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: true  },
  // Live-agent input (docs/live-agent.md A4) — the terminal-mode analog for an
  // `agent` pane: keystrokes compose the message draft. LAST in the chain so
  // every popup above (confirm, menu, jobs, …) wins while open; in-grid like
  // fabricFieldMode. Mouse while chatting: chrome-glyph clicks stay live
  // (suppressChrome:false) and the WHEEL scrolls the transcript (an agentMode
  // mouse handler passes it through); other clicks/drags are chain-gated like
  // any modal (input.js T13).
  { flag: 'agentMode',               chain: true,  overlay: false, modal: true,  reset: true, suppressChrome: false },
  // Non-chain modes (see header).
  { flag: 'terminalMode',            chain: false, overlay: false, modal: true,  reset: true, suppressChrome: true  },
  { flag: 'listSelectMode',          chain: false, overlay: false, modal: false, reset: true, suppressChrome: false },
];

// Ordered list of modeChain flags (precedence = array order).
const CHAIN_MODES = MODES.filter(m => m.chain).map(m => m.flag);

/** True when any mode that draws a centered overlay is active. `md` is the
 *  root model's modes bag. */
function isOverlayActive(md) { return MODES.some(m => m.overlay && md[m.flag]); }

/** True when any mode that owns the footer row is active. */
function isModal(md) { return MODES.some(m => m.modal && md[m.flag]); }

/** True when an active mode suppresses chrome-glyph clicks (the mode
 *  owns input or paints a centered popup over the chrome, so a click on
 *  [_]/[+]/[x] shouldn't fire "through" it). Derived from the
 *  `suppressChrome` column — the single source — replacing the former
 *  hand-rolled list in input.js. */
function suppressesChromeClicks(md) { return MODES.some(m => m.suppressChrome && md[m.flag]); }

/** True when ANY modeChain mode is active — i.e. the keyboard side
 *  would route the next key through a modal handler rather than the
 *  framework default. Used by handleMouse to mirror keyboard modal
 *  gating: while a modal claims keys, mouse events should not
 *  cascade into focus changes / selection / scroll that the user
 *  can't see through the overlay. The freeConfigMode special-case in
 *  handleMouse runs BEFORE this gate (design owns the mouse pipeline);
 *  terminalMode is non-chain by design and not covered here. */
function isChainActive(md) { return CHAIN_MODES.some(f => md[f]); }

/** Clear every resettable mode flag on the given modes bag (mutates it
 *  in place). Non-flag buffers (prefixSeq, detail-slice search state,
 *  etc.) are reset by their owners; this only flips the booleans. */
function resetModes(md) { for (const m of MODES) if (m.reset) md[m.flag] = false; }

module.exports = { MODES, CHAIN_MODES, isOverlayActive, isModal, isChainActive, suppressesChromeClicks, resetModes };
