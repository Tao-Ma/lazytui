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
  if (Array.isArray(r)) return { next: r[0], cmds: r[1] };
  return { next: r, cmds: [] };
}

describe('[tab_list_open] cursor lands on the active tab', () => {
  it('active in first viewport — scroll = 0', () => {
    const slice = { ...viewer.init(), tab: 2 };
    const { next } = applyUpdate(slice, { type: 'tab_list_open', vh: 5, tabCount: 10 });
    eq(next.tabList.open, true);
    eq(next.tabList.cursor, 2);
    eq(next.tabList.scroll, 0);
  });
  it('active outside first viewport — scroll advances to keep cursor in view', () => {
    const slice = { ...viewer.init(), tab: 7 };
    const { next } = applyUpdate(slice, { type: 'tab_list_open', vh: 5, tabCount: 10 });
    eq(next.tabList.cursor, 7);
    eq(next.tabList.scroll, 3, 'cursor=7, vh=5 → scroll=3 (7-5+1)');
  });
  it('open emits mode_set Cmd', () => {
    const slice = { ...viewer.init(), tab: 0 };
    const { cmds } = applyUpdate(slice, { type: 'tab_list_open', vh: 5, tabCount: 3 });
    eq(cmds.length, 1);
    eq(cmds[0].type, 'apply_msg');
    eq(cmds[0].msg.flag, 'tabListMode');
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
  it('emits tab_switch + focus_set + mode_clear + repaint', () => {
    let s = { ...viewer.init(), tab: 0 };
    s = applyUpdate(s, { type: 'tab_list_open', vh: 5, tabCount: 10 }).next;
    s = applyUpdate(s, { type: 'tab_list_nav', dir: 1, vh: 5, tabCount: 10 }).next;
    s = applyUpdate(s, { type: 'tab_list_nav', dir: 1, vh: 5, tabCount: 10 }).next;
    eq(s.tabList.cursor, 2);
    const { next, cmds } = applyUpdate(s, { type: 'tab_list_pick' });
    eq(next.tabList.open, false);
    eq(cmds.length, 4);
    const types = cmds.map(c => c.type);
    assert(types.includes('apply_msg'));
    assert(types.includes('dispatch_msg'));
    assert(types.includes('force_full_repaint'));
    // Verify the tab_switch carries the cursor idx
    const switchCmd = cmds.find(c => c.type === 'dispatch_msg' && c.msg.msg && c.msg.msg.type === 'tab_switch');
    assert(switchCmd, 'tab_switch Msg present');
    eq(switchCmd.msg.msg.idx, 2);
  });
});

describe('[tab_list_close] cleans up', () => {
  it('open=false + mode_clear + repaint', () => {
    let s = { ...viewer.init(), tab: 0 };
    s = applyUpdate(s, { type: 'tab_list_open', vh: 5, tabCount: 3 }).next;
    const { next, cmds } = applyUpdate(s, { type: 'tab_list_close' });
    eq(next.tabList.open, false);
    eq(cmds.length, 2);
    eq(cmds[0].type, 'apply_msg');
    eq(cmds[0].msg.flag, 'tabListMode');
    eq(cmds[1].type, 'force_full_repaint');
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
    eq(cmds[0].type, 'dispatch_msg');
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
  it('open overlay → reset_chrome closes + emits mode_clear', () => {
    let s = { ...viewer.init(), tab: 0 };
    s = applyUpdate(s, { type: 'tab_list_open', vh: 5, tabCount: 3 }).next;
    eq(s.tabList.open, true);
    const { next, cmds } = applyUpdate(s, { type: 'viewer_reset_chrome' });
    eq(next.tabList.open, false);
    eq(cmds.length, 1);
    eq(cmds[0].msg.flag, 'tabListMode');
  });
  it('closed overlay → reset_chrome returns plain slice', () => {
    const s = viewer.init();
    const r = applyUpdate(s, { type: 'viewer_reset_chrome' });
    // No cmds since overlay was already closed
    eq(r.cmds.length, 0);
  });
});

report();
