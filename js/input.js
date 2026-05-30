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

const { allPanels, selectGroup, setSel, getSel, getScroll } = require('./state');
const { render } = require('./layout');
const { getModel } = require('./runtime');
const { switchToTab, showSelectedInfo } = require('./viewer');
const { enableMouse, enableFocusEvents, enableBracketedPaste, cols } = require('./term');
const { isTerminalTab, activeTerminalId } = require('./tabs');
const { writeToSession, isSessionDead } = require('./terminal');
const { getPanelDef, getItems, getComponentSlice, dispatchMsg, wrap } = require('./plugins/api');

function _detail() { return getComponentSlice('detail'); }
const { handleKey, applyMsg } = require('./dispatch');
const { cleanup } = require('./cleanup');

// --- Mouse handling ---

/**
 * Wheel-on-panel: hit-test (mx, my) against every panel's bounds and
 * scroll the one under the cursor. Returns true if any state mutated
 * (so the caller knows to repaint). Focus is intentionally NOT
 * changed — users can wheel through a side panel while keeping the
 * keyboard focused elsewhere, which is the friendlier-than-click
 * behavior most TUIs converge on.
 *
 * Per-panel behavior:
 *   detail        viewer_scroll ±1 (clamped — detail slice's `scroll`)
 *   list panels   moveSel-style ±1 on that panel's own selection
 *   anything else no-op
 *
 * In visual-mode the detail wheel still adjusts only the view; the
 * cursor's logical position stays where it is and may drift off
 * screen. Wheel back to bring it back. j/k is the way to extend the
 * selection.
 */
function _handleWheel(model, mx, my, delta) {
  for (const p of allPanels()) {
    const b = getComponentSlice('layout').panelBounds[p.type];
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;

    if (p.type === 'detail') {
      const d = _detail();
      const lines = d?.lines || [];
      const curScroll = d?.scroll || 0;
      const innerH = Math.max(1, (getComponentSlice('layout').panelHeights.detail || b.h) - 2);
      const maxScroll = Math.max(0, lines.length - innerH);
      const next = Math.max(0, Math.min(maxScroll, curScroll + delta));
      if (next === curScroll) return false;
      require('./plugins/api').dispatchMsg(require('./plugins/api').wrap('detail', { type: 'viewer_scroll', delta }));
      return true;
    }

    const def = getPanelDef(p.type);
    if (def && typeof def.getItems === 'function') {
      const items = getItems(p.type);
      if (!items.length) return false;
      const sel = getSel(p.type);
      const next = Math.max(0, Math.min(items.length - 1, sel + delta));
      if (next === sel) return false;
      if (p.type === 'groups') {
        // selectGroup has cascading side effects (resetGroupContext);
        // wheel-over should behave the same as a click on row N.
        selectGroup(next);
      } else {
        setSel(p.type, next);
      }
      // Refresh detail only when the wheel landed on the focused panel
      // (so its info reflects the new selection); wheeling over a side
      // panel without focus shouldn't clobber detail.
      if (p.type === getComponentSlice("layout").focus) showSelectedInfo(model);
      return true;
    }
    return false;
  }
  return false;
}

function handleMouse(model, kind, x, y) {
  // x, y are 1-based from SGR; convert to 0-based
  const mx = x - 1;
  const my = y - 1;

  // Design mode owns the entire mouse pipeline — the drag/resize state machine
  // now lives in the reducer (design_mouse_* Msgs running on model.modal.design
  // .drag). cols() is resolved here (the terminal read the reducer can't do)
  // and threaded into the hit-tests. Non-press/motion/release events (wheel)
  // are swallowed in design mode, as before.
  if (model.modes.designMode) {
    if (kind === 'press')        applyMsg(model, { type: 'design_mouse_press',  mx, my, cols: cols() });
    else if (kind === 'motion')  applyMsg(model, { type: 'design_mouse_motion', mx, my, cols: cols() });
    else if (kind === 'release') applyMsg(model, { type: 'design_mouse_release' });
    render(model);
    return;
  }

  // Mouse wheel — scrolls the panel under the cursor without changing
  // focus. Detail adjusts the detail scroll; list panels move their own
  // selection. No-op when the wheel landed outside any panel bounds.
  if (kind === 'wheel-up' || kind === 'wheel-down') {
    if (_handleWheel(model, mx, my, kind === 'wheel-down' ? +1 : -1)) render(model);
    return;
  }

  // Detail-panel text selection. press → begin; motion (with button
  // held) → extend; release → commit + push to register. Runs ahead
  // of the focus+select loop so dragging across panels can extend a
  // selection that started in detail rather than losing it to a focus
  // change.
  const sel = require('./select');
  if (kind === 'motion' && sel.isActive()) {
    const db = getComponentSlice('layout').panelBounds.detail;
    if (db) {
      const visibleLine = Math.max(0, Math.min(db.h - 3, my - db.y - 1));
      const col = Math.max(0, mx - db.x - 1);
      sel.extendTo((_detail()?.scroll || 0) + visibleLine, col);
      render(model);
    }
    return;
  }
  if (kind === 'release') {
    if (sel.isActive()) {
      sel.commit();
      render(model);
    }
    return;
  }

  // From here on: press only.
  if (kind !== 'press') return;

  let mutated = false;

  for (const p of allPanels()) {
    const b = getComponentSlice('layout').panelBounds[p.type];
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;

    // Detail panel — top border row may be a tab bar; otherwise a
    // click inside the content area begins a text selection.
    // Tab bounds are published into panelBounds.detail.tabs by the
    // detail panel's render path (plugins/core/viewer.js#detailTitle).
    if (p.type === 'detail') {
      if (my === b.y) {
        const localX = mx - b.x;
        const tabs = b.tabs || [];
        for (const tab of tabs) {
          if (localX >= tab.x && localX < tab.x + tab.w) {
            dispatchMsg(wrap('layout', { type: 'focus_set', focus: 'detail' }));
            switchToTab(model, tab.tabIdx);
            mutated = true;
            break;
          }
        }
      }
      if (!mutated) {
        dispatchMsg(wrap('layout', { type: 'focus_set', focus: 'detail' }));
        // Begin a selection iff the click landed in the content rows
        // and this tab actually has scrollable text content (skip
        // terminal tabs — the PTY handles its own input).
        const inContent = my > b.y && my < b.y + b.h - 1;
        const d = _detail();
        if (inContent && !isTerminalTab() && d && d.lines.length > 0) {
          const visibleLine = my - b.y - 1;
          const col = Math.max(0, mx - b.x - 1);
          sel.beginAt((d.scroll || 0) + visibleLine, col, 'char');
        } else {
          sel.cancel();
        }
        mutated = true;
      }
      break;
    }

    // Other panels — focus + select clicked item. A press anywhere
    // outside the detail content area cancels any pending selection
    // (starting a new gesture here).
    sel.cancel();
    dispatchMsg(wrap('layout', { type: 'focus_set', focus: p.type }));
    const itemRow = my - b.y - 1;  // -1 for top border
    if (itemRow >= 0) {
      const def = getPanelDef(p.type);
      if (def && typeof def.getItems === 'function') {
        const items = getItems(p.type);
        // getScroll defaults to 0 — only file-manager actually scrolls
        const idx = itemRow + getScroll(p.type);
        if (idx < items.length) {
          if (p.type === 'groups') selectGroup(idx);
          else setSel(p.type, idx);
        }
      }
    }
    showSelectedInfo(model);
    mutated = true;
    break;
  }

  // Single paint at end — same contract as dispatch.handleKey. Diff
  // render makes a no-op paint cheap when click missed every panel.
  if (mutated) render(model);
}

// --- Terminal-mode keystroke handling ---

/**
 * Handle a raw stdin chunk while getModel().modes.terminalMode is true. Extracted
 * from the stdin closure so tests can drive it directly.
 *
 * Returns true if the chunk was consumed (caller should skip the
 * rest of the input pipeline). Never returns false today — terminal
 * mode swallows everything until Ctrl+\ flips us out. Still returns
 * a bool so future expansion (e.g., chord prefixes) has a contract.
 *
 * Side effects:
 *  - `\x1c` (Ctrl+\) → terminalMode=false. If viewMode was 'full'
 *    (auto-zoom from a `type: spawn`), drops it to 'normal' and
 *    forceFullRepaints so the chrome reclaims the screen. The PTY
 *    child keeps running; the user can navigate back via tabs.
 *  - Session already dead (id missing or isSessionDead) → same
 *    flip + zoom-drop, plus the keystroke is dropped on the floor.
 *  - Live session → writeToSession forwards the bytes to the PTY.
 */
function _handleTerminalModeData(data) {
  // Ctrl+\ exits terminal mode; a dead/missing session exits too (and drops
  // the keystroke). Both flow through the terminal_exit Msg, which clears the
  // flag, drops a 'full' auto-zoom to 'normal', and emits a force_full_repaint
  // Cmd when it did so. render() paints the result.
  if (data === '\x1c') {
    applyMsg(getModel(), { type: 'terminal_exit' });
    render();
    return true;
  }
  const id = activeTerminalId();
  if (!id || isSessionDead(id)) {
    applyMsg(getModel(), { type: 'terminal_exit' });
    render();
    return true;
  }
  writeToSession(id, data);
  return true;
}

// --- Stdin setup ---

function setupKeyListener(model) {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  enableMouse();             // SGR-mode mouse click reporting
  enableFocusEvents();       // \e[I on focus gain, \e[O on focus loss
  enableBracketedPaste();    // \e[200~ ... \e[201~ wraps pasted blocks

  stdin.on('data', (data) => {
    // Terminal mode: forward raw bytes to PTY (Ctrl+\ exits)
    if (getModel().modes.terminalMode && _handleTerminalModeData(data)) return;

    // Terminal focus events (DEC 1004). On blur, the periodic
    // refresh loop in tui.js pauses; on focus return, we fire one
    // catch-up refresh immediately so stale data doesn't show.
    if (data === '\x1b[I') {
      const wasUnfocused = !getModel().focused;
      applyMsg(model, { type: 'focus_event', focused: true });
      if (wasUnfocused) require('./render-queue').scheduleRender();
      return;
    }
    if (data === '\x1b[O') {
      applyMsg(model, { type: 'focus_event', focused: false });
      return;
    }

    // Bracketed paste — collapse the bracketed block into a single
    // 'paste' event rather than dispatching per-byte. Currently
    // forwarded to dispatch as a 'paste' key with the inner text in
    // `seq`; mode handlers that care (prompt, cmdline) handle the
    // multi-line content; other modes treat it as a no-op.
    if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
      const text = data.slice('\x1b[200~'.length, -'\x1b[201~'.length);
      handleKey(model, 'paste', text);
      return;
    }

    // SGR mouse events: \x1b[<button;x;yM (press / motion) or m (release).
    // button encoding (SGR bits): low 2 = button index (0=left, 1=middle,
    // 2=right), bit 5 (0x20) = motion-while-held, bit 6 (0x40) = wheel.
    // We emit one of:
    //   press      — initial button-down
    //   motion     — cursor moved while button held (mode 1002)
    //   release    — button up
    //   wheel-up   — wheel rotated away from user (btn 64)
    //   wheel-down — wheel rotated toward user (btn 65)
    // Non-design code paths only care about 'press' / wheel; design
    // mode drag uses press/motion/release.
    const mouseMatch = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (mouseMatch) {
      const btn      = parseInt(mouseMatch[1]);
      const x        = parseInt(mouseMatch[2]);
      const y        = parseInt(mouseMatch[3]);
      const released = mouseMatch[4] === 'm';
      // Wheel events — bit 6 set. SGR mode 1006 reports both a press
      // (M) and a release (m) for each notch in some terminals; drop
      // the release to avoid double-firing.
      if ((btn & 0x40) !== 0) {
        if (released) return;
        const kind = (btn & 1) ? 'wheel-down' : 'wheel-up';
        handleMouse(model, kind, x, y);
        return;
      }
      const motion = (btn & 0x20) !== 0;
      const button = btn & 3;
      if (button !== 0) return;  // left button only for non-wheel events
      const kind = released ? 'release' : motion ? 'motion' : 'press';
      handleMouse(model, kind, x, y);
      return;
    }
    if (data === '\x1b[A') handleKey(model, 'up');
    else if (data === '\x1b[B') handleKey(model, 'down');
    else if (data === '\x1b[C') handleKey(model, 'right');
    else if (data === '\x1b[D') handleKey(model, 'left');
    else if (data === '\x1b[5~') handleKey(model, 'pageup');
    else if (data === '\x1b[6~') handleKey(model, 'pagedown');
    else if (data === '\x1b') handleKey(model, 'escape');
    else if (data === '\r' || data === '\n') handleKey(model, 'return');
    else if (data === '\x03') { cleanup(); process.exit(0); }
    else if (data === '\x12') handleKey(model, 'ctrl-r');  // Ctrl+R → design-mode redo
    // Defensive Esc fallthrough: some terminals (and Node buffering
    // states) deliver a bare Esc as `\x1b\x1b` or `\x1b<followup>` in
    // a single chunk. The strict `data === '\x1b'` check above misses
    // those, and the catch-all below would dispatch the raw bytes as
    // an opaque key string that no mode handler recognizes. Treat any
    // chunk starting with `\x1b` that survived the specific-sequence
    // checks as Esc — mode handlers exit cleanly. Trailing bytes are
    // discarded (lazytui doesn't bind any Alt/Meta combinations).
    else if (data.charCodeAt(0) === 0x1b) handleKey(model, 'escape');
    else handleKey(model, data, data);
  });
}

module.exports = {
  setupKeyListener,
  _handleTerminalModeData,  // exported for tests
  _handleWheel,             // exported for tests
};
