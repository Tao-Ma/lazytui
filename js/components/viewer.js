/**
 * Core Component — detail (the viewer).
 *
 * Owns the viewer slice (`lines` / `scroll` / `tab` / `search` /
 * `select` / `cursor` / `contentTabs` / `ephemeralTerminals`). Every
 * viewer-* mutation is handled inside `update(msg, slice)` here; the
 * root reducer doesn't touch the slice.
 *
 * Cross-layer concerns:
 *   - When a viewer write also flips model.modes / getComponentSlice("layout").focus (tab-open
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

const { getTabInfo, isTerminalTab } = require('../tabs');
const {
  esc, visibleLen, renderPanel,
  getComponentSlice,
} = require('./api');
const ms = require('../model-search');
const mt = require('../model-tabs');
const { getModel } = require('../runtime');

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
    // model-search writes only the slice; the detailSearchMode flag (root
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

    // --- tab lifecycle. model-tabs leaves write only the slice; the
    // cross-layer modes/focus changes go out as apply_msg Cmds.
    case 'viewer_add_ephemeral_terminal': {
      const out = mt.addEphemeral(slice, getModel(), msg);
      const effects = [];
      // focus_set is layout-owned (Phase 1c). Phase 2a — inner msg wrapped
      // so the dispatch_msg handler routes through layout directly.
      if (out.focusDetail)   effects.push({ type: 'dispatch_msg', msg: require('./api').wrap('layout', { type: 'focus_set', focus: 'detail' }) });
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
      if (out.focusDetail)  effects.push({ type: 'dispatch_msg', msg: require('./api').wrap('layout', { type: 'focus_set', focus: 'detail' }) });
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

    // --- visual-mode select (folded into the viewer Component). The ansi-
    // dependent text/column math (selectedText / plainLineWidth) stays in
    // select.js as pure reads; the WRITES are here. `line`/`col` are pre-
    // clamped by the caller for set_cursor; begin/extend clamp the line.
    case 'select_begin': {
      const n = slice.lines.length;
      const l = n === 0 ? 0 : Math.max(0, Math.min(n - 1, msg.line | 0));
      const c = Math.max(0, msg.col | 0);
      slice.select = { active: true, kind: msg.kind === 'line' ? 'line' : 'char', anchor: { line: l, col: c }, cursor: { line: l, col: c } };
      slice.cursor = { line: l, col: c };
      return slice;
    }
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
    case 'select_set_cursor': {
      if (!slice.cursor) slice.cursor = { line: 0, col: 0 };
      slice.cursor.line = msg.line | 0;
      slice.cursor.col = msg.col | 0;
      if (msg.extend && slice.select && slice.select.active) {
        slice.select.cursor = { line: slice.cursor.line, col: slice.cursor.col };
      }
      const innerH = Math.max(1, (getComponentSlice('layout').panelHeights.detail || 0) - 2);
      const top = slice.scroll || 0;
      if (slice.cursor.line < top) slice.scroll = slice.cursor.line;
      else if (slice.cursor.line >= top + innerH) slice.scroll = slice.cursor.line - innerH + 1;
      return slice;
    }
    case 'select_scroll_view': {
      const innerH = Math.max(1, (getComponentSlice('layout').panelHeights.detail || 0) - 2);
      const maxScroll = Math.max(0, slice.lines.length - innerH);
      slice.scroll = Math.max(0, Math.min(maxScroll, (slice.scroll || 0) + (msg.delta || 0)));
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
  const isFocused = getComponentSlice("layout").focus === 'detail' || m.modes.terminalMode;
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
  const select = require('../select');
  const search = require('../viewer-search');
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
    detail: { mode: 'content', render },
  },
  // Test-only exports — not part of the Component contract.
  _init: init,
  _update: update,
};
