/**
 * Design mode — interactive panel layout editor.
 *
 * Pure overlay + state mutation. enterDesign/handleDesignKey only
 * mutate S.layout and the local designState; rendering is owned by
 * layout.render(), which calls renderDesignOverlay() when S.designMode
 * is set. This keeps design on the same render pipeline as every other
 * mode (copy/menu/filter) — no parallel renderMain() loop, no drift
 * from the themed footer / overlay precedence.
 *
 * Keys:
 *   ↑/↓       Select panel
 *   J/K       Reorder panel within column (shift+j/k)
 *   ←/→       Move panel between columns
 *   +/-       Resize (left width or detail height %)
 *   Enter     Save to YAML
 *   q/Esc     Cancel
 */
'use strict';

const fs = require('fs');
const { esc, RESET, richToAnsi } = require('./ansi');
const { renderPanel } = require('./panel');
const { cols, rows, stdout } = require('./term');
const { S } = require('./state');

let designState = null; // null when not in design mode

/**
 * Enter design mode. While active, S.layout IS the working draft —
 * mutations here flow directly through the normal render path so live
 * preview is automatic. Cancel restores S.layout from a snapshot taken
 * on entry. Caller is responsible for triggering the next render.
 *
 * @param {object} layout - reference to S.layout
 * @param {string} configPath - path to YAML file for saving
 * @param {function} onDone - callback(savedLayout|null) when done
 */
function enterDesign(layout, configPath, onDone) {
  designState = {
    original: {
      leftWidth: layout.leftWidth,
      leftPanels: layout.leftPanels.map(p => ({ ...p })),
      rightPanels: layout.rightPanels.map(p => ({ ...p })),
      detailHeightPct: layout.detailHeightPct,
    },
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
      }
      break;
    case 'J':
      if (localIdx < column.length - 1) {
        [column[localIdx], column[localIdx + 1]] = [column[localIdx + 1], column[localIdx]];
        designState.selectedIdx++;
        reassignHotkeys();
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
      }
      break;

    case '+': case '=':
      if (selPanel.type === 'detail') {
        S.layout.detailHeightPct = Math.min(90, S.layout.detailHeightPct + 5);
      } else if (isLeft) {
        S.layout.leftWidth = Math.min(60, S.layout.leftWidth + 2);
      }
      break;
    case '-':
      if (selPanel.type === 'detail') {
        S.layout.detailHeightPct = Math.max(20, S.layout.detailHeightPct - 5);
      } else if (isLeft) {
        S.layout.leftWidth = Math.max(20, S.layout.leftWidth - 2);
      }
      break;

    case 'return':
      saveLayout();
      return;

    case 'q': case 'escape': {
      const orig = designState.original;
      S.layout.leftWidth = orig.leftWidth;
      S.layout.leftPanels = orig.leftPanels;
      S.layout.rightPanels = orig.rightPanels;
      S.layout.detailHeightPct = orig.detailHeightPct;
      const cb = designState.onDone;
      designState = null;
      S.designMode = false;
      cb(null);
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

function saveLayout() {
  const configPath = designState.configPath;
  const ly = S.layout;

  const yamlLines = ['layout:'];
  yamlLines.push('  left:');
  yamlLines.push(`    width: ${ly.leftWidth}`);
  yamlLines.push('    panels:');
  for (const p of ly.leftPanels) {
    yamlLines.push(`      - type: ${p.type}`);
    yamlLines.push(`        title: ${p.title}`);
  }
  yamlLines.push('  right:');
  yamlLines.push('    panels:');
  for (const p of ly.rightPanels) {
    yamlLines.push(`      - type: ${p.type}`);
    yamlLines.push(`        title: ${p.title}`);
    if (p.type === 'detail') {
      yamlLines.push(`        height: ${ly.detailHeightPct}%`);
    }
  }
  const newLayoutYaml = yamlLines.join('\n');

  // Surface any I/O error (H2 — used to be silently swallowed).
  let saveError = null;
  try {
    let content = fs.readFileSync(configPath, 'utf8');
    const lines = content.split('\n');
    let layoutStart = -1;
    let layoutEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^layout:/.test(lines[i])) {
        layoutStart = i;
      } else if (layoutStart >= 0 && layoutEnd < 0 && /^\S/.test(lines[i]) && i > layoutStart) {
        layoutEnd = i;
      }
    }
    if (layoutStart >= 0) {
      if (layoutEnd < 0) layoutEnd = lines.length;
      while (layoutEnd > layoutStart && lines[layoutEnd - 1].trim() === '') layoutEnd--;
      lines.splice(layoutStart, layoutEnd - layoutStart, newLayoutYaml);
    } else {
      const groupsIdx = lines.findIndex(l => /^groups:/.test(l));
      if (groupsIdx >= 0) {
        lines.splice(groupsIdx, 0, newLayoutYaml, '');
      } else {
        lines.push('', newLayoutYaml);
      }
    }
    fs.writeFileSync(configPath, lines.join('\n'));
  } catch (e) {
    saveError = e;
  }

  const result = {
    leftWidth: ly.leftWidth,
    leftPanels: ly.leftPanels,
    rightPanels: ly.rightPanels,
    detailHeightPct: ly.detailHeightPct,
    saveError,
  };
  const cb = designState.onDone;
  designState = null;
  S.designMode = false;
  cb(result);
}

module.exports = { enterDesign, handleDesignKey, renderDesignOverlay, getDesignFooter };
