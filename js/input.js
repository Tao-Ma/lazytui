/**
 * Input layer — raw stdin → key events; SGR mouse parsing → click events.
 *
 * Parses:
 *   - SGR mouse: \x1b[<button;x;yM (press) / m (release), left clicks only
 *   - Arrow keys, PgUp/Dn, Esc, Enter, Ctrl+C — into named keys
 *   - Anything else — passed through as both `key` and `seq` to handleKey
 *
 * Terminal mode bypasses parsing: bytes go straight to the active PTY,
 * except Ctrl+\ which exits terminal mode.
 */
'use strict';

const { S, allPanels, selectGroup, setSel, getSel, getScroll } = require('./state');
const { render } = require('./layout');
const { switchToTab, showSelectedInfo } = require('./detail');
const { enableMouse, enableFocusEvents, enableBracketedPaste } = require('./term');
const { isTerminalTab, activeTerminalId } = require('./tabs');
const { writeToSession, isSessionDead } = require('./terminal');
const { getPanelDef, getItems } = require('./plugins/api');
const { handleKey } = require('./dispatch');
const { cleanup } = require('./cleanup');

// --- Mouse handling ---

function handleMouse(kind, x, y) {
  // x, y are 1-based from SGR; convert to 0-based
  const mx = x - 1;
  const my = y - 1;

  // Design mode owns the entire mouse pipeline — drag state machine,
  // drop validation, layout mutation. Routed through one entry point
  // so the state machine can see press → motion+ → release in order.
  if (S.designMode) {
    const { onMouseEvent } = require('./design');
    onMouseEvent(kind, mx, my);
    render();
    return;
  }

  // Non-design-mode: only fire on press. Motion/release are 1002-protocol
  // chatter that the focus+select path doesn't care about.
  if (kind !== 'press') return;

  let mutated = false;

  for (const p of allPanels()) {
    const b = S.panelBounds[p.type];
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;

    // Detail panel — top border row may be a tab bar; check tab bounds.
    // Bounds are published into S.panelBounds.detail.tabs by the detail
    // panel's render path (plugins/core/detail.js#detailTitle).
    if (p.type === 'detail') {
      if (my === b.y) {
        const localX = mx - b.x;
        const tabs = b.tabs || [];
        for (const tab of tabs) {
          if (localX >= tab.x && localX < tab.x + tab.w) {
            S.focus = 'detail';
            switchToTab(tab.tabIdx);
            mutated = true;
            break;
          }
        }
      }
      if (!mutated) {
        S.focus = 'detail';
        mutated = true;
      }
      break;
    }

    // Other panels — focus + select clicked item.
    S.focus = p.type;
    const itemRow = my - b.y - 1;  // -1 for top border
    if (itemRow >= 0) {
      const def = getPanelDef(p.type);
      if (def && typeof def.getItems === 'function') {
        const items = getItems(p.type, S);
        // getScroll defaults to 0 — only file-manager actually scrolls
        const idx = itemRow + getScroll(p.type);
        if (idx < items.length) {
          if (p.type === 'groups') selectGroup(idx);
          else setSel(p.type, idx);
        }
      }
    }
    showSelectedInfo();
    mutated = true;
    break;
  }

  // Single paint at end — same contract as dispatch.handleKey. Diff
  // render makes a no-op paint cheap when click missed every panel.
  if (mutated) render();
}

// --- Stdin setup ---

function setupKeyListener() {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  enableMouse();             // SGR-mode mouse click reporting
  enableFocusEvents();       // \e[I on focus gain, \e[O on focus loss
  enableBracketedPaste();    // \e[200~ ... \e[201~ wraps pasted blocks

  stdin.on('data', (data) => {
    // Terminal mode: forward raw bytes to PTY (Ctrl+\ exits)
    if (S.terminalMode) {
      if (data === '\x1c') {
        // Ctrl+\ — exit terminal mode, focus stays on detail
        S.terminalMode = false;
        render();
        return;
      }
      const id = activeTerminalId();
      if (!id || isSessionDead(id)) {
        // Shell died — exit terminal mode, ignore keystroke
        S.terminalMode = false;
        render();
        return;
      }
      writeToSession(id, data);
      return;
    }

    // Terminal focus events (DEC 1004). On blur, the periodic
    // refresh loop in tui.js pauses; on focus return, we fire one
    // catch-up refresh immediately so stale data doesn't show.
    if (data === '\x1b[I') {
      const wasUnfocused = !S.focused;
      S.focused = true;
      if (wasUnfocused) require('./render-queue').scheduleRender();
      return;
    }
    if (data === '\x1b[O') {
      S.focused = false;
      return;
    }

    // Bracketed paste — collapse the bracketed block into a single
    // 'paste' event rather than dispatching per-byte. Currently
    // forwarded to dispatch as a 'paste' key with the inner text in
    // `seq`; mode handlers that care (prompt, cmdline) handle the
    // multi-line content; other modes treat it as a no-op.
    if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
      const text = data.slice('\x1b[200~'.length, -'\x1b[201~'.length);
      handleKey('paste', text);
      return;
    }

    // SGR mouse events: \x1b[<button;x;yM (press / motion) or m (release).
    // button encoding (SGR bits): low 2 = button index (0=left, 1=middle,
    // 2=right), bit 5 (0x20) = motion-while-held. We track left-only and
    // emit one of three kinds:
    //   press   — initial button-down
    //   motion  — cursor moved while button held (only with mode 1002)
    //   release — button up
    // Non-design code paths only care about 'press' (focus + select);
    // design-mode drag uses all three.
    const mouseMatch = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (mouseMatch) {
      const btn      = parseInt(mouseMatch[1]);
      const x        = parseInt(mouseMatch[2]);
      const y        = parseInt(mouseMatch[3]);
      const released = mouseMatch[4] === 'm';
      const motion   = (btn & 0x20) !== 0;
      const button   = btn & 3;
      if (button !== 0) return;  // left button only
      const kind = released ? 'release' : motion ? 'motion' : 'press';
      handleMouse(kind, x, y);
      return;
    }
    if (data === '\x1b[A') handleKey('up');
    else if (data === '\x1b[B') handleKey('down');
    else if (data === '\x1b[C') handleKey('right');
    else if (data === '\x1b[D') handleKey('left');
    else if (data === '\x1b[5~') handleKey('pageup');
    else if (data === '\x1b[6~') handleKey('pagedown');
    else if (data === '\x1b') handleKey('escape');
    else if (data === '\r' || data === '\n') handleKey('return');
    else if (data === '\x03') { cleanup(); process.exit(0); }
    else if (data === '\x12') handleKey('ctrl-r');  // Ctrl+R → design-mode redo
    // Defensive Esc fallthrough: some terminals (and Node buffering
    // states) deliver a bare Esc as `\x1b\x1b` or `\x1b<followup>` in
    // a single chunk. The strict `data === '\x1b'` check above misses
    // those, and the catch-all below would dispatch the raw bytes as
    // an opaque key string that no mode handler recognizes. Treat any
    // chunk starting with `\x1b` that survived the specific-sequence
    // checks as Esc — mode handlers exit cleanly. Trailing bytes are
    // discarded (lazytui doesn't bind any Alt/Meta combinations).
    else if (data.charCodeAt(0) === 0x1b) handleKey('escape');
    else handleKey(data, data);
  });
}

module.exports = { setupKeyListener };
