/**
 * Tab list overlay — slice transitions on the detail Component.
 *
 *   open  → cursor lands on the active tab; scroll computed to keep
 *           it in view (vh < tabCount)
 *   nav   → cursor moves, scroll auto-advances at viewport edges
 *   page  → cursor jumps by vh
 *   pick  → close + emit tab_switch + focus_set detail
 *   close → close + emit mode_clear
 *
 * Pure reducer tests — no render, no input.
 *
 *   node js/test/test-tab-list.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const viewer = require('../panel/viewer/viewer');

function applyUpdate(slice, msg) {
  const r = viewer.update(msg, slice);
  const result = Array.isArray(r) ? { next: r[0], cmds: r[1] } : { next: r, cmds: [] };
  // AR2: tab-list open-state lives on model.modes.tabListMode, not the
  // viewer slice. Mirror mode_set/mode_clear Cmds onto the model so
  // subsequent tab_list_* Msgs in the same test see the right flag.
  for (const c of result.cmds) {
    if (c && c.type === 'msg' && c.msg && typeof c.msg.flag === 'string') {
      const { getModel } = require('../app/runtime');
      if (c.msg.type === 'mode_set')   getModel().modes[c.msg.flag] = true;
      if (c.msg.type === 'mode_clear') getModel().modes[c.msg.flag] = false;
    }
  }
  return result;
}

describe('[tab_list_open] cursor lands on the active tab', () => {
  it('active in first viewport — scroll = 0', () => {
    const slice = { ...viewer.init(), tab: 2 };
    const { next } = applyUpdate(slice, { type: 'tab_list_open', vh: 5, tabCount: 10 });
    eq(next.tabList.cursor, 2);
    eq(next.tabList.scroll, 0);
  });
  it('active outside first viewport — scroll advances to keep cursor in view', () => {
    const slice = { ...viewer.init(), tab: 7 };
    const { next } = applyUpdate(slice, { type: 'tab_list_open', vh: 5, tabCount: 10 });
    eq(next.tabList.cursor, 7);
    eq(next.tabList.scroll, 3, 'cursor=7, vh=5 → scroll=3 (7-5+1)');
  });
  it('open emits mode_set Cmd + tab_list_set_owner', () => {
    const slice = { ...viewer.init(), tab: 0 };
    const { cmds } = applyUpdate(slice, { type: 'tab_list_open', vh: 5, tabCount: 3 });
    // v0.6.1 Phase 4 — open also dispatches tab_list_set_owner to layout.
    eq(cmds.length, 2);
    eq(cmds[0].type, 'msg');
    eq(cmds[0].msg.flag, 'tabListMode');
    eq(cmds[1].type, 'msg');
    eq(cmds[1].msg.kind, 'layout');
    eq(cmds[1].msg.msg.type, 'tab_list_set_owner');
  });
});

describe('[tab_list_nav] cursor + auto-scroll', () => {
  function open(vh, tabCount, atTab = 0) {
    const slice = { ...viewer.init(), tab: atTab };
    return applyUpdate(slice, { type: 'tab_list_open', vh, tabCount }).next;
  }
  it('dir:+1 advances cursor', () => {
    let s = open(5, 10);
    s = applyUpdate(s, { type: 'tab_list_nav', dir: 1, vh: 5, tabCount: 10 }).next;
    eq(s.tabList.cursor, 1);
  });
  it('cursor walking off bottom advances scroll', () => {
    let s = open(5, 10);
    for (let i = 0; i < 7; i++) s = applyUpdate(s, { type: 'tab_list_nav', dir: 1, vh: 5, tabCount: 10 }).next;
    eq(s.tabList.cursor, 7);
    eq(s.tabList.scroll, 3);
  });
  it('cursor walking off top retreats scroll', () => {
    let s = open(5, 10, 9);
    eq(s.tabList.cursor, 9);
    for (let i = 0; i < 6; i++) s = applyUpdate(s, { type: 'tab_list_nav', dir: -1, vh: 5, tabCount: 10 }).next;
    eq(s.tabList.cursor, 3);
    eq(s.tabList.scroll, 3, 'scroll preserved while cursor stays in view');
  });
  it('to:pageup / pagedown jump by vh', () => {
    let s = open(5, 20, 10);
    s = applyUpdate(s, { type: 'tab_list_nav', to: 'pagedown', vh: 5, tabCount: 20 }).next;
    eq(s.tabList.cursor, 15);
    s = applyUpdate(s, { type: 'tab_list_nav', to: 'pageup', vh: 5, tabCount: 20 }).next;
    eq(s.tabList.cursor, 10);
  });
  it('to:top / bottom jump to ends', () => {
    let s = open(5, 10, 5);
    s = applyUpdate(s, { type: 'tab_list_nav', to: 'bottom', vh: 5, tabCount: 10 }).next;
    eq(s.tabList.cursor, 9);
    s = applyUpdate(s, { type: 'tab_list_nav', to: 'top',    vh: 5, tabCount: 10 }).next;
    eq(s.tabList.cursor, 0);
    eq(s.tabList.scroll, 0);
  });
  it('cursor clamps within [0, tabCount-1]', () => {
    let s = open(5, 3);
    for (let i = 0; i < 10; i++) s = applyUpdate(s, { type: 'tab_list_nav', dir: 1, vh: 5, tabCount: 3 }).next;
    eq(s.tabList.cursor, 2, 'clamps to tabCount-1');
  });
});

describe('[tab_list_pick] switches + closes', () => {
  it('emits tab_switch + focus_set + mode_clear + repaint + owner clear', () => {
    let s = { ...viewer.init(), tab: 0 };
    s = applyUpdate(s, { type: 'tab_list_open', vh: 5, tabCount: 10 }).next;
    s = applyUpdate(s, { type: 'tab_list_nav', dir: 1, vh: 5, tabCount: 10 }).next;
    s = applyUpdate(s, { type: 'tab_list_nav', dir: 1, vh: 5, tabCount: 10 }).next;
    eq(s.tabList.cursor, 2);
    const { cmds } = applyUpdate(s, { type: 'tab_list_pick' });
    // v0.6.1 Phase 4 — pick also clears tab_list_set_owner on layout.
    eq(cmds.length, 5);
    const types = cmds.map(c => c.type);
    assert(types.includes('msg'));
    assert(types.includes('msg'));
    assert(types.includes('force_full_repaint'));
    // Verify the tab_switch carries the cursor idx
    const switchCmd = cmds.find(c => c.type === 'msg' && c.msg.msg && c.msg.msg.type === 'tab_switch');
    assert(switchCmd, 'tab_switch Msg present');
    eq(switchCmd.msg.msg.idx, 2);
    const ownerCmd = cmds.find(c => c.type === 'msg'
      && c.msg.msg && c.msg.msg.type === 'tab_list_set_owner');
    assert(ownerCmd, 'tab_list_set_owner clear present');
    eq(ownerCmd.msg.msg.paneId, null);
  });
});

describe('[tab_list_close] cleans up', () => {
  it('open=false + mode_clear + owner clear + repaint', () => {
    let s = { ...viewer.init(), tab: 0 };
    s = applyUpdate(s, { type: 'tab_list_open', vh: 5, tabCount: 3 }).next;
    const { cmds } = applyUpdate(s, { type: 'tab_list_close' });
    // v0.6.1 Phase 4 — close also dispatches tab_list_set_owner (null) to layout.
    eq(cmds.length, 3);
    eq(cmds[0].type, 'msg');
    eq(cmds[0].msg.flag, 'tabListMode');
    eq(cmds[1].type, 'msg');
    eq(cmds[1].msg.msg.type, 'tab_list_set_owner');
    eq(cmds[1].msg.msg.paneId, null);
    eq(cmds[2].type, 'force_full_repaint');
  });
  it('close on already-closed is a no-op (identity-preserving)', () => {
    const s = viewer.init();
    const r = applyUpdate(s, { type: 'tab_list_close' });
    eq(r.next, s, 'identity preserved');
  });
});

describe('[tab_list_close_selected] emits a remove Msg for the row', () => {
  it('content tab → viewer_remove_content_tab', () => {
    // groupName comes from model.currentGroup; we don't assert on it here
    let s = { ...viewer.init(), tab: 0 };
    s = applyUpdate(s, { type: 'tab_list_open', vh: 5, tabCount: 3 }).next;
    const { cmds } = applyUpdate(s, {
      type: 'tab_list_close_selected',
      closeKind: 'content', closeKey: 'file:/tmp/foo.txt',
    });
    eq(cmds.length, 1);
    eq(cmds[0].type, 'msg');
    eq(cmds[0].msg.msg.type, 'viewer_remove_content_tab');
    eq(cmds[0].msg.msg.key, 'file:/tmp/foo.txt');
  });
  it('terminal tab → viewer_remove_ephemeral_terminal', () => {
    let s = { ...viewer.init(), tab: 0 };
    s = applyUpdate(s, { type: 'tab_list_open', vh: 5, tabCount: 3 }).next;
    const { cmds } = applyUpdate(s, {
      type: 'tab_list_close_selected',
      closeKind: 'terminal', closeKey: 'shell',
    });
    eq(cmds[0].msg.msg.type, 'viewer_remove_ephemeral_terminal');
    eq(cmds[0].msg.msg.key, 'shell');
  });
  it('missing closeKind/key is a no-op', () => {
    let s = { ...viewer.init(), tab: 0 };
    s = applyUpdate(s, { type: 'tab_list_open', vh: 5, tabCount: 3 }).next;
    const r = applyUpdate(s, { type: 'tab_list_close_selected' });
    eq(r.next, s, 'identity preserved');
    eq(r.cmds.length, 0);
  });
});

describe('[viewer_reset_chrome] auto-closes the overlay on group switch', () => {
  it('open overlay → reset_chrome closes + emits mode_clear + owner clear', () => {
    let s = { ...viewer.init(), tab: 0 };
    s = applyUpdate(s, { type: 'tab_list_open', vh: 5, tabCount: 3 }).next;
    const { cmds } = applyUpdate(s, { type: 'viewer_reset_chrome' });
    // v0.6.1 Phase 4 — reset_chrome's close path also clears owner.
    eq(cmds.length, 2);
    eq(cmds[0].msg.flag, 'tabListMode');
    eq(cmds[1].type, 'msg');
    eq(cmds[1].msg.msg.type, 'tab_list_set_owner');
  });
  it('closed overlay → reset_chrome returns plain slice', () => {
    const s = viewer.init();
    const r = applyUpdate(s, { type: 'viewer_reset_chrome' });
    // No cmds since overlay was already closed
    eq(r.cmds.length, 0);
  });
});

// ===============================================================
// Render-side regression: the [≡] trigger glyph is inserted AFTER (o),
// not in place of it, so the user sees both the hotkey and the trigger.
// v0.6.3 P4.2c — was `[injectTabTrigger]`. The regex injection
// function retired; chrome glyphs compose inline via renderPanel
// ({chrome}). The [≡] tab trigger is requested via
// chrome.tabTrigger; renderPanel positions it after the hotkey
// and the total visible width matches the requested width.
describe('[chrome:tabTrigger] (o)[≡] layout preserves panel width', () => {
  const { renderPanel } = require('../render/panel');
  const { richToAnsi, visibleLen } = require('../io/ansi');

  function strip(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

  it('top row contains both (o) and [≡] with width preserved', () => {
    const out = renderPanel({
      width: 40, height: 10, lines: [], title: 'Detail', hotkey: 'o', focused: true,
      chrome: { collapse: null, close: null, tabTrigger: 'available' },
    });
    const top = out.split('\n')[0];
    const vis = strip(richToAnsi(top));
    eq(visibleLen(top), 40, 'top-border width = 40 with chrome inline');
    assert(vis.includes('(o)'),  `(o) preserved: ${vis}`);
    assert(vis.includes('[≡]'), `[≡] inserted: ${vis}`);
    assert(vis.indexOf('(o)[≡]') >= 0, `(o)[≡] adjacent: ${vis}`);
  });

  it('narrow detail (no room for both) drops chrome — bare border', () => {
    // P4.2c behavior change vs the pre-P4 inject path: when chrome
    // doesn't fit, renderPanel falls back to a bare border (no
    // glyphs) instead of "replace (o) with [≡]" — the older fallback
    // sacrificed the hotkey label to keep the trigger. The new path
    // prefers consistency: narrow panes show no chrome at all.
    const out = renderPanel({
      width: 10, height: 10, lines: [], title: 'T', hotkey: 'o', focused: true,
      chrome: { collapse: null, close: null, tabTrigger: 'available' },
    });
    const top = out.split('\n')[0];
    const vis = strip(richToAnsi(top));
    eq(visibleLen(top), 10, 'width preserved in fallback');
    assert(vis.includes('(o)'), 'hotkey shown in bare-border fallback');
    assert(!vis.includes('[≡]'), 'trigger dropped on narrow pane');
  });
});

// T2.5 — exhaustive coverage of the trigger state machine. Round-1 only
// pinned the 'normal' state; the open/disabled branches were drift-prone.
// v0.6.3 P4.2c — render path moved from injectTabTrigger to
// renderPanel({chrome.tabTrigger}); the state machine itself is
// unchanged and still tested here.
describe('[trigger state machine] all states render + click as documented', () => {
  const { isTriggerHit, _triggerState } = require('../overlay/tab-list');
  const { renderPanel } = require('../render/panel');
  const { richToAnsi } = require('../io/ansi');
  const api = require('../panel/api');
  const layout = require('../panel/layout');
  const { getModel } = require('../app/runtime');

  function strip(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

  try { api.registerComponent(layout); } catch (e) { /* already registered */ }
  const layoutSlice = api.getInstanceSlice('layout');
  layoutSlice.panelBounds = { detail: { x: 0, y: 0, w: 40, h: 10 } };
  layoutSlice.focus = 'detail';
  const md = getModel().modes;

  function withModes(setFlags, fn) {
    const saved = {};
    for (const k of Object.keys(setFlags)) { saved[k] = md[k]; md[k] = setFlags[k]; }
    try { return fn(); } finally { for (const k of Object.keys(saved)) md[k] = saved[k]; }
  }

  // P4.2c — map raw trigger state to renderPanel's chrome.tabTrigger:
  // 'normal' → 'available' (default colored glyph), the rest passthrough.
  function chromeStateFromMode() {
    const raw = _triggerState();
    return raw === 'normal' ? 'available' : raw;
  }

  function renderAt() {
    const out = renderPanel({
      width: 40, height: 10, lines: [], title: 'Detail', hotkey: 'o', focused: true,
      chrome: { collapse: null, close: null, tabTrigger: chromeStateFromMode() },
    });
    const top = out.split('\n')[0];
    return strip(richToAnsi(top));
  }

  function ansiAt() {
    const out = renderPanel({
      width: 40, height: 10, lines: [], title: 'Detail', hotkey: 'o', focused: true,
      chrome: { collapse: null, close: null, tabTrigger: chromeStateFromMode() },
    });
    return richToAnsi(out.split('\n')[0]);
  }

  // Hit-test against `(o)`'s `[≡]` glyph: it lands a few cells past the
  // left border (`╭─(o)`) so `mx ≈ TRIGGER_X_OFFSET` is the [≡] cell.
  const TRIGGER_HIT_MX = 6;  // safely inside [≡]'s 3-cell band given TRIGGER_X_OFFSET=5

  it('state=normal — colored glyph, clickable', () => {
    withModes({ tabListMode: false, freeConfigMode: false, cmdMode: false }, () => {
      const vis = renderAt();
      assert(vis.includes('[≡]'), `vis row should carry [≡]: ${vis}`);
      assert(isTriggerHit(TRIGGER_HIT_MX, 0, 'detail'), 'clickable in normal state');
    });
  });

  it('state=open (tabListMode on) — reverse video, still clickable (toggles closed)', () => {
    withModes({ tabListMode: true, freeConfigMode: false, cmdMode: false }, () => {
      const ansi = ansiAt();
      // [reverse] markup maps to ANSI 7 (\x1b[7m); strip-style check.
      assert(/\x1b\[(?:[\d;]*;)?7(?:;|m)/.test(ansi),
        `open state must include reverse-video escape: ${JSON.stringify(ansi.slice(0, 80))}`);
      assert(isTriggerHit(TRIGGER_HIT_MX, 0, 'detail'), 'clickable in open state (click closes)');
    });
  });

  it('state=disabled (some other chain mode active) — dim, NOT clickable', () => {
    withModes({ tabListMode: false, freeConfigMode: true, cmdMode: false }, () => {
      const ansi = ansiAt();
      // [dim] maps to SGR 2.
      assert(/\x1b\[(?:[\d;]*;)?2(?:;|m)/.test(ansi),
        `disabled state must include dim escape: ${JSON.stringify(ansi.slice(0, 80))}`);
      assert(!isTriggerHit(TRIGGER_HIT_MX, 0, 'detail'),
        'NOT clickable when another chain mode owns input');
    });
    withModes({ tabListMode: false, freeConfigMode: false, cmdMode: true }, () => {
      assert(!isTriggerHit(TRIGGER_HIT_MX, 0, 'detail'),
        'NOT clickable while cmdline owns input');
    });
  });

  it('isTriggerHit gates on clickability + bounds', () => {
    withModes({ tabListMode: false, freeConfigMode: false, cmdMode: false }, () => {
      // y outside top row → miss.
      assert(!isTriggerHit(TRIGGER_HIT_MX, 1, 'detail'), 'wrong row misses');
      // mx left of trigger → miss.
      assert(!isTriggerHit(1, 0, 'detail'), 'mx left of trigger misses');
      // mx far right → miss.
      assert(!isTriggerHit(35, 0, 'detail'), 'mx right of trigger misses');
    });
  });
});

report();
