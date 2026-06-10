/**
 * Footer row — the bottom status/hint line. (v0.6.4 Theme B: split out
 * of `render/geometry.js`, which now owns only layout geometry + view-
 * mode paint dispatch. The footer is a self-contained ~180-LOC unit:
 * a left half built from mode-aware key hints + plugin/Component
 * contributions, and a right tail of select / view-mode tags, padded
 * to terminal width.)
 *
 * Two public functions:
 *   - `footerKeys(model)` — the left-half keys string (modal footers own
 *     the row; non-modal is assembled from focus-kind segments).
 *   - `renderFooter(model)` — composes left + right + padding and writes
 *     the bottom row. Called once per frame by geometry.render().
 *
 * Zero npm dependencies (uses local modules).
 */
'use strict';

const { RESET, richToAnsi, esc, visibleLen, wrapColor } = require('../io/ansi');
const { cols, rows, stdout } = require('../io/term');
const { multiSelCount } = require('../app/state');
const { theme } = require('./themes');
const { truncate } = require('./panel');
const { isTerminalTab, activeTerminalId, activeTerminalConfig,
        getTabInfo, findEphemeralByid } = require('../panel/viewer/tabs');
const { getSession } = require('../io/terminal');
const { getPanelDef, getInstanceSlice, getFocus, instanceKind,
        collectViewContributions, filterCurrentText } = require('../panel/api');
const modes = require('../dispatch/modes');
const { getModel } = require('../app/runtime');
const { getFreeConfigFooter } = require('../panel/free-config-view');

// Memoized lazy route ref — resolveTarget is read on the per-frame
// footer path; relative require() resolution is ~70µs/call (see the
// render-path require sweep in geometry.js). Kept lazy to avoid a load-
// order cycle through panel/route.
let _routeRef; const _route = () => (_routeRef ||= require('../panel/route'));

/**
 * Build the keys-string for the footer's left half. Modal footers
 * (terminal / filter / copy / free-config / menu) own the message; the
 * standard non-modal footer is built from segments. Returns the
 * leading-space-prefixed concatenation ready for assembly.
 */
function footerKeys(model) {
  const md = model.modes;
  if (md.prefixMode) {
    const pending = (model.prefixSeq && model.prefixSeq.length)
      ? ' ' + model.prefixSeq.join(' ')
      : '';
    return ` \\[leader]${esc(pending)}… | <key> select | Esc cancel`;
  }
  if (md.terminalMode) {
    const tconf = activeTerminalConfig();
    const label = tconf ? tconf.label : 'terminal';
    return ` \\[terminal: ${esc(label)}] | Ctrl+\\ return to TUI`;
  }
  if (md.detailSearchMode) {
    const ds = require('../panel/viewer/search');
    const term = ds.typingText();
    const search = getInstanceSlice(_route().resolveTarget('viewer') || 'detail')?.search || { matches: [], idx: 0 };
    const n = (search.matches || []).length;
    const idx = n ? search.idx + 1 : 0;
    return ` /${esc(term)}│ \\[${idx}/${n}] | ↑↓ step | Esc cancel | Enter commit`;
  }
  if (md.filterMode) return ` /${esc(filterCurrentText())}│ | Esc clear | Enter ok`;
  if (md.copyMode)   return ' ↑↓ select | Esc cancel | Enter copy';
  if (md.freeConfigTitleEditMode) {
    const { titleEditText } = require('../panel/free-config-view');
    return ` rename: ${esc(titleEditText())}│ | Esc cancel | Enter ok`;
  }
  if (md.freeConfigMode) {
    const layoutSlice = getInstanceSlice('layout');
    const dirty = (layoutSlice && layoutSlice.dirty) ? ' | [yellow]• unsaved (:save-layout)[/]' : '';
    return ` Free Config | drag/resize | J/K reorder | ←→ swap col | +/- col/detail · [/] panel h | space collapse | t rename | w panel list | u undo | C-r redo | :save-layout | q exit${getFreeConfigFooter()}${dirty}`;
  }
  if (md.menuOpen)   return ' ↑↓ select | Esc close | Enter run';

  // Hoist the resolver once — each instanceKind() can walk arrange for
  // docker-style focus. Was called 3× sequentially below.
  const focusKind = instanceKind(getFocus());
  if (focusKind === 'detail') {
    const { total } = getTabInfo();
    const segs = ['←→ panel'];
    if (total > 1) segs.push(']\\[ tabs');
    segs.push('+/_ view');
    if (isTerminalTab()) {
      const id = activeTerminalId();
      const dead = id && getSession(id) && getSession(id).exited;
      // x closes a dead ephemeral terminal (otherwise it opens the menu).
      const xLabel = dead && findEphemeralByid(id) ? 'x close' : 'x menu';
      segs.push(xLabel, 'q quit', dead ? 'Enter restart' : 'Enter activate');
    } else {
      segs.push('x menu', 'q quit');
      segs.push('/ search');
      const search = getInstanceSlice(_route().resolveTarget('viewer') || 'detail')?.search;
      if (search && search.active) {
        const n = search.matches.length;
        const idx = search.idx + 1;
        segs.push(`n/N [${idx}/${n}]`, 'Esc clear');
      }
    }
    return ' ' + segs.join(' | ');
  }
  if (focusKind === 'actions') {
    return ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit | Enter run';
  }
  if (focusKind === 'groups') {
    return ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit | Enter actions';
  }
  return ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit';
}

function renderFooter(model = getModel()) {
  // cmdline mode replaces the footer with its own prompt — drawing the
  // footer first would flicker on every keystroke as renderCmdline() then
  // overwrites it.
  if (model.modes.cmdMode) return;
  const COLS = cols(), ROWS = rows();
  const inModal = modes.isModal();
  const layoutSlice = getInstanceSlice('layout') || { viewMode: 'normal', dirty: false };

  // Left side: mode message OR (panel hints + plugin keyHints +
  // multi-select indicator + footer:left decorator). Modal footers
  // own the row — no plugin contributions appended.
  // Hoist focus + def once — used here and again at the list-select tag
  // below. Each getPanelDef() can walk arrange for docker-style focus.
  const focus = getFocus();
  const focusDef = getPanelDef(focus);
  let keys = footerKeys(model);
  if (!inModal) {
    if (focusDef && focusDef.keyHints) keys += ` | ${esc(focusDef.keyHints)}`;
    const msCount = multiSelCount(focus);
    if (msCount > 0) keys += ` | ${esc(`[${msCount} sel]`)}`;
    // Surface layout-dirty state to non-modal users too. They might
    // have left free-config mode with pending changes; the indicator
    // reminds them `:save-layout` exists. Free-config footer adds
    // its own dirty marker in footerKeys() to keep modal layout
    // self-contained.
    if (layoutSlice.dirty) keys += ` | [yellow]• unsaved (:save-layout)[/]`;
  }

  // Component footer contributions (Phase 5 — viewContributions slots
  // `footerLeft` / `footerRight`). Suppressed in modal footers (the
  // message owns the row). Note the separator is the heavy pipe `│`,
  // distinguishing contributor output from the regular `|`-separated
  // key hints. Each contributor receives its own Component slice as the
  // first arg + this `ctx` as the second.
  let footerLeftExtra = '', footerRightExtra = '';
  if (!inModal) {
    const ctxBase = { focus: getFocus(), view: layoutSlice.viewMode };
    const halfBudget = Math.max(0, Math.floor(COLS / 2) - 4);
    footerLeftExtra  = collectViewContributions('footerLeft',  { ...ctxBase, width: halfBudget });
    footerRightExtra = collectViewContributions('footerRight', { ...ctxBase, width: halfBudget });
    if (footerLeftExtra) keys += ` │ ${footerLeftExtra}`;
  }

  // Layout notice — a transient hint set by layout.update when a free-
  // config / view-mode transition is refused (kind: 'error', red) OR a
  // successful column-edit action (kind: 'info', green). noticeKind
  // defaults to 'error' when omitted so legacy refusal sites keep their
  // red color without explicit annotation. Cleared by layout.update on
  // the next state change that resolves the block.
  const layoutNotice = layoutSlice.freeConfig && layoutSlice.freeConfig.notice;
  if (layoutNotice) {
    const kind = (layoutSlice.freeConfig && layoutSlice.freeConfig.noticeKind) || 'error';
    const color = kind === 'info' ? 'bold green' : 'bold red';
    keys += ` | [${color}]${esc(layoutNotice)}[/]`;
  }

  // Boot warnings — soft diagnostics surfaced by parse (today: column
  // over soft cap). Yellow so it reads as advisory, not an error.
  // Cleared by `:dismiss-warnings` or next config reload.
  const bw = layoutSlice.bootWarnings;
  if (bw && bw.length > 0) {
    keys += ` | [yellow]⚠ ${bw.length} config warning(s) (:dismiss-warnings)[/]`;
  }

  // Right tail: footer:right + visual-select tag + view-mode tag.
  // The visual-select tag (`[v-char]` / `[v-line]`) is a precursor to
  // the configurable status-bar segments planned for v0.5/v0.6 — when
  // that lands, this becomes one of several registered widgets, but
  // for now it's hardcoded next to the existing [half]/[full] tag.
  const rightTail = footerRightExtra ? `${footerRightExtra} │ ` : '';
  // List-select tag only when the armed mode actually applies — i.e.
  // focus is on a list panel. (The flag can stay armed while focus is
  // on a non-list panel, where space falls back to the leader.)
  // focusDef hoisted at the top of this function.
  const selectActive = model.modes.listSelectMode && focusDef && typeof focusDef.getItems === 'function';
  const sel = getInstanceSlice(_route().resolveTarget('viewer') || 'detail')?.select;
  const selectTag = (sel && sel.active)
    ? ` \\[${sel.kind === 'line' ? 'v-line' : 'v-char'}]`
    : (selectActive ? ' \\[select]' : '');
  const vm = layoutSlice.viewMode;
  const modeTag = vm !== 'normal' ? ` \\[${vm}]` : '';

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
  stdout.write(`\x1b[${ROWS};1H` + richToAnsi(footerMarkup) + RESET);
}

module.exports = { footerKeys, renderFooter };
