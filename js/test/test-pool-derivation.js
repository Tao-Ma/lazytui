/**
 * Phase 1 — pure derivations over the panel pool.
 *
 * `leaves/pool.js` derives placed vs hidden from an `arrange` struct
 * (`{ columns: [{panels:[...]}], pool, ... }`). These are the building
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
const { rebuildLayoutFromConfig } = require('../leaves/arrange');

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

describe('[placedIds] reads columns in order', () => {
  it('returns [] for empty / missing input', () => {
    eq(pool.placedIds(null), []);
    eq(pool.placedIds(undefined), []);
    eq(pool.placedIds({}), []);
    eq(pool.placedIds({ columns: [{ panels: [] }, { panels: [] }] }), []);
  });
  it('reads columns in order, cell-major', () => {
    const arrange = {
      columns: [
        { panels: [{ id: 'a' }, { id: 'b' }] },
        { panels: [{ id: 'c' }, { id: 'd' }] },
      ],
    };
    eq(pool.placedIds(arrange), ['a', 'b', 'c', 'd']);
  });
  it('skips panels with no id (defensive)', () => {
    const arrange = {
      columns: [
        { panels: [{ id: 'a' }, { type: 'noid' }, { id: 'c' }] },
        { panels: [] },
      ],
    };
    eq(pool.placedIds(arrange), ['a', 'c']);
  });
});

describe('[hiddenIds] pool entries not in placed cells', () => {
  it('empty when every pool entry is placed', () => {
    const arrange = {
      columns: [
        { panels: [{ id: 'a' }] },
        { panels: [{ id: 'b' }] },
      ],
      pool: { a: {}, b: {} },
    };
    eq(pool.hiddenIds(arrange), []);
  });
  it('returns pool ids not in any cell', () => {
    const arrange = {
      columns: [
        { panels: [{ id: 'a' }] },
        { panels: [{ id: 'b' }] },
      ],
      pool: { a: {}, b: {}, hidden1: {}, hidden2: {} },
    };
    eq(pool.hiddenIds(arrange).sort(), ['hidden1', 'hidden2']);
  });
  it('no pool → no hidden ids', () => {
    eq(pool.hiddenIds({ columns: [{ panels: [{ id: 'a' }] }, { panels: [] }] }), []);
  });
});

describe('[isPlaced / isHidden] mutually exclusive across pool', () => {
  const arrange = {
    columns: [
      { panels: [{ id: 'shown' }] },
      { panels: [{ id: 'detail' }] },
    ],
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
      columns: [
        { panels: [{ id: 'a' }] },
        { panels: [{ id: 'b' }] },
      ],
      pool: { a: {}, b: {} },
    };
    eq(pool.orphanPlacements(arrange), []);
  });
  it('reports placed ids missing from the pool', () => {
    const arrange = {
      columns: [
        { panels: [{ id: 'a' }, { id: 'orphan' }] },
        { panels: [{ id: 'b' }] },
      ],
      pool: { a: {}, b: {} },
    };
    eq(pool.orphanPlacements(arrange), ['orphan']);
  });
  it('all placements orphan when pool is missing', () => {
    eq(pool.orphanPlacements({ columns: [{ panels: [{ id: 'a' }] }, { panels: [{ id: 'b' }] }] }),
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
  columns:
    - { panels: [groups] }
    - { panels: [actions, detail] }
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
  columns:
    - { panels: [g] }
    - { panels: [a, d] }
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
  columns:
    - panels:
        - { tabs: [docker, logs] }
        - groups
    - panels:
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
  columns:
    - panels:
        - { tabs: [docker, logs] }
        - groups
    - panels:
        - actions
        - detail
`));
    const arrange = rebuildLayoutFromConfig(cfg);
    eq(pool.hiddenIds(arrange), ['notes'], 'notes is truly hidden');
    assert(pool.isPlaced(arrange, 'logs'),  'logs (a tab) is placed');
    assert(pool.isHidden(arrange, 'notes'), 'notes (not in any tab) is hidden');
  });
});

describe('[distributeColumnWidths] renderer + hit-test single source of truth', () => {
  it('wide terminal: explicit widths, last column takes remainder', () => {
    const arrange = { columns: [{ width: 30 }, { width: 30 }, {}] };
    const r = pool.distributeColumnWidths(arrange, 120);
    eq(r.map(c => c.x), [0, 30, 60], 'x positions');
    eq(r.map(c => c.w), [30, 30, 60], 'widths (last = COLS-sumExplicit)');
  });

  it('narrow terminal triggers squeeze: last column gets MIN_LAST_COL_W', () => {
    // COLS=60, explicit=[30,30] → naive lastW = 0, < MIN_LAST (20). Squeeze
    // shrinks both donors to 20 each so last gets 20.
    const arrange = { columns: [{ width: 30 }, { width: 30 }, {}] };
    const r = pool.distributeColumnWidths(arrange, 60);
    eq(r[0].w, 20, 'donor 0 shrunk');
    eq(r[1].w, 20, 'donor 1 shrunk');
    eq(r[2].w, 20, 'last column gets MIN_LAST_COL_W');
    eq(r[0].w + r[1].w + r[2].w, 60, 'widths sum to COLS');
    eq(r[1].x, 20, 'col 1 starts after col 0');
    eq(r[2].x, 40, 'col 2 starts after col 1');
  });

  it('donor floor: explicit columns never shrink below MIN_COL_W (10)', () => {
    // COLS=30 with 3 cols of explicit-30 → severe squeeze; donors floor at 10
    // each, last column absorbs the rest.
    const arrange = { columns: [{ width: 30 }, { width: 30 }, {}] };
    const r = pool.distributeColumnWidths(arrange, 30);
    assert(r[0].w >= 10, 'donor 0 >= MIN_COL_W');
    assert(r[1].w >= 10, 'donor 1 >= MIN_COL_W');
    assert(r[2].w >= 1,  'last column always >= 1');
  });

  it('hit-test and renderer agree on the same point under squeeze', () => {
    // The renderer paints col 1 at x=20..39 under squeeze. A click at x=25
    // must map to col 1 in the hit-tester too — that's exactly the bug
    // T1.1 fixed (was mapping to col 0 because the hit-tester used raw
    // explicit widths).
    const arrange = { columns: [{ width: 30 }, { width: 30 }, {}] };
    const r = pool.distributeColumnWidths(arrange, 60);
    const click = 25;
    const col = r.find(c => click >= c.x && click < c.x + c.w);
    eq(col.columnIndex, 1, 'click at x=25 lands in col 1 (renderer-painted range 20..39)');
  });

  it('default column width is 30 when width is null/undefined', () => {
    const arrange = { columns: [{}, {}, {}] };
    const r = pool.distributeColumnWidths(arrange, 120);
    eq(r[0].w, 30, 'col 0 default');
    eq(r[1].w, 30, 'col 1 default');
    eq(r[2].w, 60, 'last column takes remainder');
  });

  it('empty columns array returns empty', () => {
    eq(pool.distributeColumnWidths({ columns: [] }, 80), []);
    eq(pool.distributeColumnWidths({}, 80), []);
  });
});

report();
