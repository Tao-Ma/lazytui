/**
 * Footer row — the bottom status/hint line. (v0.6.4 Theme B: split out
 * of `render/geometry.js`, which now owns only layout geometry + view-
 * mode paint dispatch. The footer is a self-contained ~180-LOC unit:
 * a left half built from mode-aware key hints + plugin/Component
 * contributions, and a right tail of select / view-mode tags, padded
 * to terminal width.)
 *
 * One public function: `renderFooter(model)` — composes left (footerKeys:
 * modal footers own the row; non-modal assembles focus-kind segments) +
 * right tail + padding and RETURNS the row's ansi (undefined in cmdline
 * mode). Called once per frame by paint.js render(), which emits it
 * through the depth-adapting _emit funnel (truecolor arc 3b / P3 — a
 * direct stdout write here bypassed the downgrade).
 *
 * Zero npm dependencies (uses local modules).
 */
'use strict';

const { RESET, richToAnsi, esc, visibleLen, wrapColor } = require('../leaves/text/ansi');
const { multiSelCount } = require('../panel/nav-state');
const { theme } = require('../leaves/infra/themes');
const { truncate, viewportDims } = require('../leaves/render/draw');
const { fieldTail } = require('../leaves/text/field-window');
const { focusedTerminalTitle, focusedTerminalState } = require('../panel/terminal-surfaces');
const { getPanelDef, getInstanceSlice, getFocus, instanceKind,
        collectViewContributions, filterCurrentText, paneTypeHasBottomBar,
        borderControlsFor } = require('../panel/api');
const { visibleBoundsFor } = require('../leaves/wm/geometry');
const modes = require('../leaves/input/modes');
// E9 — footer key HINTS are declared as data in this leaf (the single source
// the footer + a future powerline/segment footer project from). The footer
// interleaves the genuinely-LIVE status (search count, filter text, leader
// pending, the terminal's name) computed below; bindings supplies the key labels.
const bindings = require('../leaves/input/bindings');
const { getModel } = require('../model/store');
const { getFreeConfigFooter } = require('../panel/free-config-view');

// Memoized lazy route ref — resolveTarget is read on the per-frame
// footer path; relative require() resolution is ~70µs/call (see the
// render-path require sweep in geometry.js). Kept lazy to avoid a load-
// order cycle through panel/route.
let _routeRef; const _route = () => (_routeRef ||= require('../panel/route'));

// Whether the focused pane's `keyHints` should appear in the footer. A pane with
// no border item-action bar always uses the footer. A pane that HAS one (docker)
// shows its keys in the footer ONLY when `quick_keys: footer` — under the default
// `border` (bar owns them) and `off` (no hints) the footer stays quiet, so the
// quick keys never appear in two places. (docs/global-config.md)
function _showFooterHints(model, focus) {
  const type = _route().paneTypeOf(focus) || focus;
  if (!paneTypeHasBottomBar(type)) return true;   // no border bar → footer is the only surface
  const qk = (model.config && model.config.quick_keys) || 'border';
  if (qk === 'footer') return true;
  if (qk === 'off') return false;                 // neither surface
  // border mode: the footer is the FALLBACK — show the keys only when the bar
  // didn't actually paint (pane too narrow for even the compact key row), so they
  // never vanish from BOTH surfaces. Ask the SAME source the bar uses.
  const b = visibleBoundsFor(getInstanceSlice('layout'), focus);
  const pane = { paneId: focus, type, focused: true, innerW: b ? b.w - 2 : 0 };
  const barShown = borderControlsFor(pane, model).some(c => (c.spec.slot || 'top') === 'bottom');
  return !barShown;
}

/** A footer text field: `prefix`, the text, and the `│` caret, the text a field
 *  window (leaves/text/field-window) over what `cols` leaves after the prefix,
 *  scrolled to keep its end and the caret on the row (`…` first when the start
 *  is cut). Painted from the start, a long filter / search / rename pushed the
 *  caret and what was being typed off the right edge (the row is truncated to
 *  the screen); the key hints after it are what gets cut now — one column is
 *  left for the `…` that cut puts after the caret (it took the caret's column). */
function _fieldSeg(prefix, text, cols) {
  const win = fieldTail(text, cols - 1 - visibleLen(prefix));
  return `${prefix}${win.clipped ? '…' : ''}${esc(win.before)}│`;
}

/**
 * Build the keys-string for the footer's left half. Modal footers
 * (terminal / filter / copy / free-config / menu) own the message; the
 * standard non-modal footer is built from segments. Returns the
 * leading-space-prefixed concatenation ready for assembly. `cols` is what the
 * row leaves the keys (the screen minus the right-hand tags): a footer text
 * field (filter / search / rename) windows its text into it (_fieldSeg).
 */
function footerKeys(model, cols = viewportDims().cols) {
  const md = model.modes;
  // Modal footers: a LIVE prefix (pending keys / label / match count / typed
  // text) computed here, joined to the mode's static key tail from the registry.
  if (md.prefixMode) {
    const pending = (model.prefixSeq && model.prefixSeq.length)
      ? ' ' + model.prefixSeq.join(' ')
      : '';
    return ` \\[leader]${esc(pending)}… | ${bindings.footerSegs('prefixMode').join(' | ')}`;
  }
  if (md.terminalMode) {
    const name = focusedTerminalTitle() || 'terminal';
    return ` \\[terminal: ${esc(name)}] | ${bindings.footerSegs('terminalMode').join(' | ')}`;
  }
  if (md.agentMode) {
    // Live-agent input (docs/live-agent.md A4) — the Esc dual role (interrupt
    // while a turn runs, leave when idle) is exactly what a hint row is for.
    const inst = _route().getInstance(_route().activeInstanceOf(getFocus()));
    const d = inst && inst.slice && inst.slice.descriptor;
    const label = (d && (d.label || d.backend)) || 'agent';
    return ` \\[agent: ${esc(label)}] | ${bindings.footerSegs('agentMode').join(' | ')}`;
  }
  if (md.detailSearchMode) {
    // P1 (viewer-lines selector) — match count derives from the viewer's
    // lines via the ms.matchesFor memo (typing term), not a stored list.
    const ds = require('../panel/content/search');
    const ms = require('../leaves/text/search');
    const term = ds.typingText();
    const vslice = getInstanceSlice(_route().resolveTarget('viewer'));
    const vlines = (vslice && Array.isArray(vslice.lines)) ? vslice.lines : [];
    const n = ms.matchesFor(vlines, term).length;
    const idx = n ? Math.min((vslice && vslice.search && vslice.search.idx) || 0, n - 1) + 1 : 0;
    const count = ` \\[${idx}/${n}]`;     // kept beside the field — it is live
    return `${_fieldSeg(' /', term, cols - visibleLen(count))}${count} | ${bindings.footerSegs('detailSearchMode').join(' | ')}`;
  }
  if (md.filterMode) return `${_fieldSeg(' /', filterCurrentText(), cols)} |${bindings.footerFor('filterMode')}`;
  if (md.copyMode)   return bindings.footerFor('copyMode');
  if (md.freeConfigTitleEditMode) {
    const { titleEditText } = require('../panel/free-config-view');
    return `${_fieldSeg(' rename: ', titleEditText(), cols)} | Esc cancel | Enter ok`;
  }
  if (md.freeConfigMode) {
    const layoutSlice = getInstanceSlice('layout');
    const dirty = (layoutSlice && layoutSlice.dirty) ? ` | [${theme().warning}]• unsaved (:save-layout)[/]` : '';
    return ` Free Config | drag/resize | J/K reorder | ←→ swap col | +/- col/detail · [/] panel h | space collapse | t rename | w panel list | u undo | C-r redo | :save-layout | q exit${getFreeConfigFooter()}${dirty}`;
  }
  if (md.menuOpen)   return bindings.footerFor('menuOpen');

  // Non-modal: the focus-kind's key hints come from the registry. Hoist the
  // resolver once — each instanceKind() can walk arrange for docker-style focus.
  const focusKind = instanceKind(getFocus());
  if (_route().isViewerKind(getFocus())) {   // U2e P1b — content-viewer kinds (detail/info/text-view) share the viewer footer
    // Build the live guard facts the detail context's `when` predicates read;
    // the registry reproduces the old segment list, then the live committed-
    // search count is appended (it carries a live number, not a key hint).
    // `total` = the content slot's tabs (Info + Transcript + opened content
    // tabs) → the `][ tabs` hint. (A terminal tab of the content slot is footed
    // below, with the same hint.)
    const total = _route().contentSlotTabCount();
    let keys = bindings.footerFor('detail', { total });
    // P1 — committed-phase count derives from (lines, term).
    const vslice = getInstanceSlice(_route().resolveTarget('viewer'));
    const search = vslice?.search;
    if (search && search.active) {
      const ms = require('../leaves/text/search');
      // The active content instance (info / text-view) holds its buffer on slice.lines.
      const vlines = Array.isArray(vslice.lines) ? vslice.lines : [];
      const n = ms.matchesFor(vlines, search.term || '').length;
      const idx = n ? Math.min(search.idx || 0, n - 1) + 1 : 0;
      // `\[` — an unescaped [1/5] parses as an unknown tag → RESET and the
      // count vanishes (the modal branch above already escapes it).
      keys += ` | n/N \\[${idx}/${n}] | Esc clear`;
    }
    return keys;
  }
  if (focusKind === 'terminal') {
    // `]` / `[` cycle the content slot's strip — a terminal opened as one of
    // its tabs (an action's `type: spawn`, `docker exec`) gets the hint too;
    // a terminal in any other slot doesn't (they don't cycle its tabs).
    const total = _route().resolveViewerPaneId() === getFocus() ? _route().contentSlotTabCount() : 0;
    return bindings.footerFor('terminal', { ...(focusedTerminalState(model) || {}), total });
  }
  if (focusKind === 'actions') return bindings.footerFor('actions');
  if (focusKind === 'groups')  return bindings.footerFor('groups');
  return bindings.footerFor('list');
}

function renderFooter(model = getModel()) {
  // cmdline mode replaces the footer with its own prompt — drawing the
  // footer first would flicker on every keystroke as renderCmdline() then
  // overwrites it.
  if (model.modes.cmdMode) return;
  const t = theme();
  const { cols: COLS, rows: ROWS } = viewportDims();
  const inModal = modes.isModal(model.modes);
  const layoutSlice = getInstanceSlice('layout') || { viewMode: 'normal', dirty: false };

  // Left side: mode message OR (panel hints + plugin keyHints +
  // multi-select indicator + footer:left decorator). Modal footers
  // own the row — no plugin contributions appended.
  // Hoist focus + def once — used here and again at the list-select tag
  // below. Each getPanelDef() can walk arrange for docker-style focus.
  const focus = getFocus();
  const focusDef = getPanelDef(focus);
  // Right-hand tags (visual-select, view mode) — measured first: a footer text
  // field windows into what they leave (footerKeys `cols`).
  // The visual-select tag (`[v-char]` / `[v-line]`) is a precursor to
  // the configurable status-bar segments planned for v0.5/v0.6 — when
  // that lands, this becomes one of several registered widgets, but
  // for now it's hardcoded next to the existing [half]/[full] tag.
  // List-select tag only when the armed mode actually applies — i.e.
  // focus is on a list panel. (The flag can stay armed while focus is
  // on a non-list panel, where space falls back to the leader.)
  const selectActive = model.modes.listSelectMode && focusDef && typeof focusDef.getItems === 'function';
  const sel = getInstanceSlice(_route().resolveTarget('viewer'))?.select;
  const selectTag = (sel && sel.active)
    ? ` \\[${sel.kind === 'line' ? 'v-line' : 'v-char'}]`
    : (selectActive ? ' \\[select]' : '');
  const vm = layoutSlice.viewMode;
  const modeTag = vm !== 'normal' ? ` \\[${vm}]` : '';

  // Component footer contributions (Phase 5 — viewContributions slots
  // `footerLeft` / `footerRight`). Suppressed in modal footers (the
  // message owns the row). Note the separator is the heavy pipe `│`,
  // distinguishing contributor output from the regular `|`-separated
  // key hints. Each contributor receives its own Component slice as the
  // first arg + this `ctx` as the second. Collected BEFORE the keys: the
  // right one is part of the right-hand tail a footer text field windows into
  // (viewer search is not modal — a `footerRight` contribution pushed its caret
  // and its text's end off the row).
  let footerLeftExtra = '', footerRightExtra = '';
  if (!inModal) {
    const ctxBase = { focus: getFocus(), view: layoutSlice.viewMode };
    const halfBudget = Math.max(0, Math.floor(COLS / 2) - 4);
    footerLeftExtra  = collectViewContributions('footerLeft',  { ...ctxBase, width: halfBudget });
    footerRightExtra = collectViewContributions('footerRight', { ...ctxBase, width: halfBudget });
  }
  // Right tail: footer:right + the visual-select / view-mode tags.
  const rightTail = footerRightExtra ? `${footerRightExtra} │ ` : '';
  let keys = footerKeys(model, COLS - visibleLen(rightTail) - visibleLen(selectTag) - visibleLen(modeTag));
  if (!inModal) {
    if (focusDef && focusDef.keyHints && _showFooterHints(model, focus)) keys += ` | ${esc(focusDef.keyHints)}`;
    const msCount = multiSelCount(focus);
    if (msCount > 0) keys += ` | ${esc(`[${msCount} sel]`)}`;
    // Surface layout-dirty state to non-modal users too. They might
    // have left free-config mode with pending changes; the indicator
    // reminds them `:save-layout` exists. Free-config footer adds
    // its own dirty marker in footerKeys() to keep modal layout
    // self-contained.
    if (layoutSlice.dirty) keys += ` | [${t.warning}]• unsaved (:save-layout)[/]`;
  }

  if (footerLeftExtra) keys += ` │ ${footerLeftExtra}`;

  // Layout notice — a transient hint set by layout.update when a free-
  // config / view-mode transition is refused (kind: 'error', red) OR a
  // successful column-edit action (kind: 'info', green). noticeKind
  // defaults to 'error' when omitted so legacy refusal sites keep their
  // red color without explicit annotation. Cleared by layout.update on
  // the next state change that resolves the block.
  const layoutNotice = layoutSlice.freeConfig && layoutSlice.freeConfig.notice;
  if (layoutNotice) {
    const kind = (layoutSlice.freeConfig && layoutSlice.freeConfig.noticeKind) || 'error';
    const color = kind === 'info' ? `bold ${t.success}` : `bold ${t.error}`;
    keys += ` | [${color}]${esc(layoutNotice)}[/]`;
  }

  // Boot warnings — soft diagnostics surfaced by parse (today: column
  // over soft cap). Yellow so it reads as advisory, not an error.
  // Cleared by `:dismiss-warnings` or next config reload.
  const bw = layoutSlice.bootWarnings;
  if (bw && bw.length > 0) {
    keys += ` | [${t.warning}]! ${bw.length} config warning(s) (:dismiss-warnings)[/]`;
  }

  // Graph hover value (Phase 2, hover-for-value) — the value under the cursor on a
  // graph pane, published by stats.render to the per-frame hover-region (empty when
  // nothing is hovered). Non-modal only; `[accent]` so it recolors on :theme.
  if (!inModal) {
    const hv = require('../panel/hover-region').get();
    if (hv && hv.text) keys += ` | [${t.accent}]⌖ ${esc(hv.text)}[/]`;
  }


  // Pad left → right tail → tags, using visible width math (esc'd
  // [ characters and double-width chars must not throw the alignment).
  // Truncate `keys` first when the combined visible length would
  // overflow the terminal width — otherwise the footer wraps onto a
  // new row, scrolls the screen up, and looks like the entire frame
  // is shrinking each render. Surfaced under v0.6 free-config when
  // the free-config footer + pool-drag status string grew past common
  // terminal widths.
  const tailLen = visibleLen(rightTail) + visibleLen(selectTag) + visibleLen(modeTag);
  const maxKeysLen = Math.max(0, COLS - tailLen);
  if (visibleLen(keys) > maxKeysLen) keys = truncate(keys, maxKeysLen);
  const visLen = visibleLen(keys) + tailLen;
  const padding = ' '.repeat(Math.max(0, COLS - visLen));
  // wrapColor() reopens the footer color after any nested `[/]` in
  // `keys` (layout notice, dirty marker, boot-warning chip), so the
  // trailing padding + tags stay in footer color instead of dropping
  // to terminal default. Same `[/]`-is-hard-reset class of bug as
  // renderPanel's title fix.
  const footerMarkup = wrapColor(theme().footer,
    `${keys}${padding}${rightTail}${selectTag}${modeTag}`);
  // Truecolor arc 3b — RETURN the ansi instead of writing it: paint.js owns
  // the stdout seam and routes every frame byte through its depth-adapting
  // _emit funnel (docs/truecolor.md P3). A direct write here bypassed the
  // downgrade — invisible while the footer was 16-color ('dim reverse'),
  // caught by the stats smoke the moment the footer became a hex pair.
  return `\x1b[${ROWS};1H` + richToAnsi(footerMarkup) + RESET;
}

module.exports = { renderFooter };
