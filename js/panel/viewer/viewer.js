/**
 * Core Component — detail (the viewer).
 *
 * Owns the viewer slice (`lines` / `scroll` / `tab` / `search` /
 * `select` / `cursor` / `contentTabs` / `ephemeralTerminals`). Every
 * viewer-* mutation is handled inside `update(msg, slice)` here; the
 * root reducer doesn't touch the slice.
 *
 * Cross-layer concerns:
 *   - When a viewer write also flips model.modes / getFocus() (tab-open
 *     focuses 'detail' + sets/clears terminalMode; search enter/commit toggles
 *     detailSearchMode), the slice write happens inline and the cross-layer
 *     flag write is returned as an apply_msg Cmd (root reducer applies it).
 *   - When the cascade originates in the root reducer (group change in
 *     nav_select clears viewer chrome), it emits a dispatch_msg Cmd carrying
 *     viewer_reset_chrome → routed back here by the Component fan-out.
 *
 * Tab bar rendering (the Info | actionTabs | termTabs | contentTabs strip
 * and tab click bounds) stays inside this module's render path so the panel
 * def is the single home for the viewer's view.
 */
'use strict';

const { getTabInfo, isTerminalTab, activeContentTab } = require('./tabs');
const {
  esc, visibleLen, renderPanel,
  getComponentSlice, getFocus, getPanelDef, getItems, wrap,
} = require('../api');
const ms = require('../../leaves/search');
const mt = require('../../leaves/tabs');
const { getModel } = require('../../app/runtime');
const { getSel } = require('../../app/state');
const { isStreaming } = require('../../io/stream');

// --- internal slice mutators ---
//
// Shared by the explicit `select_*` Msg arms (mouse path dispatches them via
// overlay/select.js) and the visual-mode keyboard handler in the `key` arm.
// All three perform the same slice writes — clamp + mutate in place. The
// `_moveCursor` helper resolves display width through overlay/select.js's
// pure ANSI-aware reader.

function _beginSelect(slice, line, col, kind) {
  const n = slice.lines.length;
  const l = n === 0 ? 0 : Math.max(0, Math.min(n - 1, line | 0));
  const c = Math.max(0, col | 0);
  slice.select = {
    active: true,
    kind: kind === 'line' ? 'line' : 'char',
    anchor: { line: l, col: c },
    cursor: { line: l, col: c },
  };
  slice.cursor = { line: l, col: c };
}

function _setCursor(slice, line, col, extend) {
  if (!slice.cursor) slice.cursor = { line: 0, col: 0 };
  slice.cursor.line = line | 0;
  slice.cursor.col = col | 0;
  if (extend && slice.select && slice.select.active) {
    slice.select.cursor = { line: slice.cursor.line, col: slice.cursor.col };
  }
  const innerH = Math.max(1, (getComponentSlice('layout').panelHeights.detail || 0) - 2);
  const top = slice.scroll || 0;
  if (slice.cursor.line < top) slice.scroll = slice.cursor.line;
  else if (slice.cursor.line >= top + innerH) slice.scroll = slice.cursor.line - innerH + 1;
}

function _scrollView(slice, delta) {
  const innerH = Math.max(1, (getComponentSlice('layout').panelHeights.detail || 0) - 2);
  const maxScroll = Math.max(0, slice.lines.length - innerH);
  slice.scroll = Math.max(0, Math.min(maxScroll, (slice.scroll || 0) + (delta || 0)));
}

function _moveCursor(slice, dline, dcol) {
  const cur = slice.cursor || { line: 0, col: 0 };
  const n = slice.lines.length;
  if (n === 0) return;
  const newLine = Math.max(0, Math.min(n - 1, cur.line + dline));
  let newCol = (dcol === 0) ? cur.col : Math.max(0, cur.col + dcol);
  const select = require('../../overlay/select');
  const w = select.plainLineWidth(newLine);
  newCol = (w === 0) ? 0 : Math.min(w - 1, newCol);
  const active = !!(slice.select && slice.select.active);
  _setCursor(slice, newLine, newCol, active);
}

// --- init ---

function init() {
  return {
    lines: [],
    scroll: 0,
    tab: 0,
    search: { active: false, term: '', matches: [], idx: 0, typing: '' },
    select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
    cursor: { line: 0, col: 0 },
    contentTabs: {},          // [groupName]: { [key]: { label, lines } }
    ephemeralTerminals: {},   // [groupName]: { [key]: { cmd, label } }
  };
}

// --- update (the viewer_* reducer; absorbed from runtime.update Phase B) ---

function update(msg, slice) {
  switch (msg.type) {
    case 'viewer_set_content': {
      slice.lines = Array.isArray(msg.lines) ? msg.lines : [];
      slice.scroll = 0;
      if (slice.search && slice.search.active) {
        slice.search = { active: false, term: '', matches: [], idx: 0, typing: '' };
      }
      return slice;
    }
    case 'viewer_show_info': {
      // Pull focused-Navigator info into the viewer — the Navigator→Viewer
      // cascade rides the single-writer pathway. Skip if a non-Info tab is
      // active or a live stream is filling the body; cmdline's mode wrapper
      // dispatches this after every command, and we don't want to clobber
      // stream output or content/term tabs.
      if (slice.tab !== 0) return slice;
      if (isStreaming()) return slice;
      const focus = getFocus();
      const def = getPanelDef(focus);
      if (!def || typeof def.getItems !== 'function' || typeof def.getInfo !== 'function') return slice;
      const items = getItems(focus);
      const item = items[getSel(focus)];
      if (!item) return slice;
      const lines = def.getInfo(item);
      if (lines && lines.length) {
        slice.lines = lines.join('\n').split('\n');
        slice.scroll = 0;
      }
      return slice;
    }
    case 'viewer_scroll': {
      const viewport = (getComponentSlice('layout').panelHeights.detail || 0) - 2;
      const maxScroll = Math.max(0, slice.lines.length - viewport);
      let next;
      if (msg.to === 'top') next = 0;
      else if (msg.to === 'bottom') next = maxScroll;
      else next = slice.scroll + (msg.delta || 0);
      slice.scroll = Math.max(0, Math.min(maxScroll, next));
      return slice;
    }
    case 'viewer_append': {
      const innerH = Math.max(1, (getComponentSlice('layout').panelHeights.detail || 10) - 2);
      const maxScroll = Math.max(0, slice.lines.length - innerH);
      const wasAtBottom = slice.scroll >= maxScroll;
      slice.lines.push(msg.line);
      if (wasAtBottom) slice.scroll = Math.max(0, slice.lines.length - innerH);
      return slice;
    }
    case 'stream_start':
      // Streamed command output: header replaces body, scroll reset. Lives
      // here (not in viewer_set_content) because callers conceptualize it as
      // "start a streaming session" — the lines write is the side effect.
      slice.lines = [msg.header];
      slice.scroll = 0;
      return slice;
    case 'viewer_set_tab':
      slice.tab = msg.tab | 0;
      return slice;
    case 'tab_switch': {
      // The full tab-switch cascade — orchestrates the cross-layer concerns
      // (kill streaming proc, exit terminal mode, then dispatch the per-
      // kind body update) that the bare `viewer_set_tab` primitive doesn't.
      // Emitted from the mouse tab-click in input.js and from `tab_cycle`
      // (next_tab/prev_tab); setActiveTab() keeps using the bare primitive
      // when callers just want to flip the tab number without the cascade.
      const { actionTabs, termTabs, total } = getTabInfo();
      const idx = msg.idx | 0;
      if (idx < 0 || idx >= total) return slice;
      slice.tab = idx;
      const effects = [
        { type: 'kill_proc' },
        { type: 'apply_msg', msg: { type: 'terminal_exit' } },
      ];
      if (idx === 0) {
        effects.push({ type: 'dispatch_msg', msg: wrap('detail', { type: 'viewer_show_info' }) });
      } else if (idx <= actionTabs.length) {
        const [key, act] = actionTabs[idx - 1];
        effects.push({ type: 'stream_action', actionKey: key, script: act.script });
      } else if (idx <= actionTabs.length + termTabs.length) {
        // Terminal tab — content rendered by overlay, clear detail body.
        slice.lines = [];
        slice.scroll = 0;
      } else {
        const ct = activeContentTab();
        if (ct) {
          const [, info] = ct;
          slice.lines = (info.lines || []).slice();
          slice.scroll = 0;
        }
      }
      return [slice, effects];
    }
    case 'tab_cycle': {
      // next_tab / prev_tab keyboard verbs land here — compute the wrapped
      // index and re-emit through tab_switch so both keyboard and mouse
      // paths share the cascade.
      const { total } = getTabInfo();
      if (total <= 1) return slice;
      const next = (slice.tab + (msg.dir | 0) + total) % total;
      return [slice, [{ type: 'dispatch_msg', msg: wrap('detail', { type: 'tab_switch', idx: next }) }]];
    }
    case 'viewer_reset_chrome': {
      // Dispatched (via dispatch_msg Cmd) from the groups Component when a
      // tree cascade changes currentGroup. Single-writer per layer: root
      // chrome reset goes through the reset_group_context Msg; the viewer-
      // slice half lives here. See Phase A.
      slice.tab = 0;
      if (slice.select) slice.select.active = false;
      slice.cursor = { line: 0, col: 0 };
      return slice;
    }

    // --- viewer-search (typing phase, folded into the viewer Component).
    // leaves/search writes only the slice; the detailSearchMode flag (root
    // chrome) is set/cleared via apply_msg → mode_set / mode_clear.
    case 'viewer_search_enter': {
      const r = ms.enter(slice);
      return [slice, r.enableSearchMode
        ? [{ type: 'apply_msg', msg: { type: 'mode_set', flag: 'detailSearchMode' } }]
        : []];
    }
    case 'viewer_search_key':    ms.keystroke(slice, msg.seq); return slice;
    case 'viewer_search_nav':    (msg.dir > 0 ? ms.next(slice) : ms.prev(slice)); return slice;
    case 'viewer_search_commit': {
      const r = ms.commit(slice);
      return [slice, r.disableSearchMode
        ? [{ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'detailSearchMode' } }]
        : []];
    }
    case 'viewer_search_cancel': {
      const r = ms.cancel(slice);
      return [slice, r.disableSearchMode
        ? [{ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'detailSearchMode' } }]
        : []];
    }

    // --- tab lifecycle. leaves/tabs leaves write only the slice; the
    // cross-layer modes/focus changes go out as apply_msg Cmds.
    case 'viewer_add_ephemeral_terminal': {
      const out = mt.addEphemeral(slice, getModel(), msg);
      const effects = [];
      // focus_set is layout-owned (Phase 1c). Phase 2a — inner msg wrapped
      // so the dispatch_msg handler routes through layout directly.
      if (out.focusDetail)   effects.push({ type: 'dispatch_msg', msg: require('../api').wrap('layout', { type: 'focus_set', focus: 'detail' }) });
      if (out.terminalEnter) effects.push({ type: 'apply_msg', msg: { type: 'terminal_enter' } });
      return [slice, effects];
    }
    case 'viewer_remove_ephemeral_terminal': {
      const { sessionId, terminalExit } = mt.removeEphemeral(slice, getModel(), msg);
      const effects = [];
      if (sessionId)    effects.push({ type: 'destroy_pty_session', id: sessionId });
      if (terminalExit) effects.push({ type: 'apply_msg', msg: { type: 'terminal_exit' } });
      return [slice, effects];
    }
    case 'viewer_add_content_tab': {
      const out = mt.addContent(slice, getModel(), msg);
      const effects = [];
      // focus_set is layout-owned (Phase 1c). Phase 2a — wrapped (see addEphemeral).
      if (out.focusDetail)  effects.push({ type: 'dispatch_msg', msg: require('../api').wrap('layout', { type: 'focus_set', focus: 'detail' }) });
      if (out.terminalExit) effects.push({ type: 'apply_msg', msg: { type: 'terminal_exit' } });
      return [slice, effects];
    }
    case 'viewer_update_content_tab_lines':
      mt.updateContentLines(slice, getModel(), msg);
      return slice;
    case 'viewer_remove_content_tab': {
      const { needShowSelectedInfo } = mt.removeContent(slice, getModel(), msg);
      return [slice, needShowSelectedInfo ? [{ type: 'show_selected_info' }] : []];
    }

    // --- visual-mode select. The mouse path dispatches the select_* Msgs
    // (overlay/select.js); the keyboard path lives in `case 'key':` below.
    // Both flow through the same slice mutators (`_beginSelect`/`_setCursor`/
    // `_scrollView`/`_moveCursor`) defined above the reducer. The pure ANSI-
    // aware reads (selectedText / plainLineWidth) stay in select.js.
    case 'select_begin':
      _beginSelect(slice, msg.line, msg.col, msg.kind);
      return slice;
    case 'select_extend': {
      if (!slice.select || !slice.select.active) return slice;
      const n = slice.lines.length;
      const l = n === 0 ? 0 : Math.max(0, Math.min(n - 1, msg.line | 0));
      slice.select.cursor = { line: l, col: Math.max(0, msg.col | 0) };
      return slice;
    }
    case 'select_cancel':
      if (slice.select) slice.select.active = false;
      return slice;
    case 'select_set_cursor':
      _setCursor(slice, msg.line, msg.col, msg.extend);
      return slice;
    case 'select_scroll_view':
      _scrollView(slice, msg.delta);
      return slice;

    // --- keyboard: the detail-panel visual-mode state machine. Lives here
    // (instead of as a dispatch.js hijack) because the claim is conditional
    // on slice state — the `_claimed` sentinel returned with `[slice, …]`
    // is consumed by `dispatchKeyToFocused` to gate the framework default.
    //
    // Two modes:
    //   Reading mode (no selection active):
    //     j / down  scroll +1
    //     k / up    scroll -1
    //     h / l     NOT claimed → framework focus-shift
    //     v / V     enter char / line visual
    //     n / N     search-nav (when committed search is active)
    //   Visual mode (selection active):
    //     j / k / h / l / arrows  cursor + extend
    //     0 / $ / Home / End      cursor jump
    //     y                       commit → register_push
    //     v / V                   toggle off
    //     escape                  cancel
    case 'key': {
      const m = getModel();
      if (getFocus() !== 'detail' || m.modes.terminalMode) return slice;
      // Higher-priority modes (menu/cmd/etc.) are filtered upstream by the
      // modeChain in dispatch.handleKey; this guard is belt-and-suspenders.
      if (m.modes.menuOpen || m.modes.cmdMode || m.modes.confirmMode ||
          m.modes.promptMode || m.modes.copyMode) return slice;

      const active = !!(slice.select && slice.select.active);
      const claim = [{ type: '_claimed' }];

      // Detail-search post-commit n/N nav; Esc clears.
      if (slice.search && slice.search.active) {
        if (msg.seq === 'n' || msg.key === 'n') { ms.next(slice); return [slice, claim]; }
        if (msg.seq === 'N' || msg.key === 'N') { ms.prev(slice); return [slice, claim]; }
        if (msg.key === 'escape' && !active)    { ms.clearCommitted(slice); return [slice, claim]; }
      }

      // v / V — toggle visual mode. Anchor at the top of the current viewport
      // (matches what mouse-drag effectively does — cursor where it lands).
      if (msg.seq === 'v' || msg.key === 'v') {
        if (active && slice.select.kind === 'char') slice.select.active = false;
        else _beginSelect(slice, slice.scroll || 0, 0, 'char');
        return [slice, claim];
      }
      if (msg.seq === 'V' || msg.key === 'V') {
        if (active && slice.select.kind === 'line') slice.select.active = false;
        else _beginSelect(slice, slice.scroll || 0, 0, 'line');
        return [slice, claim];
      }

      // y — commit + push to register. The text resolution + OSC52 ride out
      // as apply_msg → register_push (root reducer owns the register).
      if ((msg.seq === 'y' || msg.key === 'y') && active) {
        const text = require('../../overlay/select').selectedText();
        slice.select.active = false;
        const effects = [{ type: '_claimed' }];
        if (text) effects.push({ type: 'apply_msg', msg: { type: 'register_push', text } });
        return [slice, effects];
      }
      if (msg.key === 'escape' && active) {
        slice.select.active = false;
        return [slice, claim];
      }

      // Vertical movement: reading → scroll view, visual → cursor + extend.
      if (msg.key === 'down' || msg.seq === 'j' || msg.key === 'j') {
        if (active) _moveCursor(slice, +1, 0);
        else        _scrollView(slice, +1);
        return [slice, claim];
      }
      if (msg.key === 'up' || msg.seq === 'k' || msg.key === 'k') {
        if (active) _moveCursor(slice, -1, 0);
        else        _scrollView(slice, -1);
        return [slice, claim];
      }

      // Horizontal h/l — only claim in visual mode so reading-mode focus-shift
      // still works (`l` to step out of detail into the next panel).
      if (active) {
        if (msg.key === 'left'  || msg.seq === 'h' || msg.key === 'h') { _moveCursor(slice, 0, -1); return [slice, claim]; }
        if (msg.key === 'right' || msg.seq === 'l' || msg.key === 'l') { _moveCursor(slice, 0, +1); return [slice, claim]; }
      }

      // 0 / $ — line-start / line-end jumps. Only meaningful with a cursor.
      if (active && (msg.seq === '0' || msg.key === 'home')) {
        _setCursor(slice, slice.cursor.line, 0, true);
        return [slice, claim];
      }
      if (active && (msg.seq === '$' || msg.key === 'end')) {
        const w = require('../../overlay/select').plainLineWidth(slice.cursor.line);
        _setCursor(slice, slice.cursor.line, Math.max(0, w - 1), true);
        return [slice, claim];
      }
      return slice;
    }
    default:
      return slice;
  }
}

// --- panel renderer (reads the slice directly) ---

function detailTitle(slice) {
  const tabBounds = [];
  const { actionTabs, termTabs, contentTabs } = getTabInfo();
  const layoutSlice = getComponentSlice('layout');
  if (layoutSlice && layoutSlice.panelBounds.detail) layoutSlice.panelBounds.detail.tabs = tabBounds;
  if (!actionTabs.length && !termTabs.length && !contentTabs.length) return 'Detail';
  const parts = [];
  const tab = slice.tab;
  // Phase 5 — per-tab decorator slot retired; the decorate framework had
  // no in-tree contributor and gave plugins no realistic seam (tab labels
  // are panel-managed). Tabs render plain.
  const pushTab = (label, isActive) => {
    const text = esc(label);
    parts.push(isActive ? `\\[${text}]` : text);
  };
  pushTab('Info', tab === 0);
  actionTabs.forEach(([, action], i) => pushTab(action.label, tab === i + 1));
  const termOffset = 1 + actionTabs.length;
  termTabs.forEach(([, term], i) => pushTab(term.label, tab === termOffset + i));
  const contentOffset = 1 + actionTabs.length + termTabs.length;
  contentTabs.forEach(([, info], i) => pushTab(info.label, tab === contentOffset + i));
  const dp = getComponentSlice('layout').arrange.rightPanels.find(p => p.type === 'detail');
  const hotkey = dp ? dp.hotkey : '';
  let xOffset = 2 + (hotkey ? 2 + hotkey.length : 0) + 1;
  parts.forEach((part, i) => {
    if (i > 0) xOffset += 1;
    const visLen = visibleLen(part);
    tabBounds.push({ tabIdx: i, x: xOffset, w: visLen });
    xOffset += visLen;
  });
  return parts.join('─');
}

function render(panel, w, h, slice) {
  const m = getModel();
  const innerH = h - 2;
  const dp = getComponentSlice('layout').arrange.rightPanels.find(p => p.type === 'detail');
  const hotkey = dp ? dp.hotkey : '';
  const isFocused = getFocus() === 'detail' || m.modes.terminalMode;
  if (isTerminalTab()) {
    return renderPanel({
      width: w, height: h, lines: [],
      title: detailTitle(slice), hotkey,
      panelType: 'detail',
      focused: isFocused,
    });
  }
  let count = null;
  if (slice.lines.length > innerH) {
    count = [slice.scroll + innerH, slice.lines.length];
  }
  let lines = slice.lines;
  const select = require('../../overlay/select');
  const search = require('../../overlay/viewer-search');
  if (select.isActive()) {
    lines = select.decorateLines(lines);
  } else {
    lines = search.decorateLines(lines);
  }
  return renderPanel({
    width: w, height: h, lines,
    title: detailTitle(slice), hotkey,
    panelType: 'detail',
    focused: isFocused,
    count,
    scrollOffset: slice.scroll,
  });
}

module.exports = {
  name: 'detail',
  init,
  update,
  panelTypes: {
    detail: { render },
  },
  // Test-only exports — not part of the Component contract.
  _init: init,
  _update: update,
};
