/**
 * Single source of truth for lazytui's modal UI states.
 *
 * Each mode is a boolean flag on `S`. Historically the set of modes was
 * duplicated across four hand-maintained lists that drifted apart (a
 * mode added to the dispatch chain but forgotten in the overlay-residue
 * list left stale pixels on close; forgotten in the reset list leaked
 * across re-init). This table is the one place a mode is declared; the
 * consumers derive their lists from it:
 *
 *   - dispatch.js  modeChain     ← CHAIN_MODES (array order = precedence)
 *   - layout.js    overlayActive ← isOverlayActive (centered box → must
 *                                   force a full repaint when it closes)
 *   - layout.js    inModal       ← isModal (footer owns the row → suppress
 *                                   panel hints + footer decorators)
 *   - state.js     initState     ← resetModes (cleared on (re-)init)
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
  { flag: 'promptMode',              chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: true  },
  { flag: 'freeConfigTitleEditMode', chain: true,  overlay: false, modal: true,  reset: true, suppressChrome: true  },
  { flag: 'freeConfigMode',          chain: true,  overlay: true,  modal: true,  reset: true, suppressChrome: false },
  { flag: 'menuOpen',                chain: true,  overlay: true,  modal: true,  reset: true, suppressChrome: true  },
  { flag: 'filterMode',              chain: true,  overlay: false, modal: true,  reset: true, suppressChrome: false },
  { flag: 'copyMode',                chain: true,  overlay: true,  modal: true,  reset: true, suppressChrome: true  },
  { flag: 'detailSearchMode',        chain: true,  overlay: false, modal: false, reset: true, suppressChrome: false },
  { flag: 'registerPopupMode',       chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: true  },
  { flag: 'prefixMode',              chain: true,  overlay: true,  modal: true,  reset: true, suppressChrome: false },
  { flag: 'cmdMode',                 chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: true  },
  { flag: 'tabListMode',             chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: false },
  { flag: 'paneSelectMode',          chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: false },
  { flag: 'jobsMode',                chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: false },
  { flag: 'diagLogMode',             chain: true,  overlay: true,  modal: false, reset: true, suppressChrome: true  },
  // Non-chain modes (see header).
  { flag: 'terminalMode',            chain: false, overlay: false, modal: true,  reset: true, suppressChrome: true  },
  { flag: 'listSelectMode',          chain: false, overlay: false, modal: false, reset: true, suppressChrome: false },
];

// Ordered list of modeChain flags (precedence = array order).
const CHAIN_MODES = MODES.filter(m => m.chain).map(m => m.flag);

function _modes() { return require('../app/runtime').getModel().modes; }

/** True when any mode that draws a centered overlay is active.
 *  Accepts an optional explicit modes-bag for test isolation; defaults
 *  to the live model's modes. */
function isOverlayActive(md = _modes()) { return MODES.some(m => m.overlay && md[m.flag]); }

/** True when any mode that owns the footer row is active. */
function isModal(md = _modes()) { return MODES.some(m => m.modal && md[m.flag]); }

/** True when an active mode suppresses chrome-glyph clicks (the mode
 *  owns input or paints a centered popup over the chrome, so a click on
 *  [_]/[+]/[x] shouldn't fire "through" it). Derived from the
 *  `suppressChrome` column — the single source — replacing the former
 *  hand-rolled list in input.js. */
function suppressesChromeClicks(md = _modes()) { return MODES.some(m => m.suppressChrome && md[m.flag]); }

/** True when ANY modeChain mode is active — i.e. the keyboard side
 *  would route the next key through a modal handler rather than the
 *  framework default. Used by handleMouse to mirror keyboard modal
 *  gating: while a modal claims keys, mouse events should not
 *  cascade into focus changes / selection / scroll that the user
 *  can't see through the overlay. The freeConfigMode special-case in
 *  handleMouse runs BEFORE this gate (design owns the mouse pipeline);
 *  terminalMode is non-chain by design and not covered here. */
function isChainActive(md = _modes()) { return CHAIN_MODES.some(f => md[f]); }

/** Clear every resettable mode flag (called from initState). Non-flag
 *  buffers (prefixNode, detail-slice search state, etc.) are reset by
 *  their owners; this only flips the booleans. */
function resetModes(md = _modes()) { for (const m of MODES) if (m.reset) md[m.flag] = false; }

module.exports = { MODES, CHAIN_MODES, isOverlayActive, isModal, isChainActive, suppressesChromeClicks, resetModes };
