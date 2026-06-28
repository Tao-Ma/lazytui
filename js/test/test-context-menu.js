/**
 * v0.6.4 Theme F follow-on — right-click context menu.
 *
 * Pins the four seams the feature added, in isolation:
 *   1. leaves/context-menu.buildContextItems — registry → rows, with the
 *      show() awareness hook + build()→null applicability drop.
 *   2. runtime menu_activate honoring an absolute msg.idx + threading the
 *      row's arg (item[2]) into the menu_action Cmd.
 *   3. actions.handleAction('copy_text', text) → register_push (clipboard).
 *   4. overlay/menu.hitTest mapping a cursor cell back to a row, sharing the
 *      paint-side overlayBox geometry so a click can't miss a painted row.
 *
 * End-to-end (raw gesture → menu → copy → dismiss) is covered by the smoke.
 *
 *   node js/test/test-context-menu.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const cm = require('../leaves/input/context-menu');
const runtime = require('../app/runtime');

describe('[ctx-menu] buildContextItems — registry → rows', () => {
  // Row helpers tolerate the `null` separators between sections.
  const labelsOf = (items) => items.map(r => r && r[0]);

  it('a viewer line context yields "Copy line" first', () => {
    const items = cm.buildContextItems({ paneKind: 'detail', lineText: 'hello world', itemLabel: null, selectionText: null });
    eq(items[0][0], 'Copy line', 'first row is Copy line');
    eq(items[0][1], 'copy_text', 'verb');
    eq(items[0][2], 'hello world', 'arg = the line text');
    assert(items.includes(null), 'separator before the general section');
    assert(labelsOf(items).includes('Refresh'), 'general section follows');
  });

  it('a list-row context yields "Copy item" first', () => {
    const items = cm.buildContextItems({ paneKind: 'groups', lineText: null, itemLabel: 'Group 1', selectionText: null });
    eq(items[0][0], 'Copy item', 'first row is Copy item');
    eq(items[0][2], 'Group 1', 'arg = the row label');
  });

  it('an active selection adds "Copy selection"', () => {
    const items = cm.buildContextItems({ paneKind: 'detail', lineText: 'L', itemLabel: null, selectionText: 'picked text' });
    const labels = labelsOf(items);
    assert(labels.includes('Copy line'), 'still offers Copy line');
    assert(labels.includes('Copy selection'), 'and Copy selection');
    eq(items.find(r => r && r[0] === 'Copy selection')[2], 'picked text', 'selection arg');
  });

  it('empty target (no copyable thing) → only the general section, no separator', () => {
    const items = cm.buildContextItems({ paneKind: 'detail', lineText: null, itemLabel: null, selectionText: null });
    assert(!items.some(r => r && r[1] === 'copy_text'), 'no copy rows without a target');
    assert(labelsOf(items).includes('Refresh'), 'general section keeps the menu non-empty');
    assert(items[0] !== null, 'no leading separator when the target section is empty');
    // An empty-string label is dropped (applicability), still just general.
    const empty = cm.buildContextItems({ paneKind: 'x', lineText: null, itemLabel: '', selectionText: null });
    assert(!empty.some(r => r && r[1] === 'copy_text'), 'empty label dropped');
  });

  it('a show() gate hides its entry; default-true entries stay', () => {
    // The hook is data — flip one entry off and prove the filter respects it
    // without disturbing the rest. Restore after so the suite stays clean.
    const target = cm.ENTRIES.find(e => e.id === 'copy-target');
    const realShow = target.show;
    target.show = () => false;
    try {
      const items = cm.buildContextItems({ lineText: 'L', selectionText: 'S' });
      assert(!items.some(r => r && r[0] === 'Copy line'), 'gated entry hidden');
      assert(items.some(r => r && r[0] === 'Copy selection'), 'ungated entry still shows');
    } finally {
      target.show = realShow;
    }
  });
});

describe('[ctx-menu] menu_activate — absolute idx + arg threading', () => {
  // Minimal model: the arm reads model.modes.menuOpen + model.modal.menu and
  // patches the menu_action base staged on model.modal.continuation (E14 — set
  // by menu_open in the real path).
  function openWith(items) {
    return {
      modes: { menuOpen: true },
      modal: { menu: { items, idx: 0, anchor: null, title: 'Actions' }, continuation: { type: 'menu_action' } },
    };
  }

  it('msg.idx activates the clicked row (not the cursor) + threads its arg', () => {
    const m = openWith([['Copy line', 'copy_text', 'L0'], ['Copy item', 'copy_text', 'L1']]);
    const [next, cmds] = runtime.update(m, { type: 'menu_activate', idx: 1 });
    eq(next.modes.menuOpen, false, 'menu closed');
    eq(cmds.length, 1, 'one Cmd');
    eq(cmds[0].type, 'menu_action', 'menu_action');
    eq(cmds[0].action, 'copy_text', 'row 1 verb');
    eq(cmds[0].arg, 'L1', 'row 1 arg threaded');
  });

  it('no msg.idx falls back to the highlighted cursor (idx 0)', () => {
    const m = openWith([['A', 'copy_text', 'argA']]);
    const [, cmds] = runtime.update(m, { type: 'menu_activate' });
    eq(cmds[0].arg, 'argA', 'cursor row 0 arg');
  });

  it('menu_open stores the title; default null → "Menu" at render', () => {
    const opened = runtime.update({ modes: {}, modal: {} },
      { type: 'menu_open', items: [['x', 'y']], anchor: { x: 3, y: 4 }, title: 'Actions' })[0];
    eq(opened.modal.menu.title, 'Actions', 'title threaded');
    eq(opened.modal.menu.anchor, { x: 3, y: 4 }, 'anchor threaded');
  });
});

describe('[ctx-menu] copy_text verb → register_push', () => {
  it('handleAction("copy_text", text) pushes the text onto the register', () => {
    const dispatch = require('../dispatch/control/dispatch');
    const actions = require('../dispatch/control/actions');
    const seen = [];
    const real = dispatch.applyMsg;
    dispatch.applyMsg = (m) => { seen.push(m); };   // actions reads dispatch.applyMsg at call time
    try {
      actions.handleAction('copy_text', 'yank me');
    } finally {
      dispatch.applyMsg = real;
    }
    const push = seen.find(m => m.type === 'register_push');
    assert(push, 'a register_push was dispatched');
    eq(push.text, 'yank me', 'with the copied text');
  });

  it('copy_text with no arg is inert', () => {
    const dispatch = require('../dispatch/control/dispatch');
    const actions = require('../dispatch/control/actions');
    const seen = [];
    const real = dispatch.applyMsg;
    dispatch.applyMsg = (m) => { seen.push(m); };
    try { actions.handleAction('copy_text', undefined); } finally { dispatch.applyMsg = real; }
    assert(!seen.some(m => m.type === 'register_push'), 'no push without text');
  });
});

describe('[ctx-menu] configure — YAML `context-menu:` entries', () => {
  const labelsOf = (items) => items.map(r => r && r[0]);
  const rowFor = (items, label) => items.find(r => r && r[0] === label);

  it('config entries append as a trailing section after the built-ins', () => {
    cm.configure([{ label: 'Reload', builtin: 'refresh' }]);
    try {
      const items = cm.buildContextItems({ paneKind: 'detail', lineText: 'L' });
      const labels = labelsOf(items);
      assert(labels.includes('Copy line'), 'built-in target section still first');
      assert(labels.includes('Refresh'), 'built-in general section present');
      assert(labels.includes('Reload'), 'config entry appended');
      // The config entry sits AFTER the built-in general 'Help' row.
      assert(labels.indexOf('Reload') > labels.indexOf('Help'), 'config section trails the built-ins');
      // A separator divides the built-in general section from the config one.
      const sepCount = items.filter(r => r === null).length;
      eq(sepCount, 2, 'target | general | config → two separators');
    } finally { cm.reset(); }
  });

  it('the three verb forms map to pure-data rows (builtin / action / command)', () => {
    cm.configure([
      { label: 'B', builtin: 'show_help' },
      { label: 'A', action: 'deploy' },
      { label: 'C', command: 'logs web' },
    ]);
    try {
      const items = cm.buildContextItems({});   // empty space → only config + general
      eq(rowFor(items, 'B')[1], 'show_help', 'builtin verb passes through verbatim');
      eq(rowFor(items, 'B').length, 2, 'builtin row carries no arg');
      eq(rowFor(items, 'A')[1], 'ctx_run_action', 'action → ctx_run_action verb');
      eq(rowFor(items, 'A')[2], 'deploy', 'action key threaded as arg');
      eq(rowFor(items, 'C')[1], 'ctx_run_command', 'command → ctx_run_command verb');
      eq(rowFor(items, 'C')[2], 'logs web', 'command string threaded as arg');
    } finally { cm.reset(); }
  });

  it('`pane:` gates an entry to the matching pane kind(s)', () => {
    cm.configure([
      { label: 'OnDocker', builtin: 'refresh', pane: 'docker' },
      { label: 'OnEither', builtin: 'refresh', pane: ['groups', 'detail'] },
      { label: 'Always',   builtin: 'refresh' },
    ]);
    try {
      const onDetail = labelsOf(cm.buildContextItems({ paneKind: 'detail' }));
      assert(!onDetail.includes('OnDocker'), 'docker-gated hidden on a detail pane');
      assert(onDetail.includes('OnEither'), 'list-gated shows on detail (in its list)');
      assert(onDetail.includes('Always'), 'ungated always shows');
      const onEmpty = labelsOf(cm.buildContextItems({}));   // no paneKind
      assert(!onEmpty.includes('OnDocker') && !onEmpty.includes('OnEither'), 'pane-gated hidden on empty space');
      assert(onEmpty.includes('Always'), 'ungated shows on empty space');
    } finally { cm.reset(); }
  });

  it('configure is idempotent — a second call replaces the first set', () => {
    cm.configure([{ label: 'First', builtin: 'refresh' }]);
    cm.configure([{ label: 'Second', builtin: 'refresh' }]);
    try {
      const labels = labelsOf(cm.buildContextItems({}));
      assert(labels.includes('Second'), 'second set present');
      assert(!labels.includes('First'), 'first set replaced, not accumulated');
    } finally { cm.reset(); }
  });

  it('reset / configure(null) clears config entries (only built-ins remain)', () => {
    cm.configure([{ label: 'Gone', builtin: 'refresh' }]);
    cm.configure(null);
    const labels = labelsOf(cm.buildContextItems({}));
    assert(!labels.includes('Gone'), 'configure(null) clears');
    assert(labels.includes('Refresh'), 'built-in general section survives');
  });
});

describe('[ctx-menu] ctx_run_action / ctx_run_command verbs', () => {
  const actions = require('../dispatch/control/actions');

  it('ctx_run_command routes the string through runCommandString', () => {
    const cmdline = require('../dispatch/control/cmdline');
    const seen = [];
    const real = cmdline.runCommandString;
    cmdline.runCommandString = (s) => { seen.push(s); };
    try { actions.handleAction('ctx_run_command', 'logs web'); }
    finally { cmdline.runCommandString = real; }
    eq(seen[0], 'logs web', 'command string forwarded');
  });

  it('ctx_run_command with no arg is inert', () => {
    const cmdline = require('../dispatch/control/cmdline');
    const seen = [];
    const real = cmdline.runCommandString;
    cmdline.runCommandString = (s) => { seen.push(s); };
    try { actions.handleAction('ctx_run_command', undefined); }
    finally { cmdline.runCommandString = real; }
    eq(seen.length, 0, 'no call without an arg');
  });
});

describe('[ctx-menu] overlay menu.hitTest — cell → row, shared geometry', () => {
  const menu = require('../overlay/menu');
  const { getModel } = require('../app/runtime');

  function seedMenu(items, anchor) {
    getModel().modal.menu = { items, idx: 0, anchor, title: 'Actions' };
  }

  it('maps interior rows to item indices; borders/separators → no item; outside → null', () => {
    // Anchor at (1,1) → box top-left at 0,0 (assuming COLS≥44). Content rows
    // start one below the top border (row 0), so item j sits at screen row 1+j.
    seedMenu([['Copy line', 'copy_text', 'L'], null, ['Copy item', 'copy_text', 'I']], { x: 1, y: 1 });
    eq(menu.hitTest(2, 1).itemIdx, 0, 'first content row → item 0');
    eq(menu.hitTest(2, 2).itemIdx, null, 'separator row → no item');
    eq(menu.hitTest(2, 3).itemIdx, 2, 'third content row → item 2');
    eq(menu.hitTest(2, 0).itemIdx, null, 'top border row → no item');
    eq(menu.hitTest(999, 1), null, 'far outside the box → null (caller closes)');
  });
});

report();
