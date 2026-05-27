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
const { render: renderRegisterPopup } = require('./register-popup');
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
  // Component-owned panels (v0.3.0) take precedence — a Component's
  // render gets its slice, not the global S. Falls through to the
  // plugin-owned path if no Component claimed this panelType.
  const api = require('./plugins/api');
  const compName = api.getComponentOwningPanel(type);
  if (compName) {
    const comp = api.getComponent(compName);
    const def = comp.panelTypes && comp.panelTypes[type];
    if (def && typeof def.render === 'function') {
      return (panel, w, h) => def.render(panel, w, h, api.getComponentSlice(compName));
    }
  }
  const def = getPanelDef(type);
  if (!def || !def.render) return null;
  return (panel, w, h) => def.render(panel, w, h, S);
}

// --- Layout calculation ---

/**
 * Distribute the column's `availH` rows across `panels`, writing each
 * panel's height to `S.panelHeights[panel.type]`. Three classes of
 * panel share the column:
 *
 *   1. Detail (right column only). Reserved height = `availH *
 *      detailHeightPct / 100`. Detail never carries a per-panel
 *      heightPct — the layout-level knob is its sole control.
 *   2. Anchored panels — those with an explicit `heightPct: N`.
 *      Each gets `availH * N / 100` rows.
 *   3. Flex panels — no heightPct. Split whatever remains, equally.
 *
 * If anchored + reserved would leave less than minH for each flex
 * panel, anchored shrinks proportionally (largest first) until the
 * flex panels can fit at their minimum. minH floor applies to every
 * panel — a manually oversubscribed heightPct (sum > 100) gets
 * scaled down here rather than crashing the renderer.
 */
function distributeColumnHeights(panels, availH, isRightCol, minH) {
  if (panels.length === 0) return;

  let reserved = 0;
  let detailPanel = null;
  if (isRightCol) {
    detailPanel = panels.find(p => p.type === 'detail') || null;
    if (detailPanel) {
      reserved = Math.max(minH, Math.floor(availH * S.layout.detailHeightPct / 100));
    }
  }

  const anchored = [];   // { p, h }
  const flex = [];       // panel
  let anchoredTotal = 0;
  for (const p of panels) {
    if (p === detailPanel) continue;
    if (typeof p.heightPct === 'number' && isFinite(p.heightPct)) {
      const h = Math.max(minH, Math.floor(availH * p.heightPct / 100));
      anchored.push({ p, h });
      anchoredTotal += h;
    } else {
      flex.push(p);
    }
  }

  // If anchored + reserved + (flex × minH) > availH, scale anchored
  // proportionally to the share they each claimed. Each panel still
  // floors at minH — if every anchored is at minH and the column
  // still overflows the terminal, the renderer truncates rather than
  // crashes.
  const flexMin = flex.length * minH;
  if (reserved + anchoredTotal + flexMin > availH && anchoredTotal > 0) {
    const target = Math.max(0, availH - reserved - flexMin);
    const scale = target / anchoredTotal;
    let allocated = 0;
    for (const a of anchored) {
      a.h = Math.max(minH, Math.floor(a.h * scale));
      allocated += a.h;
    }
    // Distribute slack rows (caused by flooring) to the largest panels
    // first so the visual ratios stay close to the requested split.
    let leftover = target - allocated;
    if (leftover > 0) {
      const sorted = anchored.slice().sort((a, b) => b.h - a.h);
      let i = 0;
      while (leftover > 0) { sorted[i % sorted.length].h++; leftover--; i++; }
    }
    anchoredTotal = anchored.reduce((s, a) => s + a.h, 0);
  }

  // Flex panels share whatever's left.
  const flexTotalH = Math.max(0, availH - reserved - anchoredTotal);
  if (flex.length) {
    const baseH = Math.floor(flexTotalH / flex.length);
    flex.forEach((p, i) => {
      const h = i === flex.length - 1 ? flexTotalH - baseH * (flex.length - 1) : baseH;
      S.panelHeights[p.type] = Math.max(minH, h);
    });
  }
  for (const { p, h } of anchored) S.panelHeights[p.type] = h;
  if (detailPanel) S.panelHeights[detailPanel.type] = reserved;

  // Park rounding-leftover rows on the column's last panel so the
  // column exactly fills availH (matches the pre-heightPct behavior
  // and avoids a visually empty strip at the bottom).
  let sum = 0;
  for (const p of panels) sum += S.panelHeights[p.type];
  if (sum < availH) {
    const last = panels[panels.length - 1];
    S.panelHeights[last.type] += availH - sum;
  }
}

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
  // ROWS reservation: bottom row = footer; row above that = register strip.
  // Panel grid gets `ROWS - 2`. minH (3) means we still allocate sensible
  // panel space on very short terminals; the strip falls into the footer
  // row when ROWS < 4, which is degenerate enough to not care about.
  const availH = Math.max(6, ROWS - 2);

  // Minimum panel height: 3 rows (border + 1 content line)
  const minH = 3;

  S.panelHeights = {};
  distributeColumnHeights(S.layout.leftPanels, availH, /*isRightCol*/ false, minH);
  distributeColumnHeights(S.layout.rightPanels, availH, /*isRightCol*/ true,  minH);
  // Half/full view modes read S.panelHeights.detail even when detail
  // isn't currently rendered; keep the fallback so they don't crash.
  if (!('detail' in S.panelHeights)) {
    S.panelHeights.detail = Math.max(minH, Math.floor(availH * S.layout.detailHeightPct / 100));
  }

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
  const availH = ROWS - 2;  // -2: footer + register strip rows
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
  const availH = ROWS - 2;  // -2: footer + register strip rows
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
                     || S.cmdMode || S.confirmMode || S.promptMode
                     || S.registerPopupMode;
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
  // Register strip — one row above the footer; always on. Centered overlays
  // (copy menu, prompt, etc.) paint after, so they can cover the strip when
  // their geometry happens to overlap.
  renderRegisterStrip();
  // Overlays are mutually exclusive in practice (modeChain enforces it).
  // Order matches dispatch.js's modeChain: design > menu > copy.
  if (S.copyMode)    renderCopyMenu();
  if (S.menuOpen)    renderMenu();
  if (S.designMode)  renderDesignOverlay();
  if (S.cmdMode)     renderCmdline();
  if (S.confirmMode) renderConfirmOverlay();
  if (S.promptMode)  renderPromptOverlay();
  if (S.registerPopupMode) renderRegisterPopup();

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
  if (S.prefixMode) {
    const pending = (S.prefixSeq && S.prefixSeq.length)
      ? ' ' + S.prefixSeq.join(' ')
      : '';
    return ` \\[leader]${esc(pending)}… | <key> select | Esc cancel`;
  }
  if (S.terminalMode) {
    const tconf = activeTerminalConfig();
    const label = tconf ? tconf.label : 'terminal';
    return ` \\[terminal: ${esc(label)}] | Ctrl+\\ return to TUI`;
  }
  if (S.detailSearchMode) {
    const ds = require('./detail-search');
    const term = ds.typingText();
    const n = (S.detailSearch.matches || []).length;
    const idx = n ? S.detailSearch.idx + 1 : 0;
    return ` /${esc(term)}│ \\[${idx}/${n}] | ↑↓ step | Esc cancel | Enter commit`;
  }
  if (S.filterMode) return ` /${esc(filterCurrentText())}│ | Esc clear | Enter ok`;
  if (S.copyMode)   return ' ↑↓ select | Esc cancel | Enter copy';
  if (S.designTitleEditMode) {
    const { titleEditText } = require('./design');
    return ` rename: ${esc(titleEditText())}│ | Esc cancel | Enter ok`;
  }
  if (S.designMode) {
    const dirty = S.layoutDirty ? ' | [yellow]• unsaved (:save-layout)[/]' : '';
    return ` Design Mode | drag move/resize | J/K reorder | ←→ swap col | +/- col/detail · [/] panel h | t rename | u undo | C-r redo | :save-layout | q exit${getDesignFooter()}${dirty}`;
  }
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
      segs.push('/ search');
      if (S.detailSearch && S.detailSearch.active) {
        const n = S.detailSearch.matches.length;
        const idx = S.detailSearch.idx + 1;
        segs.push(`n/N [${idx}/${n}]`, 'Esc clear');
      }
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

/**
 * Always-on yank-register strip — one row above the footer (row ROWS-1,
 * 1-indexed: ROWS-1 from rows()). Renders either `reg: (empty)` or
 * `reg: "<top>" [+N]` where N = older entries count. Multi-line tops are
 * shown with `↵` glyphs; long tops truncate with `…`. Width-budgeted so
 * the prefix/suffix always fit even on narrow terminals.
 *
 * Written outside the panel diff cache (same pattern as renderFooter)
 * because the strip lives in the chrome row, not the panel grid.
 */
function renderRegisterStrip() {
  const ROWS = rows(), COLS = cols();
  const reg = S.register;
  let content;
  if (!reg || !reg.history || reg.history.length === 0) {
    content = 'reg: (empty)';
  } else {
    const top = reg.history[0];
    const olderCount = reg.history.length - 1;
    const tail = olderCount > 0 ? ` [+${olderCount}]` : '';
    const prefix = 'reg: "';
    const suffix = `"${tail}`;
    const budget = Math.max(4, COLS - visibleLen(prefix) - visibleLen(suffix));
    let preview = String(top).replace(/\n/g, '↵').replace(/\t/g, ' ');
    if (visibleLen(preview) > budget) preview = preview.slice(0, budget - 1) + '…';
    content = prefix + esc(preview) + suffix;
  }
  const padding = ' '.repeat(Math.max(0, COLS - visibleLen(content)));
  const markup = `[${theme().footer}]${content}${padding}[/]`;
  stdout.write(`\x1b[${ROWS - 1};1H` + richToAnsi(markup) + RESET);
}

function renderFooter() {
  // cmdline mode replaces the footer with its own prompt — drawing the
  // footer first would flicker on every keystroke as renderCmdline() then
  // overwrites it.
  if (S.cmdMode) return;
  const COLS = cols(), ROWS = rows();
  const inModal = S.terminalMode || S.filterMode || S.copyMode || S.designMode || S.designTitleEditMode || S.menuOpen || S.prefixMode;

  // Left side: mode message OR (panel hints + plugin keyHints +
  // multi-select indicator + footer:left decorator). Modal footers
  // own the row — no plugin contributions appended.
  let keys = footerKeys();
  if (!inModal) {
    const def = getPanelDef(S.focus);
    if (def && def.keyHints) keys += ` | ${esc(def.keyHints)}`;
    const msCount = multiSelCount(S.focus);
    if (msCount > 0) keys += ` | ${esc(`[${msCount} sel]`)}`;
    // Surface layout-dirty state to non-modal users too. They might
    // have left design mode with pending changes; the indicator
    // reminds them `:save-layout` exists. Design-mode footer adds
    // its own dirty marker in footerKeys() to keep modal layout
    // self-contained.
    if (S.layoutDirty) keys += ` | [yellow]• unsaved (:save-layout)[/]`;
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

  // Right tail: footer:right + visual-select tag + view-mode tag.
  // The visual-select tag (`[v-char]` / `[v-line]`) is a precursor to
  // the configurable status-bar segments planned for v0.5/v0.6 — when
  // that lands, this becomes one of several registered widgets, but
  // for now it's hardcoded next to the existing [half]/[full] tag.
  const rightTail = footerRightExtra ? `${footerRightExtra} │ ` : '';
  const selectTag = (S.select && S.select.active)
    ? ` \\[${S.select.kind === 'line' ? 'v-line' : 'v-char'}]`
    : (S.listSelectMode ? ' \\[select]' : '');
  const modeTag = S.viewMode !== 'normal' ? ` \\[${S.viewMode}]` : '';

  // Pad left → right tail → tags, using visible width math (esc'd
  // [ characters and double-width chars must not throw the alignment).
  const visLen = visibleLen(keys) + visibleLen(rightTail)
               + visibleLen(selectTag) + visibleLen(modeTag);
  const padding = ' '.repeat(Math.max(0, COLS - visLen));
  const footerMarkup = `[${theme().footer}]${keys}${padding}${rightTail}${selectTag}${modeTag}[/]`;
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

/**
 * Invalidate the diff cache for a specific row range (0-based, half-open
 * — [startY, endY)). Used when an overlay shrinks and the cells it
 * previously covered need to be repainted from the underlying panels
 * on the next render. Cheaper than a full repaint when only a few rows
 * are affected.
 */
function invalidateRows(startY, endY) {
  for (let y = startY; y < endY; y++) {
    if (y >= 0 && _prevRows[y] !== undefined) {
      _prevRows[y] = '';
    }
  }
}

module.exports = {
  calcLayout, render, redraw, renderFooter, renderTerminalOverlay,
  forceFullRepaint, invalidateRows,
};
