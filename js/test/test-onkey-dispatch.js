/**
 * Plugin onKey dispatch — regression for the "list-mode-only" gap.
 *
 * Before the fix, dispatchPluginKey required both onKey AND getItems, so
 * content / stream / tree / terminal-mode panels with only `render` +
 * `onKey` were silently ignored. Verifies that:
 *
 *   1. A list-mode panel still receives the focused item.
 *   2. A content-mode panel (no getItems) still gets onKey called with
 *      `item === null` and can claim the key by returning true.
 *   3. A panel without onKey is left to fall through (returns false).
 *
 * Run: node js/test/test-onkey-dispatch.js
 */
'use strict';

const api = require('../plugins/api');
const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../runtime');


// dispatch.js is wired to api.getComponentSlice("layout").focus. Import after S is in scope so the
// module's getPanelDef/getItems read the same singleton.
const { _dispatchPluginKey } = require('../dispatch');

const calls = [];
api.registerPlugin({
  name: 'onkey-test',
  panelTypes: {
    listy: {
      mode: 'list',
      render() { return ''; },
      getItems() { return ['a', 'b', 'c']; },
      onKey(key, item, state) { calls.push({ panel: 'listy', key, item }); return key === 'i'; },
    },
    contenty: {
      mode: 'content',
      render() { return 'static content'; },
      onKey(key, item, state) { calls.push({ panel: 'contenty', key, item }); return key === 'r'; },
    },
    silent: {
      mode: 'content',
      render() { return ''; },
      // no onKey
    },
  },
});

getModel().ui.sel = { listy: 1, contenty: 0, silent: 0 };
getModel().ui.filters = {};

describe('[1] list-mode panel receives focused item', () => {
  it('item is the row at getModel().ui.sel[panel]', () => {
    api.getComponentSlice("layout").focus = 'listy';
    calls.length = 0;
    const claimed = _dispatchPluginKey('i');
    eq(calls.length, 1, 'onKey fired once');
    eq(calls[0].panel, 'listy', 'panel name');
    eq(calls[0].item, 'b', 'focused item is items[1]');
    eq(claimed, true, 'returning true claims the key');
  });
});

describe('[2] content-mode panel gets onKey with item=null', () => {
  it('non-list panels still get the hook (regression)', () => {
    api.getComponentSlice("layout").focus = 'contenty';
    calls.length = 0;
    const claimed = _dispatchPluginKey('r');
    eq(calls.length, 1, 'onKey fired once');
    eq(calls[0].panel, 'contenty', 'panel name');
    eq(calls[0].item, null, 'item is null for non-list panel');
    eq(claimed, true, 'plugin can still claim the key');
  });
  it('non-claiming return falls through', () => {
    calls.length = 0;
    const claimed = _dispatchPluginKey('x');
    eq(calls.length, 1, 'onKey saw the key');
    eq(claimed, false, 'returning anything but true means unclaimed');
  });
});

describe('[3] panel without onKey is a no-op', () => {
  it('returns false without throwing', () => {
    api.getComponentSlice("layout").focus = 'silent';
    calls.length = 0;
    const claimed = _dispatchPluginKey('z');
    eq(calls.length, 0, 'no onKey to call');
    eq(claimed, false, 'unclaimed');
  });
});

report();
