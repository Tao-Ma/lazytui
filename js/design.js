/**
 * Design mode — interactive panel layout editor.
 *
 * Pure overlay + runtime-state mutation. enterDesign/handleDesignKey
 * only mutate `S.layout` and a module-private `designState`. Rendering
 * is owned by layout.render(), which calls renderDesignOverlay() when
 * S.designMode is set. This keeps design on the same render pipeline
 * as every other mode (copy/menu/filter) — no parallel renderMain()
 * loop, no drift from the themed footer / overlay precedence.
 *
 * **Save is decoupled.** Design mode mutates S.layout in place and
 * sets `S.layoutDirty = true`. Persisting to YAML is a separate verb:
 * the `:save-layout` cmdline command writes the current layout to the
 * config file via `js/yaml-layout.js`. Exiting design mode with `q`,
 * `Esc`, or Enter does NOT auto-write — the user runs `:save-layout`
 * when they want their changes on disk.
 *
 * Keys:
 *   ↑/↓       Select panel
 *   J/K       Reorder panel within column (shift+j/k)
 *   ←/→       Move panel between columns
 *   +/-       Resize (left width or detail height %)
 *   Enter     Exit design mode (does NOT save — use :save-layout)
 *   q/Esc     Exit design mode (does NOT save — use :save-layout)
 */
'use strict';

const { esc, RESET, richToAnsi } = require('./ansi');
const { renderPanel } = require('./panel');
const { cols, rows, stdout } = require('./term');
const { S } = require('./state');

let designState = null; // null when not in design mode

/**
 * Enter design mode. While active, S.layout IS the working draft —
 * mutations flow directly through the normal render path so live
 * preview is automatic. Save is NOT auto-attached to exit; mutations
 * persist at runtime, and the `:save-layout` cmdline command writes
 * them to YAML. The caller is responsible for triggering the next
 * render once `onDone` fires.
 *
 * @param {object} layout    - reference to S.layout (kept for symmetry)
 * @param {string} configPath - path to YAML file (kept for symmetry)
 * @param {function} onDone   - callback() when design mode exits
 */
function enterDesign(layout, configPath, onDone) {
  designState = {
    selectedIdx: 0,
    configPath,
    onDone,
  };
  S.designMode = true;
}

function allDesignPanels() {
  return [...S.layout.leftPanels, ...S.layout.rightPanels];
}

/**
 * Footer text contribution for renderFooter (read when S.designMode).
 * Returns ` | <title> (<column>)` or '' when no panel is selected.
 */
function getDesignFooter() {
  if (!designState) return '';
  const all = allDesignPanels();
  const sel = all[designState.selectedIdx];
  return sel ? ` | ${sel.title} (${sel.column})` : '';
}

/**
 * Paint the centered design overlay. Called from layout.render() after
 * panels + footer are drawn, so the overlay sits on top of live preview.
 */
function renderDesignOverlay() {
  if (!designState) return;
  const COLS = cols(), ROWS = rows();
  const all = allDesignPanels();
  const sel = designState.selectedIdx;

  const leftLines = [];
  leftLines.push(`  [bold]LEFT[/] (width: ${S.layout.leftWidth})`);
  leftLines.push('');
  S.layout.leftPanels.forEach((p, i) => {
    if (i === sel) {
      leftLines.push(`[reverse]  (${p.hotkey}) ${esc(p.title)}`);
    } else {
      leftLines.push(`  (${p.hotkey}) ${esc(p.title)}`);
    }
  });
  if (S.layout.leftPanels.length === 0) {
    leftLines.push('  [dim](empty)[/]');
  }

  const rightLines = [];
  rightLines.push(`  [bold]RIGHT[/]`);
  rightLines.push('');
  const leftCount = S.layout.leftPanels.length;
  S.layout.rightPanels.forEach((p, i) => {
    const globalIdx = leftCount + i;
    const extra = p.type === 'detail' ? ` (${S.layout.detailHeightPct}%)` : '';
    if (globalIdx === sel) {
      rightLines.push(`[reverse]  (${p.hotkey}) ${esc(p.title)}${extra}`);
    } else {
      rightLines.push(`  (${p.hotkey}) ${esc(p.title)}${extra}`);
    }
  });
  if (S.layout.rightPanels.length === 0) {
    rightLines.push('  [dim](empty)[/]');
  }

  const allLines = [
    '',
    ...leftLines,
    '',
    '  ─────────────────────────────',
    '',
    ...rightLines,
    '',
    '  ─────────────────────────────',
    '',
    '  [dim]↑↓[/] select  [dim]J/K[/] reorder  [dim]←→[/] move column',
    '  [dim]+/-[/] resize  [dim]Enter[/] save  [dim]q/Esc[/] cancel',
    '',
  ];

  const panelW = Math.min(50, Math.max(30, COLS - 4));
  const panelH = Math.min(allLines.length + 2, ROWS - 2);
  const content = renderPanel({
    width: panelW, height: panelH, lines: allLines,
    title: 'Design Mode', focused: true,
    count: [sel + 1, all.length],
  });

  const offY = Math.max(0, Math.floor((ROWS - panelH) / 2));
  const offX = Math.max(0, Math.floor((COLS - panelW) / 2));

  // Build one string with embedded cursor moves, write once. Same
  // pattern as panel.renderOverlay — fewer syscalls, no tearing under
  // load on slow TTYs.
  const panelLines = content.split('\n');
  let buf = '';
  for (let i = 0; i < panelLines.length; i++) {
    buf += `\x1b[${offY + i + 1};${offX + 1}H` + richToAnsi(panelLines[i]) + RESET;
  }
  stdout.write(buf);
}

function handleDesignKey(key) {
  const all = allDesignPanels();
  const sel = designState.selectedIdx;
  const selPanel = all[sel];
  if (!selPanel) return;

  const isLeft = sel < S.layout.leftPanels.length;
  const localIdx = isLeft ? sel : sel - S.layout.leftPanels.length;
  const column = isLeft ? S.layout.leftPanels : S.layout.rightPanels;

  switch (key) {
    case 'up': case 'k':
      if (sel > 0) designState.selectedIdx--;
      break;
    case 'down': case 'j':
      if (sel < all.length - 1) designState.selectedIdx++;
      break;

    case 'K':
      if (localIdx > 0) {
        [column[localIdx], column[localIdx - 1]] = [column[localIdx - 1], column[localIdx]];
        designState.selectedIdx--;
        reassignHotkeys();
        S.layoutDirty = true;
      }
      break;
    case 'J':
      if (localIdx < column.length - 1) {
        [column[localIdx], column[localIdx + 1]] = [column[localIdx + 1], column[localIdx]];
        designState.selectedIdx++;
        reassignHotkeys();
        S.layoutDirty = true;
      }
      break;

    case 'left': case 'h':
      if (!isLeft && selPanel.type !== 'detail' && selPanel.type !== 'actions') {
        if (S.layout.leftPanels.length < 6) {
          S.layout.rightPanels.splice(localIdx, 1);
          S.layout.leftPanels.push(selPanel);
          selPanel.column = 'left';
          designState.selectedIdx = S.layout.leftPanels.length - 1;
          reassignHotkeys();
          S.layoutDirty = true;
        }
      }
      break;
    case 'right': case 'l':
      if (isLeft && S.layout.rightPanels.length < 3) {
        S.layout.leftPanels.splice(localIdx, 1);
        const detailIdx = S.layout.rightPanels.findIndex(p => p.type === 'detail');
        const insertAt = detailIdx >= 0 ? detailIdx : S.layout.rightPanels.length;
        S.layout.rightPanels.splice(insertAt, 0, selPanel);
        selPanel.column = 'right';
        selPanel.hotkey = '';
        designState.selectedIdx = S.layout.leftPanels.length + insertAt;
        reassignHotkeys();
        S.layoutDirty = true;
      }
      break;

    case '+': case '=':
      if (selPanel.type === 'detail') {
        S.layout.detailHeightPct = Math.min(90, S.layout.detailHeightPct + 5);
        S.layoutDirty = true;
      } else if (isLeft) {
        S.layout.leftWidth = Math.min(60, S.layout.leftWidth + 2);
        S.layoutDirty = true;
      }
      break;
    case '-':
      if (selPanel.type === 'detail') {
        S.layout.detailHeightPct = Math.max(20, S.layout.detailHeightPct - 5);
        S.layoutDirty = true;
      } else if (isLeft) {
        S.layout.leftWidth = Math.max(20, S.layout.leftWidth - 2);
        S.layoutDirty = true;
      }
      break;

    // Enter and q/Esc both exit design mode without writing. Use
    // `:save-layout` to persist runtime changes. (Pre-decoupled
    // behavior: Enter saved, q/Esc reverted to entry snapshot.
    // Neither survives because save is now its own verb.)
    case 'return':
    case 'q': case 'escape': {
      const cb = designState.onDone;
      designState = null;
      S.designMode = false;
      cb();
      return;
    }
  }

  const newAll = allDesignPanels();
  if (designState.selectedIdx >= newAll.length) designState.selectedIdx = newAll.length - 1;
  if (designState.selectedIdx < 0) designState.selectedIdx = 0;
}

function reassignHotkeys() {
  S.layout.leftPanels.forEach((p, i) => { p.hotkey = String(i + 1); });
  S.layout.rightPanels.forEach(p => {
    if (p.type === 'actions') p.hotkey = '0';
    else if (p.type === 'detail') p.hotkey = 'o';
    else p.hotkey = '';
  });
}

module.exports = { enterDesign, handleDesignKey, renderDesignOverlay, getDesignFooter };
