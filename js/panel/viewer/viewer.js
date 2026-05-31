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

// --- internal slice transforms (pure return-new) ---
//
// Shared by the explicit `select_*` Msg arms (mouse path dispatches them via
// overlay/select.js) and the visual-mode keyboard handler in the `key` arm.
// Each takes the slice + payload and returns a new slice. The `_moveCursor`
// helper resolves display width through overlay/select.js's pure ANSI-aware
// reader.

function _beginSelect(slice, line, col, kind) {
  const n = slice.lines.length;
  const l = n === 0 ? 0 : Math.max(0, Math.min(n - 1, line | 0));
  const c = Math.max(0, col | 0);
  return {
    ...slice,
    select: {
      active: true,
      kind: kind === 'line' ? 'line' : 'char',
      anchor: { line: l, col: c },
      cursor: { line: l, col: c },
    },
    cursor: { line: l, col: c },
  };
}

// Effective viewport for scroll/cursor clamps. The slice's `innerH` is
// written from render() each frame (viewer_set_viewport Msg) so the
// reducer stays a pure function of (slice, msg) — no cross-slice read of
// layout's render-time geometry. The pre-first-render fallback is `1`:
// any viewer_scroll/append/cursor before paint still clamps inside
// [0, lines.length - 1] instead of overshooting (the pre-fix bug was
// `(0 || 0) - 2 = -2` viewport → `maxScroll = lines.length + 2`, leaving
// the slice with scroll past the last line until the next render).
// Tests that need a specific viewport seed `slice.innerH` directly.
function _innerH(slice) { return slice.innerH > 0 ? slice.innerH : 1; }

function _setCursor(slice, line, col, extend) {
  const cursor = { line: line | 0, col: col | 0 };
  const innerH = _innerH(slice);
  const top = slice.scroll || 0;
  let scroll = slice.scroll || 0;
  if (cursor.line < top)                       scroll = cursor.line;
  else if (cursor.line >= top + innerH)        scroll = cursor.line - innerH + 1;
  const next = { ...slice, cursor, scroll };
  if (extend && slice.select && slice.select.active) {
    next.select = { ...slice.select, cursor: { line: cursor.line, col: cursor.col } };
  }
  return next;
}

function _scrollView(slice, delta) {
  const innerH = _innerH(slice);
  const maxScroll = Math.max(0, slice.lines.length - innerH);
  const scroll = Math.max(0, Math.min(maxScroll, (slice.scroll || 0) + (delta || 0)));
  if (scroll === (slice.scroll || 0)) return slice;
  return { ...slice, scroll };
}

function _moveCursor(slice, dline, dcol) {
  const cur = slice.cursor || { line: 0, col: 0 };
  const n = slice.lines.length;
  if (n === 0) return slice;
  const newLine = Math.max(0, Math.min(n - 1, cur.line + dline));
  let newCol = (dcol === 0) ? cur.col : Math.max(0, cur.col + dcol);
  const select = require('../../overlay/select');
  const w = select.plainLineWidth(newLine);
  newCol = (w === 0) ? 0 : Math.min(w - 1, newCol);
  const active = !!(slice.select && slice.select.active);
  return _setCursor(slice, newLine, newCol, active);
}

// --- init ---

function init() {
  return {
    lines: [],
    scroll: 0,
    tab: 0,
    // Effective viewport rows (panel height minus 2-row border chrome).
    // Written from render() via viewer_set_viewport once the layout pass
    // settles a panelBounds.detail — owning slice, not cross-slice, so the
    // reducer is a pure function of (slice, msg). 0 = not-yet-rendered;
    // _innerH() falls back to lines.length in that degenerate so clamps
    // collapse to "everything fits".
    innerH: 0,
    search: { active: false, term: '', matches: [], idx: 0, typing: '' },
    select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
    cursor: { line: 0, col: 0 },
    contentTabs: {},          // [groupName]: { [key]: { label, lines } }
    ephemeralTerminals: {},   // [groupName]: { [key]: { cmd, label } }
    // Tab-list overlay (the `[≡]` switcher anchored to detail's top-left).
    // `cursor` is the row index in the flat tab list (Info..actions..
    // terminals..content); `scroll` is the first visible row when the
    // overlay's body is smaller than the tab count.
    tabList: { open: false, cursor: 0, scroll: 0 },
  };
}

// --- update (the viewer_* reducer; absorbed from runtime.update Phase B) ---

function update(msg, slice) {
  switch (msg.type) {
    case 'viewer_set_content': {
      const next = {
        ...slice,
        lines: Array.isArray(msg.lines) ? msg.lines : [],
        scroll: 0,
      };
      if (slice.search && slice.search.active) {
        next.search = { active: false, term: '', matches: [], idx: 0, typing: '' };
      }
      return next;
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
      if (!lines || lines.length === 0) return slice;
      return { ...slice, lines: lines.join('\n').split('\n'), scroll: 0 };
    }
    case 'viewer_scroll': {
      const innerH = _innerH(slice);
      const maxScroll = Math.max(0, slice.lines.length - innerH);
      let next;
      if (msg.to === 'top') next = 0;
      else if (msg.to === 'bottom') next = maxScroll;
      else next = slice.scroll + (msg.delta || 0);
      const scroll = Math.max(0, Math.min(maxScroll, next));
      if (scroll === slice.scroll) return slice;
      return { ...slice, scroll };
    }
    case 'viewer_set_viewport': {
      // Render-side cache update. layout.render() dispatches this after
      // panelBounds settle so subsequent reducer-only scroll/append/cursor
      // clamps don't have to reach into the layout slice. Identity-preserve
      // on no-op (cheap render-tail call when nothing changed).
      const innerH = Math.max(0, msg.innerH | 0);
      if (innerH === slice.innerH) return slice;
      return { ...slice, innerH };
    }
    case 'viewer_append': {
      // Hot path — streamed action output can fire 500-1000 lines/sec.
      // Per the arc rule, no in-place exception: spread lines fresh each
      // call. Phase 6 benchmarks (docs/v0.5-perf.md, run via
      // `node js/test/bench-hotpaths.js`) show 21k ops/sec at 10k-line
      // buffer and 5.7k ops/sec at 50k — comfortably above the sustained
      // 1k/sec target. If field reports show pressure on long-running
      // streams (100k+ lines / GC pauses), the documented mitigations
      // are ring-buffer trim or a coalesced/batched append Msg.
      const innerH = _innerH(slice);
      const maxScroll = Math.max(0, slice.lines.length - innerH);
      const wasAtBottom = slice.scroll >= maxScroll;
      const lines = [...slice.lines, msg.line];
      const scroll = wasAtBottom ? Math.max(0, lines.length - innerH) : slice.scroll;
      return { ...slice, lines, scroll };
    }
    case 'stream_start':
      // Streamed command output: header replaces body, scroll reset. Lives
      // here (not in viewer_set_content) because callers conceptualize it as
      // "start a streaming session" — the lines write is the side effect.
      return { ...slice, lines: [msg.header], scroll: 0 };
    case 'viewer_set_tab': {
      const tab = msg.tab | 0;
      if (tab === slice.tab) return slice;
      return { ...slice, tab };
    }
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
      let next = { ...slice, tab: idx };
      const effects = [
        { type: 'kill_proc' },
        { type: 'apply_msg', msg: { type: 'terminal_exit' } },
      ];
      if (idx === 0) {
        // Wipe lines+scroll BEFORE show_selected_info fires. The Cmd
        // repopulates iff focus is on a navigator; when focus is detail
        // (the common case after clicking the Info tab in the detail tab
        // bar), viewer_show_info bails and stale lines from the previous
        // tab would otherwise paint under the Info label.
        next = { ...next, lines: [], scroll: 0 };
        effects.push({ type: 'dispatch_msg', msg: wrap('detail', { type: 'viewer_show_info' }) });
      } else if (idx <= actionTabs.length) {
        const [key, act] = actionTabs[idx - 1];
        effects.push({ type: 'stream_action', actionKey: key, script: act.script });
      } else if (idx <= actionTabs.length + termTabs.length) {
        // Terminal tab — content rendered by overlay, clear detail body.
        next = { ...next, lines: [], scroll: 0 };
      } else {
        const ct = activeContentTab();
        if (ct) {
          const [, info] = ct;
          next = { ...next, lines: (info.lines || []).slice(), scroll: 0 };
        }
      }
      return [next, effects];
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
      const next = { ...slice, tab: 0, cursor: { line: 0, col: 0 } };
      if (slice.select) next.select = { ...slice.select, active: false };
      // Group switch closes the tab-list overlay too — the per-group tab
      // set is fundamentally different across groups, so lingering would
      // be confusing.
      if (slice.tabList && slice.tabList.open) {
        next.tabList = { ...slice.tabList, open: false };
        return [next, [{ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'tabListMode' } }]];
      }
      return next;
    }

    // --- viewer-search (typing phase, folded into the viewer Component).
    // leaves/search returns [newSlice, info]; the detailSearchMode flag
    // (root chrome) is set/cleared via apply_msg → mode_set / mode_clear.
    case 'viewer_search_enter': {
      const [next, info] = ms.enter(slice);
      return [next, info.enableSearchMode
        ? [{ type: 'apply_msg', msg: { type: 'mode_set', flag: 'detailSearchMode' } }]
        : []];
    }
    case 'viewer_search_key':    return ms.keystroke(slice, msg.seq);
    case 'viewer_search_nav':    return msg.dir > 0 ? ms.next(slice, _innerH(slice)) : ms.prev(slice, _innerH(slice));
    case 'viewer_search_commit': {
      const [next, info] = ms.commit(slice, _innerH(slice));
      return [next, info.disableSearchMode
        ? [{ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'detailSearchMode' } }]
        : []];
    }
    case 'viewer_search_cancel': {
      const [next, info] = ms.cancel(slice);
      return [next, info.disableSearchMode
        ? [{ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'detailSearchMode' } }]
        : []];
    }

    // --- tab lifecycle. leaves/tabs returns [newSlice, info]; cross-layer
    // modes/focus changes go out as apply_msg / dispatch_msg Cmds.
    case 'viewer_add_ephemeral_terminal': {
      const [next, info] = mt.addEphemeral(slice, getModel(), msg);
      const effects = [];
      // focus_set is layout-owned (Phase 1c). Phase 2a — inner msg wrapped
      // so the dispatch_msg handler routes through layout directly.
      if (info.focusDetail)   effects.push({ type: 'dispatch_msg', msg: require('../api').wrap('layout', { type: 'focus_set', focus: 'detail' }) });
      if (info.terminalEnter) effects.push({ type: 'apply_msg', msg: { type: 'terminal_enter' } });
      return [next, effects];
    }
    case 'viewer_remove_ephemeral_terminal': {
      const [next, { sessionId, terminalExit }] = mt.removeEphemeral(slice, getModel(), msg);
      const effects = [];
      if (sessionId)    effects.push({ type: 'destroy_pty_session', id: sessionId });
      if (terminalExit) effects.push({ type: 'apply_msg', msg: { type: 'terminal_exit' } });
      return [next, effects];
    }
    case 'viewer_add_content_tab': {
      const [next, info] = mt.addContent(slice, getModel(), msg);
      const effects = [];
      // focus_set is layout-owned (Phase 1c). Phase 2a — wrapped (see addEphemeral).
      if (info.focusDetail)  effects.push({ type: 'dispatch_msg', msg: require('../api').wrap('layout', { type: 'focus_set', focus: 'detail' }) });
      if (info.terminalExit) effects.push({ type: 'apply_msg', msg: { type: 'terminal_exit' } });
      return [next, effects];
    }
    case 'viewer_update_content_tab_lines': {
      const [next] = mt.updateContentLines(slice, getModel(), msg);
      return next;
    }
    case 'viewer_remove_content_tab': {
      const [next, { needShowSelectedInfo }] = mt.removeContent(slice, getModel(), msg);
      return [next, needShowSelectedInfo ? [{ type: 'show_selected_info' }] : []];
    }
    case 'viewer_reorder_content_tab':
      return mt.reorderContent(slice, getModel(), msg);

    // --- tab-list overlay (the `[≡]` switcher anchored to detail's
    // top-left). Cursor starts at the active tab; scroll keeps the
    // cursor in view as it walks the list. Both fields live on
    // slice.tabList; the overlay reads them and the trigger glyph
    // queries `model.modes.tabListMode` for its open/closed indicator.
    case 'tab_list_open': {
      // cursor = current active tab. scroll computed so cursor lands
      // in the visible window. vh threaded from the keyhandler since
      // it's view-derived (reads detail.h via overlay/tab-list).
      const vh = Math.max(1, msg.vh | 0);
      const tabCount = msg.tabCount | 0 || 1;
      const cursor = Math.max(0, Math.min(slice.tab | 0, tabCount - 1));
      let scroll = 0;
      if (cursor >= vh) scroll = Math.min(cursor - vh + 1, Math.max(0, tabCount - vh));
      return [
        { ...slice, tabList: { open: true, cursor, scroll } },
        [{ type: 'apply_msg', msg: { type: 'mode_set', flag: 'tabListMode' } }],
      ];
    }
    case 'tab_list_close':
      if (!slice.tabList || !slice.tabList.open) return slice;
      return [
        { ...slice, tabList: { ...slice.tabList, open: false } },
        [{ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'tabListMode' } },
         { type: 'force_full_repaint' }],
      ];
    case 'tab_list_nav': {
      const tl = slice.tabList || { open: false, cursor: 0, scroll: 0 };
      if (!tl.open) return slice;
      const tabCount = msg.tabCount | 0 || 1;
      const vh = Math.max(1, msg.vh | 0);
      let cursor = tl.cursor;
      if (msg.to === 'top')           cursor = 0;
      else if (msg.to === 'bottom')   cursor = tabCount - 1;
      else if (msg.to === 'pageup')   cursor = Math.max(0, tl.cursor - vh);
      else if (msg.to === 'pagedown') cursor = Math.min(tabCount - 1, tl.cursor + vh);
      else                            cursor = tl.cursor + (msg.dir | 0);
      cursor = Math.max(0, Math.min(tabCount - 1, cursor));
      let scroll = tl.scroll | 0;
      const maxScroll = Math.max(0, tabCount - vh);
      if (cursor < scroll)              scroll = cursor;
      else if (cursor >= scroll + vh)   scroll = cursor - vh + 1;
      scroll = Math.max(0, Math.min(scroll, maxScroll));
      if (cursor === tl.cursor && scroll === tl.scroll) return slice;
      return { ...slice, tabList: { ...tl, cursor, scroll } };
    }
    case 'tab_list_pick': {
      const tl = slice.tabList || { open: false, cursor: 0 };
      if (!tl.open) return slice;
      const idx = tl.cursor | 0;
      return [
        { ...slice, tabList: { ...tl, open: false } },
        [
          { type: 'apply_msg', msg: { type: 'mode_clear', flag: 'tabListMode' } },
          { type: 'dispatch_msg', msg: wrap('layout', { type: 'focus_set', focus: 'detail' }) },
          { type: 'dispatch_msg', msg: wrap('detail', { type: 'tab_switch', idx }) },
          { type: 'force_full_repaint' },
        ],
      ];
    }
    case 'tab_list_close_selected': {
      // The caller (overlay key handler) resolves the row's
      // closeable + closeKind + closeKey from the flat tab list and
      // threads them in. Non-closeable rows: silent no-op (msg.kind
      // is null). Cursor clamps to the new tab count on the next
      // open — clamping here would race with the async tab-removal
      // Msg the handler also emits.
      if (!msg.closeKind || !msg.closeKey) return slice;
      const removeMsg = msg.closeKind === 'content'
        ? { type: 'viewer_remove_content_tab', groupName: getModel().currentGroup, key: msg.closeKey }
        : { type: 'viewer_remove_ephemeral_terminal', groupName: getModel().currentGroup, key: msg.closeKey };
      return [slice, [{ type: 'dispatch_msg', msg: wrap('detail', removeMsg) }]];
    }

    // --- visual-mode select. The mouse path dispatches the select_* Msgs
    // (overlay/select.js); the keyboard path lives in `case 'key':` below.
    // Both flow through the same pure slice transforms (`_beginSelect` /
    // `_setCursor` / `_scrollView` / `_moveCursor`) defined above the
    // reducer. The pure ANSI-aware reads (selectedText / plainLineWidth)
    // stay in select.js.
    case 'select_begin':
      return _beginSelect(slice, msg.line, msg.col, msg.kind);
    case 'select_extend': {
      if (!slice.select || !slice.select.active) return slice;
      const n = slice.lines.length;
      const l = n === 0 ? 0 : Math.max(0, Math.min(n - 1, msg.line | 0));
      return { ...slice, select: { ...slice.select, cursor: { line: l, col: Math.max(0, msg.col | 0) } } };
    }
    case 'select_cancel':
      if (!slice.select) return slice;
      return { ...slice, select: { ...slice.select, active: false } };
    case 'select_set_cursor':
      return _setCursor(slice, msg.line, msg.col, msg.extend);
    case 'select_scroll_view':
      return _scrollView(slice, msg.delta);

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
        if (msg.seq === 'n' || msg.key === 'n') return [ms.next(slice, _innerH(slice)), claim];
        if (msg.seq === 'N' || msg.key === 'N') return [ms.prev(slice, _innerH(slice)), claim];
        if (msg.key === 'escape' && !active)    return [ms.clearCommitted(slice), claim];
      }

      // v / V — toggle visual mode. Anchor at the top of the current viewport
      // (matches what mouse-drag effectively does — cursor where it lands).
      if (msg.seq === 'v' || msg.key === 'v') {
        const next = (active && slice.select.kind === 'char')
          ? { ...slice, select: { ...slice.select, active: false } }
          : _beginSelect(slice, slice.scroll || 0, 0, 'char');
        return [next, claim];
      }
      if (msg.seq === 'V' || msg.key === 'V') {
        const next = (active && slice.select.kind === 'line')
          ? { ...slice, select: { ...slice.select, active: false } }
          : _beginSelect(slice, slice.scroll || 0, 0, 'line');
        return [next, claim];
      }

      // y — commit + push to register. The text resolution + OSC52 ride out
      // as apply_msg → register_push (root reducer owns the register).
      if ((msg.seq === 'y' || msg.key === 'y') && active) {
        const text = require('../../overlay/select').selectedText();
        const next = { ...slice, select: { ...slice.select, active: false } };
        const effects = [{ type: '_claimed' }];
        if (text) effects.push({ type: 'apply_msg', msg: { type: 'register_push', text } });
        return [next, effects];
      }
      if (msg.key === 'escape' && active) {
        return [{ ...slice, select: { ...slice.select, active: false } }, claim];
      }

      // Vertical movement: reading → scroll view, visual → cursor + extend.
      if (msg.key === 'down' || msg.seq === 'j' || msg.key === 'j') {
        const next = active ? _moveCursor(slice, +1, 0) : _scrollView(slice, +1);
        return [next, claim];
      }
      if (msg.key === 'up' || msg.seq === 'k' || msg.key === 'k') {
        const next = active ? _moveCursor(slice, -1, 0) : _scrollView(slice, -1);
        return [next, claim];
      }

      // Horizontal h/l — only claim in visual mode so reading-mode focus-shift
      // still works (`l` to step out of detail into the next panel).
      if (active) {
        if (msg.key === 'left'  || msg.seq === 'h' || msg.key === 'h') return [_moveCursor(slice, 0, -1), claim];
        if (msg.key === 'right' || msg.seq === 'l' || msg.key === 'l') return [_moveCursor(slice, 0, +1), claim];
      }

      // 0 / $ — line-start / line-end jumps. Only meaningful with a cursor.
      if (active && (msg.seq === '0' || msg.key === 'home')) {
        return [_setCursor(slice, slice.cursor.line, 0, true), claim];
      }
      if (active && (msg.seq === '$' || msg.key === 'end')) {
        const w = require('../../overlay/select').plainLineWidth(slice.cursor.line);
        return [_setCursor(slice, slice.cursor.line, Math.max(0, w - 1), true), claim];
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
  // Blessed exception (docs/v0.5-layering.md §5): the mouse hit-test
  // cache for the tab bar is a view-output write — populated during
  // the layout Component's render pass + consumed by input.js. Pure-TEA
  // doesn't apply to render-time writes into the owning Component's
  // own slice; the alternative would be a parallel structure
  // round-tripping per-frame.
  if (layoutSlice && layoutSlice.panelBounds.detail) layoutSlice.panelBounds.detail.tabs = tabBounds;
  if (!actionTabs.length && !termTabs.length && !contentTabs.length) return 'Detail';
  const parts = [];
  // Per-tab metadata so the bounds loop below can place the close-zone hit
  // rect on closeable tabs (content tabs only at this point — ephemeral
  // terminals still close via `x` since that flow respects PTY liveness).
  const partMeta = [];
  const tab = slice.tab;
  // Phase 5 — per-tab decorator slot retired; the decorate framework had
  // no in-tree contributor and gave plugins no realistic seam (tab labels
  // are panel-managed). Tabs render plain.
  const pushTab = (label, isActive, closeKey) => {
    const text = esc(label);
    const close = closeKey ? ' \\[x]' : '';
    parts.push(isActive ? `\\[${text}${close}]` : `${text}${close}`);
    partMeta.push({ closeKey, activeWrap: isActive ? 1 : 0 });
  };
  pushTab('Info', tab === 0, null);
  actionTabs.forEach(([, action], i) => pushTab(action.label, tab === i + 1, null));
  const termOffset = 1 + actionTabs.length;
  termTabs.forEach(([, term], i) => pushTab(term.label, tab === termOffset + i, null));
  const contentOffset = 1 + actionTabs.length + termTabs.length;
  contentTabs.forEach(([key, info], i) => pushTab(info.label, tab === contentOffset + i, key));
  const dp = getComponentSlice('layout').arrange.rightPanels.find(p => p.type === 'detail');
  const hotkey = dp ? dp.hotkey : '';
  let xOffset = 2 + (hotkey ? 2 + hotkey.length : 0) + 1;
  parts.forEach((part, i) => {
    if (i > 0) xOffset += 1;
    const visLen = visibleLen(part);
    const meta = partMeta[i];
    const bound = { tabIdx: i, x: xOffset, w: visLen };
    if (meta.closeKey) {
      // Close glyph "[x]" sits at the end of the tab's visible text. For
      // an active tab the trailing `]` of the wrapper sits one cell after
      // the glyph (activeWrap=1), so the close zone is offset accordingly.
      bound.closeKey = meta.closeKey;
      bound.closeX = xOffset + visLen - meta.activeWrap - 3;
      bound.closeW = 3;
    }
    tabBounds.push(bound);
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
