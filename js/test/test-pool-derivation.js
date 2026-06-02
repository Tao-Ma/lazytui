/**
 * Phase 1 — pure derivations over the panel pool.
 *
 * `leaves/pool.js` derives placed vs hidden from an `arrange` struct
 * (`{ leftPanels, rightPanels, pool, ... }`). These are the building
 * blocks for Phase 2's `:hide` / `:show` Msgs and Phase 4's panel-list
 * overlay. Pure functions; no model, no side effects.
 *
 *   node js/test/test-pool-derivation.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { describe, it, eq, assert, report } = require('./test-runner');
const pool = require('../leaves/pool');
const { parse } = require('../parser');
const { rebuildLayoutFromConfig } = require('../app/state');

let _tmpDir = null;
function tmpYaml(content, name = 'test.yml') {
  if (!_tmpDir) _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-pool-deriv-'));
  const p = path.join(_tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

const GROUPS = `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
`;

describe('[placedIds] reads left then right, in cell order', () => {
  it('returns [] for empty / missing input', () => {
    eq(pool.placedIds(null), []);
    eq(pool.placedIds(undefined), []);
    eq(pool.placedIds({}), []);
    eq(pool.placedIds({ leftPanels: [], rightPanels: [] }), []);
  });
  it('reads left then right, in cell order', () => {
    const arrange = {
      leftPanels: [{ id: 'a' }, { id: 'b' }],
      rightPanels: [{ id: 'c' }, { id: 'd' }],
    };
    eq(pool.placedIds(arrange), ['a', 'b', 'c', 'd']);
  });
  it('skips panels with no id (defensive)', () => {
    const arrange = {
      leftPanels: [{ id: 'a' }, { type: 'noid' }, { id: 'c' }],
      rightPanels: [],
    };
    eq(pool.placedIds(arrange), ['a', 'c']);
  });
});

describe('[hiddenIds] pool entries not in placed cells', () => {
  it('empty when every pool entry is placed', () => {
    const arrange = {
      leftPanels: [{ id: 'a' }],
      rightPanels: [{ id: 'b' }],
      pool: { a: {}, b: {} },
    };
    eq(pool.hiddenIds(arrange), []);
  });
  it('returns pool ids not in any cell', () => {
    const arrange = {
      leftPanels: [{ id: 'a' }],
      rightPanels: [{ id: 'b' }],
      pool: { a: {}, b: {}, hidden1: {}, hidden2: {} },
    };
    eq(pool.hiddenIds(arrange).sort(), ['hidden1', 'hidden2']);
  });
  it('no pool → no hidden ids', () => {
    eq(pool.hiddenIds({ leftPanels: [{ id: 'a' }], rightPanels: [] }), []);
  });
});

describe('[isPlaced / isHidden] mutually exclusive across pool', () => {
  const arrange = {
    leftPanels: [{ id: 'shown' }],
    rightPanels: [{ id: 'detail' }],
    pool: { shown: {}, detail: {}, lurker: {} },
  };
  it('placed entries are placed, not hidden', () => {
    assert(pool.isPlaced(arrange, 'shown'));
    assert(!pool.isHidden(arrange, 'shown'));
  });
  it('pool entries with no placement are hidden', () => {
    assert(!pool.isPlaced(arrange, 'lurker'));
    assert(pool.isHidden(arrange, 'lurker'));
  });
  it('unknown ids are neither placed nor hidden', () => {
    assert(!pool.isPlaced(arrange, 'ghost'));
    assert(!pool.isHidden(arrange, 'ghost'));
  });
});

describe('[getPoolEntry] lookup', () => {
  it('returns the pool entry by id', () => {
    const arrange = { pool: { a: { id: 'a', type: 'groups', title: 'Groups' } } };
    eq(pool.getPoolEntry(arrange, 'a').title, 'Groups');
  });
  it('returns null for missing pool / missing id', () => {
    eq(pool.getPoolEntry({}, 'a'), null);
    eq(pool.getPoolEntry({ pool: {} }, 'a'), null);
  });
});

describe('[orphanPlacements] invariant guard', () => {
  it('empty when every placement has a pool entry', () => {
    const arrange = {
      leftPanels: [{ id: 'a' }],
      rightPanels: [{ id: 'b' }],
      pool: { a: {}, b: {} },
    };
    eq(pool.orphanPlacements(arrange), []);
  });
  it('reports placed ids missing from the pool', () => {
    const arrange = {
      leftPanels: [{ id: 'a' }, { id: 'orphan' }],
      rightPanels: [{ id: 'b' }],
      pool: { a: {}, b: {} },
    };
    eq(pool.orphanPlacements(arrange), ['orphan']);
  });
  it('all placements orphan when pool is missing', () => {
    eq(pool.orphanPlacements({ leftPanels: [{ id: 'a' }], rightPanels: [{ id: 'b' }] }),
       ['a', 'b']);
  });
});

describe('[integration] rebuildLayoutFromConfig plumbs pool + id', () => {
  it('explicit pool form: every cell references a pool id', () => {
    const cfg = parse(tmpYaml(GROUPS + `
panels:
  groups:  { type: groups,  title: G }
  actions: { type: actions, title: A }
  detail:  { type: detail,  title: D }
layout:
  left:  { panels: [groups] }
  right: { panels: [actions, detail] }
`));
    const arrange = rebuildLayoutFromConfig(cfg);
    eq(pool.placedIds(arrange).sort(), ['actions', 'detail', 'groups']);
    eq(pool.hiddenIds(arrange), []);
    assert(arrange.pool.groups, 'pool has groups entry');
    assert(!arrange.pool.groups._synthesized, 'pool entries are explicit, not synthesized');
  });
  it('explicit pool with hidden entry: derivation finds the hidden id', () => {
    const cfg = parse(tmpYaml(GROUPS + `
panels:
  g:     { type: groups, title: G }
  notes: { type: viewer, title: Notes }
  a:     { type: actions, title: A }
  d:     { type: detail, title: D }
layout:
  left:  { panels: [g] }
  right: { panels: [a, d] }
`));
    const arrange = rebuildLayoutFromConfig(cfg);
    eq(pool.placedIds(arrange), ['g', 'a', 'd']);
    eq(pool.hiddenIds(arrange), ['notes']);
    assert(pool.isHidden(arrange, 'notes'));
    eq(pool.getPoolEntry(arrange, 'notes').title, 'Notes');
  });
  it('fallback path (no layout block) synthesizes a pool too', () => {
    const cfg = parse(tmpYaml(GROUPS));
    const arrange = rebuildLayoutFromConfig(cfg);
    assert(arrange.pool && typeof arrange.pool === 'object', 'pool present');
    eq(pool.placedIds(arrange).sort(), ['actions', 'detail', 'groups']);
  });
});

describe('[multi-tab panes] every tab counts as placed; activePaneIds tracks active only', () => {
  it('placedIds enumerates all pool ids across tabs in multi-tab panes', () => {
    const cfg = parse(tmpYaml(GROUPS + `
panels:
  docker: { type: docker, title: Docker }
  logs:   { type: viewer, title: Logs }
  groups: { type: groups, title: Groups }
  actions: { type: actions, title: Actions }
  detail:  { type: detail,  title: Detail }
layout:
  left:
    panels:
      - { tabs: [docker, logs] }
      - groups
  right:
    panels:
      - actions
      - detail
`));
    const arrange = rebuildLayoutFromConfig(cfg);
    eq(pool.placedIds(arrange).sort(), ['actions', 'detail', 'docker', 'groups', 'logs'],
       'every tab id appears in placedIds, including non-active logs');
    eq(pool.activePaneIds(arrange), ['docker', 'groups', 'actions', 'detail'],
       'activePaneIds returns one id per pane (the active tab)');
    eq(pool.hiddenIds(arrange), [],
       'no pool entries are hidden — every tab is mounted');
    assert(pool.isPlaced(arrange, 'logs'), 'non-active tab counts as placed');
    assert(!pool.isHidden(arrange, 'logs'), 'non-active tab is NOT hidden');
  });

  it('hidden entry stays hidden when not in any pane.tabs', () => {
    const cfg = parse(tmpYaml(GROUPS + `
panels:
  docker: { type: docker }
  logs:   { type: viewer, title: Logs }
  notes:  { type: viewer, title: Notes }
  groups: { type: groups }
  actions: { type: actions }
  detail:  { type: detail }
layout:
  left:
    panels:
      - { tabs: [docker, logs] }
      - groups
  right:
    panels:
      - actions
      - detail
`));
    const arrange = rebuildLayoutFromConfig(cfg);
    eq(pool.hiddenIds(arrange), ['notes'], 'notes is truly hidden');
    assert(pool.isPlaced(arrange, 'logs'),  'logs (a tab) is placed');
    assert(pool.isHidden(arrange, 'notes'), 'notes (not in any tab) is hidden');
  });
});

report();
