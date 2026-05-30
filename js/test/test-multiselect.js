/**
 * Multi-select smoke test — exercises state mutation, idOf identity,
 * selectedOrFocused fallback semantics, and group-context reset behavior.
 *
 * Run: node js/test/test-multiselect.js
 */
'use strict';

const { toggleMultiSel, isMultiSel, clearMultiSel, multiSelCount,
        setSel, resetGroupContext } = require('../state');
const api = require('../components/api');
const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../runtime');
const { getComponentSlice } = require('../components/api');
const mnav = require('../model-nav');

// Phase 4a — multi-select state lives on each Navigator Component's
// `slice.nav[panelType].multiSel`. test-runner registers layout/detail/
// groups; register the rest the test exercises so panel-type → Component
// lookup resolves.
api.registerComponent(require('../components/docker'));
api.registerComponent(require('../components/actions'));
api.registerComponent(require('../components/file-manager'));

describe('[1] empty state', () => {
  it('no panel has selection initially', () => {
    eq(multiSelCount('containers'), 0, 'containers has no selection');
    eq(isMultiSel('containers', 'dev9-env'), false, 'item not marked');
  });
});

describe('[2] toggle on / off', () => {
  it('toggle adds and removes', () => {
    toggleMultiSel('containers', 'dev9-env');
    eq(isMultiSel('containers', 'dev9-env'), true, 'after toggle on');
    eq(multiSelCount('containers'), 1, 'count = 1');
    toggleMultiSel('containers', 'gitea');
    eq(multiSelCount('containers'), 2, 'count = 2');
    toggleMultiSel('containers', 'dev9-env');
    eq(isMultiSel('containers', 'dev9-env'), false, 'after toggle off');
    eq(multiSelCount('containers'), 1, 'count back to 1');
  });
});

describe('[3] empty Set semantics', () => {
  it('count goes to 0 when set drains', () => {
    toggleMultiSel('containers', 'gitea');     // count → 0
    eq(multiSelCount('containers'), 0, 'count = 0');
    // Phase 4a — the nav entry always exists on the Component's slice;
    // "no selection" is `multiSel.size === 0`, not a missing key.
  });
});

describe('[4] per-panel isolation', () => {
  it('panel keys do not collide', () => {
    toggleMultiSel('containers', 'dev9-env');
    toggleMultiSel('groups', 'dev9');
    eq(multiSelCount('containers'), 1, 'containers count = 1');
    eq(multiSelCount('groups'), 1, 'groups count = 1');
    eq(isMultiSel('containers', 'dev9'), false, 'panel keys do not collide');
  });
});

describe('[5] clearMultiSel', () => {
  it('clears the named panel only', () => {
    clearMultiSel('containers');
    eq(multiSelCount('containers'), 0, 'cleared');
    eq(multiSelCount('groups'), 1, 'other panel untouched');
  });
});

describe('[6] resetGroupContext drops only containers + actions', () => {
  it('group-scoped panels clear; non-group ones survive', () => {
    toggleMultiSel('containers', 'a');
    toggleMultiSel('actions', 'up');
    toggleMultiSel('file-manager', '/path/to/file');
    // groups is left from earlier
    eq(multiSelCount('containers'), 1, 'containers has selection');
    eq(multiSelCount('actions'), 1, 'actions has selection');
    eq(multiSelCount('file-manager'), 1, 'file-manager has selection');
    getComponentSlice('groups').list = [{ name: 'dev9', containers: [] }];
    setSel('groups', 0);
    getModel().config = { groups: { dev9: { name: 'dev9' } } };
    resetGroupContext();
    eq(multiSelCount('containers'), 0, 'containers cleared on group switch');
    eq(multiSelCount('actions'), 0, 'actions cleared on group switch');
    eq(multiSelCount('file-manager'), 1, 'file-manager preserved (not group-scoped)');
    eq(multiSelCount('groups'), 1, 'groups preserved (not group-scoped)');
  });
});

describe('[7] idOf default fallback', () => {
  it('no panelDef → String(item)', () => {
    eq(api.idOf('nonexistent', 'foo'), 'foo', 'string item → String(item)');
    eq(api.idOf('nonexistent', { name: 'x' }), '[object Object]',
       'object item → String(object) (no idOf defined)');
  });
});

describe('[8] selectedOrFocused with multi-selection', () => {
  it('multi-select takes priority over focused row', () => {
    // Phase 4a — register as a Component (not a Plugin) so the helper-
    // resolved per-panel nav slice exists. Shared nav leaf handles the
    // five Msgs uniformly.
    api.registerComponent({
      name: 'test',
      init: () => ({ nav: { test: mnav.init() } }),
      update: (msg, slice) => mnav.isNavMsg(msg) ? mnav.apply(slice, msg) : slice,
      panelTypes: {
        test: {
          mode: 'list',
          render: () => '',
          getItems: () => ['a', 'b', 'c', 'd'],
          idOf: x => x,
        },
      },
    });
    clearMultiSel('test');
    setSel('test', 1);  // focused on 'b'
    eq(api.selectedOrFocused('test'), ['b'], 'no multi-select → focused single');
    toggleMultiSel('test', 'a');
    toggleMultiSel('test', 'c');
    eq(api.selectedOrFocused('test'), ['a', 'c'],
       'multi-select non-empty → only multi (focused ignored)');
  });
});

describe('[9] selectedOrFocused with empty getItems', () => {
  it('no items → []', () => {
    api.registerComponent({
      name: 'empty',
      init: () => ({ nav: { empty: mnav.init() } }),
      update: (msg, slice) => mnav.isNavMsg(msg) ? mnav.apply(slice, msg) : slice,
      panelTypes: {
        empty: { mode: 'list', render: () => '', getItems: () => [] },
      },
    });
    eq(api.selectedOrFocused('empty'), []);
  });
});

report();
