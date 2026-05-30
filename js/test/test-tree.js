/**
 * Unit tests for the group tree (state.js): recomputeGroups visibility,
 * expand/collapse one-level vs recursive, cursor resync after collapse.
 *
 * Run: node js/test/test-tree.js
 *
 * Avoids loading plugins/api.js (node-pty in cleanup→terminal); state.js
 * has no PTY dependency, so we drive its API directly.
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../runtime');
const { getComponentSlice } = require('../components/api');

const {
  recomputeGroups, expandGroup, collapseGroup, switchGroupsTab,
  setSel, getSel,
} = require('../state');

// Build a 3-level synthetic tree directly into getModel().config.groups so we
// don't rely on the parser. DFS pre-order matters — same shape the
// parser emits.
function setupTree() {
  getModel().config = {
    groups: {
      'a': {
        name: 'a', label: 'A', containers: [], actions: {}, quick: false,
        children: ['a.x', 'a.y'], parent: null, depth: 0,
      },
      'a.x': {
        name: 'a.x', label: 'X', containers: [], actions: {}, quick: false,
        children: ['a.x.deep'], parent: 'a', depth: 1,
      },
      'a.x.deep': {
        name: 'a.x.deep', label: 'Deep', containers: [], quick: true,
        actions: { run: { label: 'Run', type: 'run', script: 'echo' } },
        children: [], parent: 'a.x', depth: 2,
      },
      'a.y': {
        name: 'a.y', label: 'Y', containers: [], quick: false,
        actions: { go: { label: 'Go', type: 'run', script: 'echo' } },
        children: [], parent: 'a', depth: 1,
      },
      'b': {
        name: 'b', label: 'B', containers: [], quick: true,
        actions: { tick: { label: 'Tick', type: 'run', script: 'echo' } },
        children: [], parent: null, depth: 0,
      },
    },
  };
  getComponentSlice('groups').expanded = new Set();
  getComponentSlice('groups').tab = 'all';
  setSel('groups', 0);
  getModel().currentGroup = '';
  getModel().ui.filters = {};
  recomputeGroups();
  getModel().currentGroup = getComponentSlice('groups').list[0].name;
}

describe('[1] default visibility = roots only', () => {
  it('only top-level groups visible at boot', () => {
    setupTree();
    eq(getComponentSlice('groups').list.map(g => g.name), ['a', 'b'], 'two roots, no descendants');
  });
});

describe('[2] expandGroup — one level', () => {
  it('opens direct children but not grandchildren', () => {
    setupTree();
    expandGroup('a', false);
    eq(getComponentSlice('groups').list.map(g => g.name), ['a', 'a.x', 'a.y', 'b'],
       'a.x.deep stays hidden');
  });
});

describe('[3] expandGroup — recursive', () => {
  it('opens entire subtree', () => {
    setupTree();
    expandGroup('a', true);
    eq(getComponentSlice('groups').list.map(g => g.name),
       ['a', 'a.x', 'a.x.deep', 'a.y', 'b'],
       'every descendant of a is visible');
  });
});

describe('[4] collapseGroup — one level', () => {
  it('hides direct subtree but inner expanded state lingers (lazy)', () => {
    setupTree();
    expandGroup('a', true);
    collapseGroup('a', false);
    eq(getComponentSlice('groups').list.map(g => g.name), ['a', 'b'], 'subtree gone from view');
    // Non-recursive collapse leaves a.x in expandedGroups; re-expanding a
    // pops the previously-open state back out (intentional).
    expandGroup('a', false);
    eq(getComponentSlice('groups').list.map(g => g.name), ['a', 'a.x', 'a.x.deep', 'a.y', 'b'],
       'inner expansion restored on re-open');
  });
});

describe('[5] collapseGroup — recursive', () => {
  it('strips inner expand state too (clean slate)', () => {
    setupTree();
    expandGroup('a', true);
    collapseGroup('a', true);
    expandGroup('a', false);
    eq(getComponentSlice('groups').list.map(g => g.name), ['a', 'a.x', 'a.y', 'b'],
       'a.x is collapsed again after recursive wipe');
  });
});

describe('[6] cursor resync — points to nearest visible ancestor', () => {
  it('collapsing parent moves cursor up to it', () => {
    setupTree();
    expandGroup('a', true);
    // Place cursor on a.x.deep (a leaf).
    const idx = getComponentSlice('groups').list.findIndex(g => g.name === 'a.x.deep');
    setSel('groups', idx);
    getModel().currentGroup = 'a.x.deep';
    // Collapse a — descendants disappear; cursor should land on 'a'.
    collapseGroup('a', false);
    eq(getModel().currentGroup, 'a', 'cursor walked up to nearest visible ancestor');
    eq(getSel('groups'), 0, 'sel index points at the new currentGroup row');
  });
});

describe('[7] expandGroup on leaf — no-op', () => {
  it('a leaf has no children to open', () => {
    setupTree();
    expandGroup('b', false);
    eq(getComponentSlice('groups').list.map(g => g.name), ['a', 'b'], 'still only roots');
  });
});

describe('[8] Quick tab — flat list of pinned groups, any depth', () => {
  it('quick tab shows pinned nodes regardless of tree state', () => {
    setupTree();
    switchGroupsTab('quick');
    // a.x.deep is pinned (depth 2) and b is pinned (depth 0). Order is
    // YAML / DFS order: a.x.deep comes before b.
    eq(getComponentSlice('groups').list.map(g => g.name), ['a.x.deep', 'b'],
       'flat pinned list — depth ignored');
  });

  it('toggling back to all restores tree visibility', () => {
    setupTree();
    expandGroup('a', false);
    switchGroupsTab('quick');
    switchGroupsTab('all');
    eq(getComponentSlice('groups').list.map(g => g.name), ['a', 'a.x', 'a.y', 'b'],
       'tree state preserved across tab toggles');
  });

  it('cursor on a non-pinned row falls back to row 0 in quick', () => {
    setupTree();
    expandGroup('a', true);
    // Cursor on a.y (not pinned).
    const idx = getComponentSlice('groups').list.findIndex(g => g.name === 'a.y');
    setSel('groups', idx);
    getModel().currentGroup = 'a.y';
    switchGroupsTab('quick');
    eq(getModel().currentGroup, 'a.x.deep', 'cursor jumps to first pinned row');
    eq(getSel('groups'), 0, 'sel index is 0');
  });
});

report();
