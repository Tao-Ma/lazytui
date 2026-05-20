/**
 * Layout calculation and view mode rendering.
 * Zero dependencies (uses local modules).
 */
'use strict';

const { RESET, richToAnsi, esc, visibleLen } = require('./ansi');
const { refreshSize, cols, rows, stdout, showCursor, hideCursor } = require('./term');
const { S, allPanels, syncPanelScroll, multiSelCount } = require('./state');
const { theme } = require('./themes');
const { isTerminalTab, activeTerminalId, activeTerminalConfig,
        getTabInfo, findEphemeralByid } = require('./tabs');
const { ensureSession, getSession, resizeSession } = require('./terminal');
const { getPanelDef } = require('./plugins/api');
const { showSelectedInfo } = require('./detail');
const { renderCopyMenu } = require('./copy');
const { renderMenu } = require('./menu');
const { renderCmdline } = require('./cmdline');
const { renderConfirmOverlay } = require('./confirm');
const { renderPromptOverlay } = require('./prompt');
const { renderDesignOverlay, getDesignFooter } = require('./design');
const { decorate } = require('./decorators');
const { currentText: filterCurrentText } = require('./filter');

/**
 * Look up the render function for a panel type. Plugin contract:
 *   render(panel, width, height, state) → string
 * Height is now passed explicitly by every caller (renderNormal/Half/Full)
 * — no fallback to S.panelHeights. Plugin renderers should treat the
 * height arg as authoritative; reading S.panelHeights inside a renderer
 * is implicit coupling to the layout pass and breaks half/full view
 * modes that supply a different height.
 */
function rendererFor(type) {
  const def = getPanelDef(type);
  if (!def || !def.render) return null;
  return (panel, w, h) => def.render(panel, w, h, S);
}

// --- Layout calculation ---

function calcLayout() {
  refreshSize();
  const COLS = cols(), ROWS = rows();

  // Adaptive: shrink left column on narrow terminals
  const minRight = 20;
  let leftW = S.layout.leftWidth;
  if (COLS < leftW + minRight) {
    leftW = Math.max(10, COLS - minRight);
  }
  const rightW = Math.max(minRight, COLS - leftW);
  const availH = Math.max(6, ROWS - 1);

  // Minimum panel height: 3 rows (border + 1 content line)
  const minH = 3;

  S.panelHeights = {};
  const nLeft = S.layout.leftPanels.length;
  if (nLeft > 0) {
    const baseH = Math.floor(availH / nLeft);
    S.layout.leftPanels.forEach((p, i) => {
      const h = i === nLeft - 1 ? availH - baseH * (nLeft - 1) : baseH;
      S.panelHeights[p.type] = Math.max(minH, h);
    });
  }

  const detailH = Math.max(minH, Math.floor(availH * S.layout.detailHeightPct / 100));
  const nonDetail = S.layout.rightPanels.filter(p => p.type !== 'detail');
  if (nonDetail.length) {
    const restH = Math.max(minH, availH - detailH);
    const each = Math.floor(restH / nonDetail.length);
    nonDetail.forEach((p, i) => {
      const h = i === nonDetail.length - 1 ? restH - each * (nonDetail.length - 1) : each;
      S.panelHeights[p.type] = Math.max(minH, h);
    });
  }
  S.panelHeights.detail = detailH;

  // Heights settled — keep each panel's scroll offset such that the selected
  // item is in view. Done here (not inside render) so renderers stay pure
  // and resize alone (without selection movement) still re-syncs scroll.
  for (const p of [...S.layout.leftPanels, ...S.layout.rightPanels]) {
    if (p.type === 'detail') continue;
    syncPanelScroll(p.type, S.panelHeights[p.type] - 2);
  }

  return { leftW, rightW, availH };
}

// --- Render modes ---
// _prevRows holds the markup string written for each screen row so the next
// frame can write only rows that actually changed. clearScreen() on every
// frame caused a visible flash; lazygit/tcell avoid it by diffing — same
// trick the terminal overlay below already uses (session.prevFrame).
let _prevRows = [];
let _prevCols = 0;
let _forceFullRepaint = true;
let _wasOverlayActive = false;

/**
 * Paint left + right column outputs to the screen. `leftOutput` and
 * `rightOutput` are markup strings already rendered by the panel renderers;
 * they may each span multiple panels (multi-line). Pass empty string for
 * the right side in single-column modes (full).
 */
function paintColumns(leftOutput, rightOutput) {
  const COLS = cols();
  const leftRows = leftOutput ? leftOutput.split('\n') : [];
  const rightRows = rightOutput ? rightOutput.split('\n') : [];
  const maxRows = Math.max(leftRows.length, rightRows.length);

  const newRows = new Array(maxRows);
  for (let i = 0; i < maxRows; i++) {
    newRows[i] = (leftRows[i] || '') + (rightRows[i] || '');
  }

  // Width or row-count change → layout reshapes, can't trust per-row diff.
  if (COLS !== _prevCols || maxRows !== _prevRows.length) _forceFullRepaint = true;
  _prevCols = COLS;

  let out = '';
  let didFull = false;
  if (_forceFullRepaint) {
    out += '\x1b[2J\x1b[H';
    for (let i = 0; i < maxRows; i++) {
      out += `\x1b[${i + 1};1H` + richToAnsi(newRows[i]) + RESET + '\x1b[K';
    }
    _forceFullRepaint = false;
    didFull = true;
  } else {
    for (let i = 0; i < maxRows; i++) {
      if (newRows[i] !== _prevRows[i]) {
        out += `\x1b[${i + 1};1H` + richToAnsi(newRows[i]) + RESET + '\x1b[K';
      }
    }
  }
  _prevRows = newRows;
  if (out) stdout.write(out);
  return didFull;
}

function renderNormal() {
  const { leftW, rightW } = calcLayout();
  // Reset bounds — stale entries from a prior view-mode mustn't be hit-testable.
  S.panelBounds = {};
  let leftY = 0;
  const leftOutputs = S.layout.leftPanels.map(p => {
    const h = S.panelHeights[p.type] || 0;
    S.panelBounds[p.type] = { x: 0, y: leftY, w: leftW, h };
    leftY += h;
    const fn = rendererFor(p.type);
    return fn ? fn(p, leftW, h) : '';
  });
  let rightY = 0;
  const rightOutputs = S.layout.rightPanels.map(p => {
    const h = S.panelHeights[p.type] || 0;
    S.panelBounds[p.type] = { x: leftW, y: rightY, w: rightW, h };
    rightY += h;
    const fn = rendererFor(p.type);
    return fn ? fn(p, rightW, h) : '';
  });
  return paintColumns(leftOutputs.join('\n'), rightOutputs.join('\n'));
}

function renderHalf() {
  calcLayout();
  const COLS = cols(), ROWS = rows();
  const halfW = Math.floor(COLS / 2);
  const availH = ROWS - 1;
  const focusedPanel = allPanels().find(p => p.type === S.focus);
  if (!focusedPanel) return renderNormal();
  const detailPanel = S.layout.rightPanels.find(p => p.type === 'detail');
  S.panelBounds = {};
  S.panelBounds[focusedPanel.type] = { x: 0, y: 0, w: halfW, h: availH };
  if (detailPanel) S.panelBounds.detail = { x: halfW, y: 0, w: COLS - halfW, h: availH };
  const fn = rendererFor(focusedPanel.type);
  const leftContent = fn ? fn(focusedPanel, halfW, availH) : '';
  const detailFn = detailPanel ? rendererFor('detail') : null;
  const rightContent = detailFn ? detailFn(detailPanel, halfW, availH) : '';
  return paintColumns(leftContent, rightContent);
}

function renderFull() {
  calcLayout();
  const COLS = cols(), ROWS = rows();
  const availH = ROWS - 1;
  const focusedPanel = allPanels().find(p => p.type === S.focus);
  if (!focusedPanel) return renderNormal();
  S.panelBounds = {};
  S.panelBounds[focusedPanel.type] = { x: 0, y: 0, w: COLS, h: availH };
  const fn = rendererFor(focusedPanel.type);
  const content = fn ? fn(focusedPanel, COLS, availH) : '';
  return paintColumns(content, '');
}

let _forceOverlayFull = true;
let _lastOverlayId = null;

function renderTerminalOverlay() {
  if (!isTerminalTab()) return;
  const id = activeTerminalId();
  const termConf = activeTerminalConfig();
  if (!id || !termConf) return;

  const bounds = S.panelBounds.detail;
  if (!bounds) return;
  const innerW = bounds.w - 2;
  const innerH = bounds.h - 2;

  // Lazy-create session on first render
  const session = ensureSession(id, termConf.cmd, innerW, innerH);

  // Resize if dimensions changed (also invalidates diff cache)
  if (session.xterm.cols !== innerW || session.xterm.rows !== innerH) {
    resizeSession(id, innerW, innerH);
    _forceOverlayFull = true;
  }
  // Switching to a different session — force full redraw
  if (id !== _lastOverlayId) {
    _forceOverlayFull = true;
    _lastOverlayId = id;
  }

  // Diff-based render: only rewrite rows whose content changed since the
  // previous overlay write. trimRight=false + pad so shorter lines fully
  // overwrite prior content within the changed row.
  const buffer = session.xterm.buffer.active;
  if (!session.prevFrame) session.prevFrame = [];
  const force = _forceOverlayFull;
  _forceOverlayFull = false;

  let out = '';
  for (let row = 0; row < innerH; row++) {
    const line = buffer.getLine(row + buffer.viewportY);
    let text = line ? line.translateToString(false, 0, innerW) : '';
    if (text.length < innerW) text += ' '.repeat(innerW - text.length);
    if (!force && session.prevFrame[row] === text) continue;
    out += `\x1b[${bounds.y + row + 2};${bounds.x + 2}H${text}${RESET}`;
    session.prevFrame[row] = text;
  }

  // Show exit prompt if process died (overlay on bottom content row)
  if (session.exited) {
    if (S.terminalMode) S.terminalMode = false;
    const msg = ` Process exited: ${session.exitCode} — Enter restart, x close `;
    const text = msg.length > innerW ? msg.slice(0, innerW) : msg;
    const padding = Math.max(0, Math.floor((innerW - text.length) / 2));
    out += `\x1b[${bounds.y + innerH + 1};${bounds.x + 2 + padding}H\x1b[7m${text}\x1b[0m`;
  }

  // Position screen cursor at PTY cursor when in terminal mode.
  // Visibility (show/hide) is no longer emitted here — it's derived
  // once at the end of render() from S.terminalMode || S.cmdMode.
  if (S.terminalMode && !session.exited) {
    const cx = bounds.x + 2 + buffer.cursorX;
    const cy = bounds.y + 2 + buffer.cursorY;
    out += `\x1b[${cy};${cx}H`;
  }
  stdout.write(out);
}

function render() {
  // Only force-full-repaint on overlay CLOSE (residue wipe). While an
  // overlay is open, the main paint diff is still valid — main rows
  // haven't changed under the popup, and the overlay redraws itself
  // on each keypress, so we'd just be flashing the screen for nothing.
  // All overlay flags must appear here, otherwise residue lingers when
  // an event-driven render fires while/just-after the overlay is open
  // (e.g. crashloop container spamming docker events with prompt up).
  const overlayActive = S.copyMode || S.menuOpen || S.designMode
                     || S.cmdMode || S.confirmMode || S.promptMode;
  if (_wasOverlayActive && !overlayActive) _forceFullRepaint = true;
  _wasOverlayActive = overlayActive;

  let mainDidFull;
  if (S.viewMode === 'half') mainDidFull = renderHalf();
  else if (S.viewMode === 'full') mainDidFull = renderFull();
  else mainDidFull = renderNormal();
  // Only force the terminal-overlay repaint when main paint actually
  // cleared the screen (resize, overlay-close, first frame). In the
  // steady state main paint is diff-based and leaves the PTY region
  // untouched, so the overlay's own diff cache is enough.
  if (mainDidFull) _forceOverlayFull = true;
  renderTerminalOverlay();
  renderFooter();
  // Overlays are mutually exclusive in practice (modeChain enforces it).
  // Order matches dispatch.js's modeChain: design > menu > copy.
  if (S.copyMode)    renderCopyMenu();
  if (S.menuOpen)    renderMenu();
  if (S.designMode)  renderDesignOverlay();
  if (S.cmdMode)     renderCmdline();
  if (S.confirmMode) renderConfirmOverlay();
  if (S.promptMode)  renderPromptOverlay();

  // Cursor visibility — derived from mode state, single emission site.
  // Cursor *position* is set inline by renderTerminalOverlay (when in
  // terminal mode), renderCmdline (cursor at typed-text end), and
  // renderPromptOverlay (cursor inside the prompt's input row); here
  // we only flip whether it's visible. Eliminates the bug class where
  // a mode forgets to call hideCursor() / showCursor() on exit.
  if (S.terminalMode || S.cmdMode || S.promptMode) showCursor();
  else hideCursor();
}

/**
 * Refresh the focused panel's info into detail, then render. The previous
 * pattern was render(); showSelectedInfo(); render(); — two paints with an
 * info-update sandwiched. showSelectedInfo() mutates S.detailLines, so the
 * leading render painted stale info. redraw() collapses to a single paint
 * with up-to-date info.
 */
function redraw() {
  showSelectedInfo();
  render();
}

// Debouncing primitives live in render-queue.js (both terminal.js and
// actions.js need scheduleOverlay / scheduleRender; render-queue.js has no
// dependencies, breaking what would otherwise be a cycle through layout).
require('./render-queue').setRenderers({ render, overlay: renderTerminalOverlay });

/**
 * Build the keys-string for the footer's left half. Modal footers
 * (terminal / filter / copy / design / menu) own the message; the
 * standard non-modal footer is built from segments. Returns the
 * leading-space-prefixed concatenation ready for assembly.
 */
function footerKeys() {
  if (S.terminalMode) {
    const tconf = activeTerminalConfig();
    const label = tconf ? tconf.label : 'terminal';
    return ` \\[terminal: ${esc(label)}] | Ctrl+\\ return to TUI`;
  }
  if (S.filterMode) return ` /${esc(filterCurrentText())}│ | Esc clear | Enter ok`;
  if (S.copyMode)   return ' ↑↓ select | Esc cancel | Enter copy';
  if (S.designMode) return ` Design Mode${getDesignFooter()}`;
  if (S.menuOpen)   return ' ↑↓ select | Esc close | Enter run';

  if (S.focus === 'detail') {
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
    }
    return ' ' + segs.join(' | ');
  }
  if (S.focus === 'actions') {
    return ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit | Enter run';
  }
  if (S.focus === 'groups') {
    return ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit | Enter actions';
  }
  return ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit';
}

function renderFooter() {
  // cmdline mode replaces the footer with its own prompt — drawing the
  // footer first would flicker on every keystroke as renderCmdline() then
  // overwrites it.
  if (S.cmdMode) return;
  const COLS = cols(), ROWS = rows();
  const inModal = S.terminalMode || S.filterMode || S.copyMode || S.designMode || S.menuOpen;

  // Left side: mode message OR (panel hints + plugin keyHints +
  // multi-select indicator + footer:left decorator). Modal footers
  // own the row — no plugin contributions appended.
  let keys = footerKeys();
  if (!inModal) {
    const def = getPanelDef(S.focus);
    if (def && def.keyHints) keys += ` | ${esc(def.keyHints)}`;
    const msCount = multiSelCount(S.focus);
    if (msCount > 0) keys += ` | ${esc(`[${msCount} sel]`)}`;
  }

  // Plugin footer decorations — DECORATORS.md `footer:left` / `footer:right`.
  // Suppressed in modal footers (the message owns the row). Note the
  // separator is the heavy pipe `│`, distinguishing decorator output
  // from the regular `|`-separated key hints.
  let footerLeftExtra = '', footerRightExtra = '';
  if (!inModal) {
    const ctxBase = { S, focus: S.focus, view: S.viewMode };
    const halfBudget = Math.max(0, Math.floor(COLS / 2) - 4);
    footerLeftExtra  = decorate('footer:left',  { ...ctxBase, width: halfBudget });
    footerRightExtra = decorate('footer:right', { ...ctxBase, width: halfBudget });
    if (footerLeftExtra) keys += ` │ ${footerLeftExtra}`;
  }

  // Right tail: footer:right + view-mode tag (`[half]` / `[full]`).
  const rightTail = footerRightExtra ? `${footerRightExtra} │ ` : '';
  const modeTag = S.viewMode !== 'normal' ? ` \\[${S.viewMode}]` : '';

  // Pad left → right tail → mode tag, using visible width math (esc'd
  // [ characters and double-width chars must not throw the alignment).
  const visLen = visibleLen(keys) + visibleLen(rightTail) + visibleLen(modeTag);
  const padding = ' '.repeat(Math.max(0, COLS - visLen));
  const footerMarkup = `[${theme().footer}]${keys}${padding}${rightTail}${modeTag}[/]`;
  stdout.write(`\x1b[${ROWS};1H` + richToAnsi(footerMarkup) + RESET);
}

/**
 * Invalidate the per-row diff cache so the next render() does a
 * full-screen clear + repaint. Used after the terminal has been
 * touched by something outside our control: a suspended shell
 * (SIGCONT path), an external subprocess, a docker compose spawn
 * that returned.
 */
function forceFullRepaint() {
  _prevRows = [];
  _forceFullRepaint = true;
}

module.exports = {
  calcLayout, render, redraw, renderFooter, renderTerminalOverlay,
  forceFullRepaint,
};
