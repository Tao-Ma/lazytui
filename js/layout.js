/**
 * Layout calculation and view mode rendering.
 *
 * Post-Phase-1e: the geometry (panelHeights / panelBounds) lives on the
 * layout Component's slice, written during the render pass. This module
 * IS the writer — the slice owns the data; the render pass refills it
 * each frame; downstream readers (per-panel render fns, mouse hit-tests,
 * design-mode drag math) read it back via getComponentSlice('layout').
 * The render is one of the regular "Component writes its own slice"
 * paths now — no longer a blessed exception.
 *
 * Zero npm dependencies (uses local modules).
 */
'use strict';

const { RESET, richToAnsi, esc, visibleLen } = require('./ansi');
const { refreshSize, cols, rows, stdout, showCursor, hideCursor } = require('./term');
const { allPanels, syncPanelScroll, multiSelCount } = require('./state');
const { theme } = require('./themes');
const { isTerminalTab, activeTerminalId, activeTerminalConfig,
        getTabInfo, findEphemeralByid } = require('./tabs');
const { ensureSession, getSession, resizeSession } = require('./terminal');
const {getPanelDef, getComponentSlice, getFocus } = require('./components/api');
const { showSelectedInfo } = require('./viewer');
const { renderCopyMenu } = require('./copy');
const { render: renderRegisterPopup } = require('./register-popup');
const { renderMenu } = require('./menu');
const { renderWhichKey } = require('./which-key');
const modes = require('./modes');
const { getModel } = require('./runtime');
const { renderCmdline } = require('./cmdline');
const { renderConfirmOverlay } = require('./confirm');
const { renderPromptOverlay } = require('./prompt');
const { renderDesignOverlay, getDesignFooter } = require('./design');
const { collectViewContributions } = require('./components/api');
const { currentText: filterCurrentText } = require('./filter');

/**
 * Look up the render function for a panel type. Contract:
 *   render(panel, width, height, state) → string
 * Height is passed explicitly by every caller (renderNormal/Half/Full).
 * Renderers should treat the height arg as authoritative; reading
 * layoutSlice.panelHeights inside a renderer is implicit coupling to
 * the layout pass and breaks half/full view modes that supply a
 * different height.
 */
function rendererFor(type) {
  // Phase 6 — every panel is a Component. The owning Component's
  // render(panel, w, h, slice) is the only render path; no fallback.
  const api = require('./components/api');
  const compName = api.getComponentOwningPanel(type);
  if (!compName) return null;
  const comp = api.getComponent(compName);
  const def = comp && comp.panelTypes && comp.panelTypes[type];
  if (!def || typeof def.render !== 'function') return null;
  return (panel, w, h) => def.render(panel, w, h, api.getComponentSlice(compName));
}

// --- Layout calculation ---

/**
 * Distribute the column's `availH` rows across `panels`, writing each
 * panel's height to the layout slice's `panelHeights[type]`. Three
 * classes of panel share the column:
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
function distributeColumnHeights(layoutSlice, panels, availH, isRightCol, minH) {
  if (panels.length === 0) return;

  let reserved = 0;
  let detailPanel = null;
  if (isRightCol) {
    detailPanel = panels.find(p => p.type === 'detail') || null;
    if (detailPanel) {
      reserved = Math.max(minH, Math.floor(availH * layoutSlice.arrange.detailHeightPct / 100));
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
      layoutSlice.panelHeights[p.type] = Math.max(minH, h);
    });
  }
  for (const { p, h } of anchored) layoutSlice.panelHeights[p.type] = h;
  if (detailPanel) layoutSlice.panelHeights[detailPanel.type] = reserved;

  // Park rounding-leftover rows on the column's last panel so the
  // column exactly fills availH (matches the pre-heightPct behavior
  // and avoids a visually empty strip at the bottom).
  let sum = 0;
  for (const p of panels) sum += layoutSlice.panelHeights[p.type];
  if (sum < availH) {
    const last = panels[panels.length - 1];
    layoutSlice.panelHeights[last.type] += availH - sum;
  }
}

function calcLayout(model = getModel()) {
  refreshSize();
  const COLS = cols(), ROWS = rows();
  const layoutSlice = getComponentSlice('layout');

  // Adaptive: shrink left column on narrow terminals
  const minRight = 20;
  let leftW = layoutSlice.arrange.leftWidth;
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

  layoutSlice.panelHeights = {};
  distributeColumnHeights(layoutSlice, layoutSlice.arrange.leftPanels, availH, /*isRightCol*/ false, minH);
  distributeColumnHeights(layoutSlice, layoutSlice.arrange.rightPanels, availH, /*isRightCol*/ true,  minH);
  // Half/full view modes read panelHeights.detail even when detail
  // isn't currently rendered; keep the fallback so they don't crash.
  if (!('detail' in layoutSlice.panelHeights)) {
    layoutSlice.panelHeights.detail = Math.max(minH, Math.floor(availH * layoutSlice.arrange.detailHeightPct / 100));
  }

  // Heights settled — keep each panel's scroll offset such that the selected
  // item is in view. Done here (not inside render) so renderers stay pure
  // and resize alone (without selection movement) still re-syncs scroll.
  for (const p of [...layoutSlice.arrange.leftPanels, ...layoutSlice.arrange.rightPanels]) {
    if (p.type === 'detail') continue;
    syncPanelScroll(p.type, layoutSlice.panelHeights[p.type] - 2);
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

// renderNormal/Half/Full take the threaded model: they read/write the
// derived layout chrome (panelBounds/panelHeights/layout/focus) on it.
// allPanels()/calcLayout() stay state-helpers; rendererFor() hands each
// panel its slice (Component) or the model (Plugin).
function renderNormal(model) {
  const { leftW, rightW } = calcLayout(model);
  const layoutSlice = getComponentSlice('layout');
  // Reset bounds — stale entries from a prior view-mode mustn't be hit-testable.
  layoutSlice.panelBounds = {};
  let leftY = 0;
  const leftOutputs = layoutSlice.arrange.leftPanels.map(p => {
    const h = layoutSlice.panelHeights[p.type] || 0;
    layoutSlice.panelBounds[p.type] = { x: 0, y: leftY, w: leftW, h };
    leftY += h;
    const fn = rendererFor(p.type);
    return fn ? fn(p, leftW, h) : '';
  });
  let rightY = 0;
  const rightOutputs = layoutSlice.arrange.rightPanels.map(p => {
    const h = layoutSlice.panelHeights[p.type] || 0;
    layoutSlice.panelBounds[p.type] = { x: leftW, y: rightY, w: rightW, h };
    rightY += h;
    const fn = rendererFor(p.type);
    return fn ? fn(p, rightW, h) : '';
  });
  return paintColumns(leftOutputs.join('\n'), rightOutputs.join('\n'));
}

function renderHalf(model) {
  calcLayout(model);
  const COLS = cols(), ROWS = rows();
  const layoutSlice = getComponentSlice('layout');
  const halfW = Math.floor(COLS / 2);
  const availH = ROWS - 2;  // -2: footer + register strip rows
  const focusedPanel = allPanels().find(p => p.type === layoutSlice.focus);
  if (!focusedPanel) return renderNormal(model);
  const detailPanel = layoutSlice.arrange.rightPanels.find(p => p.type === 'detail');
  layoutSlice.panelBounds = {};
  layoutSlice.panelBounds[focusedPanel.type] = { x: 0, y: 0, w: halfW, h: availH };
  if (detailPanel) layoutSlice.panelBounds.detail = { x: halfW, y: 0, w: COLS - halfW, h: availH };
  const fn = rendererFor(focusedPanel.type);
  const leftContent = fn ? fn(focusedPanel, halfW, availH) : '';
  const detailFn = detailPanel ? rendererFor('detail') : null;
  const rightContent = detailFn ? detailFn(detailPanel, halfW, availH) : '';
  return paintColumns(leftContent, rightContent);
}

function renderFull(model) {
  calcLayout(model);
  const COLS = cols(), ROWS = rows();
  const layoutSlice = getComponentSlice('layout');
  const availH = ROWS - 2;  // -2: footer + register strip rows
  const focusedPanel = allPanels().find(p => p.type === layoutSlice.focus);
  if (!focusedPanel) return renderNormal(model);
  layoutSlice.panelBounds = {};
  layoutSlice.panelBounds[focusedPanel.type] = { x: 0, y: 0, w: COLS, h: availH };
  const fn = rendererFor(focusedPanel.type);
  const content = fn ? fn(focusedPanel, COLS, availH) : '';
  return paintColumns(content, '');
}

let _forceOverlayFull = true;
let _lastOverlayId = null;

function renderTerminalOverlay(model = getModel()) {
  if (!isTerminalTab()) return;
  const id = activeTerminalId();
  const termConf = activeTerminalConfig();
  if (!id || !termConf) return;

  const layoutSlice = getComponentSlice('layout');
  const bounds = layoutSlice && layoutSlice.panelBounds.detail;
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
    // Route the stale-flag cleanup through update so single-writer holds —
    // terminal_exit also force_full_repaints when viewMode was 'full', which
    // is the right thing on a PTY exit anyway (chrome reclaims rows).
    if (model.modes.terminalMode) require('./dispatch').applyMsg(model, { type: 'terminal_exit' });
    const msg = ` Process exited: ${session.exitCode} — Enter restart, x close `;
    const text = msg.length > innerW ? msg.slice(0, innerW) : msg;
    const padding = Math.max(0, Math.floor((innerW - text.length) / 2));
    out += `\x1b[${bounds.y + innerH + 1};${bounds.x + 2 + padding}H\x1b[7m${text}\x1b[0m`;
  }

  // Position screen cursor at PTY cursor when in terminal mode.
  // Visibility (show/hide) is derived once at the end of render() from
  // model.modes.terminalMode || model.modes.cmdMode.
  if (model.modes.terminalMode && !session.exited) {
    const cx = bounds.x + 2 + buffer.cursorX;
    const cy = bounds.y + 2 + buffer.cursorY;
    out += `\x1b[${cy};${cx}H`;
  }
  stdout.write(out);
}

function render(model = getModel()) {
  // `model` is the TEA root model (js/runtime.js), threaded in by the
  // owner (the program). The view reads migrated slices (currently
  // `viewMode`) from this param, not a global fetch. The `= getModel()`
  // default keeps every existing `render()` call site working during
  // the v0.5 migration; it'll be removed once all callers thread it.
  // Only force-full-repaint on overlay CLOSE (residue wipe). While an
  // overlay is open, the main paint diff is still valid — main rows
  // haven't changed under the popup, and the overlay redraws itself
  // on each keypress, so we'd just be flashing the screen for nothing.
  // All overlay flags must appear here, otherwise residue lingers when
  // an event-driven render fires while/just-after the overlay is open
  // (e.g. crashloop container spamming docker events with prompt up).
  // Mode flags live nested under `model.modes`; overlay/modal helpers default
  // to getModel().modes but accept an explicit bag too.
  const md = model.modes;
  const overlayActive = modes.isOverlayActive(md);
  if (_wasOverlayActive && !overlayActive) _forceFullRepaint = true;
  _wasOverlayActive = overlayActive;

  let mainDidFull;
  // viewMode lives on the layout Component slice (Phase 1b).
  const layoutSlice = getComponentSlice('layout') || { viewMode: 'normal' };
  const viewMode = layoutSlice.viewMode;
  if (viewMode === 'half') mainDidFull = renderHalf(model);
  else if (viewMode === 'full') mainDidFull = renderFull(model);
  else mainDidFull = renderNormal(model);
  // Only force the terminal-overlay repaint when main paint actually
  // cleared the screen (resize, overlay-close, first frame). In the
  // steady state main paint is diff-based and leaves the PTY region
  // untouched, so the overlay's own diff cache is enough.
  if (mainDidFull) _forceOverlayFull = true;
  renderTerminalOverlay(model);
  renderFooter(model);
  // Register strip — one row above the footer; always on. Centered overlays
  // (copy menu, prompt, etc.) paint after, so they can cover the strip when
  // their geometry happens to overlap.
  renderRegisterStrip(model);
  // Overlays are mutually exclusive in practice (modeChain enforces it).
  // Order matches dispatch.js's modeChain: design > menu > copy.
  if (md.copyMode)    renderCopyMenu();
  if (md.menuOpen)    renderMenu();
  if (md.designMode)  renderDesignOverlay();
  if (md.cmdMode)     renderCmdline();
  if (md.confirmMode) renderConfirmOverlay();
  if (md.promptMode)  renderPromptOverlay();
  if (md.registerPopupMode) renderRegisterPopup();
  if (md.prefixMode)  renderWhichKey();

  // Cursor visibility — derived from mode state, single emission site.
  // Cursor *position* is set inline by renderTerminalOverlay (when in
  // terminal mode), renderCmdline (cursor at typed-text end), and
  // renderPromptOverlay (cursor inside the prompt's input row); here
  // we only flip whether it's visible. Eliminates the bug class where
  // a mode forgets to call hideCursor() / showCursor() on exit.
  if (md.terminalMode || md.cmdMode || md.promptMode) showCursor();
  else hideCursor();
}

/**
 * Refresh the focused panel's info into detail, then render. The previous
 * pattern was render(); showSelectedInfo(); render(); — two paints with an
 * info-update sandwiched. showSelectedInfo() writes the detail slice's
 * `lines`, so the leading render painted stale info. redraw() collapses
 * to a single paint with up-to-date info.
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
    const ds = require('./viewer-search');
    const term = ds.typingText();
    const search = getComponentSlice('detail')?.search || { matches: [], idx: 0 };
    const n = (search.matches || []).length;
    const idx = n ? search.idx + 1 : 0;
    return ` /${esc(term)}│ \\[${idx}/${n}] | ↑↓ step | Esc cancel | Enter commit`;
  }
  if (md.filterMode) return ` /${esc(filterCurrentText())}│ | Esc clear | Enter ok`;
  if (md.copyMode)   return ' ↑↓ select | Esc cancel | Enter copy';
  if (md.designTitleEditMode) {
    const { titleEditText } = require('./design');
    return ` rename: ${esc(titleEditText())}│ | Esc cancel | Enter ok`;
  }
  if (md.designMode) {
    const layoutSlice = getComponentSlice('layout');
    const dirty = (layoutSlice && layoutSlice.dirty) ? ' | [yellow]• unsaved (:save-layout)[/]' : '';
    return ` Design Mode | drag move/resize | J/K reorder | ←→ swap col | +/- col/detail · [/] panel h | t rename | u undo | C-r redo | :save-layout | q exit${getDesignFooter()}${dirty}`;
  }
  if (md.menuOpen)   return ' ↑↓ select | Esc close | Enter run';

  if (getFocus() === 'detail') {
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
      const search = getComponentSlice('detail')?.search;
      if (search && search.active) {
        const n = search.matches.length;
        const idx = search.idx + 1;
        segs.push(`n/N [${idx}/${n}]`, 'Esc clear');
      }
    }
    return ' ' + segs.join(' | ');
  }
  if (getFocus() === 'actions') {
    return ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit | Enter run';
  }
  if (getFocus() === 'groups') {
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
function renderRegisterStrip(model) {
  const ROWS = rows(), COLS = cols();
  const reg = model.register;
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

function renderFooter(model = getModel()) {
  // cmdline mode replaces the footer with its own prompt — drawing the
  // footer first would flicker on every keystroke as renderCmdline() then
  // overwrites it.
  if (model.modes.cmdMode) return;
  const COLS = cols(), ROWS = rows();
  const inModal = modes.isModal();
  const layoutSlice = getComponentSlice('layout') || { viewMode: 'normal', dirty: false };

  // Left side: mode message OR (panel hints + plugin keyHints +
  // multi-select indicator + footer:left decorator). Modal footers
  // own the row — no plugin contributions appended.
  let keys = footerKeys(model);
  if (!inModal) {
    const def = getPanelDef(getFocus());
    if (def && def.keyHints) keys += ` | ${esc(def.keyHints)}`;
    const msCount = multiSelCount(getFocus());
    if (msCount > 0) keys += ` | ${esc(`[${msCount} sel]`)}`;
    // Surface layout-dirty state to non-modal users too. They might
    // have left design mode with pending changes; the indicator
    // reminds them `:save-layout` exists. Design-mode footer adds
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

  // Right tail: footer:right + visual-select tag + view-mode tag.
  // The visual-select tag (`[v-char]` / `[v-line]`) is a precursor to
  // the configurable status-bar segments planned for v0.5/v0.6 — when
  // that lands, this becomes one of several registered widgets, but
  // for now it's hardcoded next to the existing [half]/[full] tag.
  const rightTail = footerRightExtra ? `${footerRightExtra} │ ` : '';
  // List-select tag only when the armed mode actually applies — i.e.
  // focus is on a list panel. (The flag can stay armed while focus is
  // on a non-list panel, where space falls back to the leader.)
  const focusDef = getPanelDef(getFocus());
  const selectActive = model.modes.listSelectMode && focusDef && typeof focusDef.getItems === 'function';
  const sel = getComponentSlice('detail')?.select;
  const selectTag = (sel && sel.active)
    ? ` \\[${sel.kind === 'line' ? 'v-line' : 'v-char'}]`
    : (selectActive ? ' \\[select]' : '');
  const vm = layoutSlice.viewMode;
  const modeTag = vm !== 'normal' ? ` \\[${vm}]` : '';

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
