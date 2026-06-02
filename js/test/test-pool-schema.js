/**
 * v0.6.1 — `panels:` pool + pool-ref layout cells.
 *
 * Pins the v0.6.1 schema:
 *   - Pool entries are first-class panel identities declared under a
 *     top-level `panels:` block (or synthesized by the default layout
 *     when no `layout:` block is present).
 *   - Layout cells reference pool entries by id, either as a bare
 *     string (single-tab pane shorthand) or as a `{tabs: [pool-id,
 *     ...]}` mapping (multi-tab pane or placement overrides).
 *   - v0.6's legacy inline `{type: ...}` cells reject loudly with a
 *     migration pointer.
 *
 *   node js/test/test-pool-schema.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parse } = require('../parser');
const { ParseError, SchemaError } = require('../parser/errors');
const { describe, it, assert, eq, report } = require('./test-runner');

let _tmpDir = null;
function tmpYaml(content, name = 'test.yml') {
  if (!_tmpDir) _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-pool-'));
  const p = path.join(_tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

const TRIVIAL_GROUPS = `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
`;

// Schema-layer errors fire on structural shape (during validate()).
// Resolver-layer errors fire during parseLayout (semantic, pool-aware).
function expectThrow(re, fn, kind = ParseError) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  assert(threw !== null, 'expected throw');
  if (threw) {
    assert(threw instanceof kind, `is ${kind.name} (got ${threw.constructor.name}): ${threw.message}`);
    assert(re.test(threw.message), `error message matches ${re}: ${threw.message}`);
  }
}

describe('[default layout] synthesizes a pool from built-in panels when no layout: block', () => {
  it('default layout always produces a pool', () => {
    const p = tmpYaml(TRIVIAL_GROUPS);
    const cfg = parse(p);
    assert(cfg.layout.pool && typeof cfg.layout.pool === 'object', 'pool field present');
    // Without containers / files in fixtures, default panels are: groups,
    // actions, detail.
    eq(Object.keys(cfg.layout.pool).sort(), ['actions', 'detail', 'groups']);
    eq(cfg.layout.pool.groups.type, 'groups');
    eq(cfg.layout.pool.groups.id, 'groups');
    eq(cfg.layout.pool.groups._synthesized, true);
  });
  it('every placed panel carries its pool id', () => {
    const p = tmpYaml(TRIVIAL_GROUPS);
    const cfg = parse(p);
    for (const panel of cfg.layout.left_panels.concat(cfg.layout.right_panels)) {
      assert(typeof panel.id === 'string' && panel.id, `panel ${panel.type} has id`);
      assert(panel.id in cfg.layout.pool, `panel id ${panel.id} resolves in pool`);
    }
  });
  it('placed panes carry tabs[] + activeTabId', () => {
    const p = tmpYaml(TRIVIAL_GROUPS);
    const cfg = parse(p);
    for (const panel of cfg.layout.left_panels.concat(cfg.layout.right_panels)) {
      assert(Array.isArray(panel.tabs) && panel.tabs.length >= 1, `tabs[] non-empty for ${panel.id}`);
      eq(panel.activeTabId, panel.tabs[0].id, `activeTabId points at first tab for ${panel.id}`);
    }
  });
});

describe('[bare-string cells] single-tab pane shorthand', () => {
  it('layout cell as string id references the pool', () => {
    const p = tmpYaml(TRIVIAL_GROUPS + `
panels:
  g:
    type: groups
    title: Groups
  a:
    type: actions
    title: Actions
  d:
    type: detail
    title: Detail
layout:
  left:
    panels: [g]
  right:
    panels: [a, d]
`);
    const cfg = parse(p);
    eq(cfg.layout.left_panels.map(p => p.id), ['g']);
    eq(cfg.layout.right_panels.map(p => p.id), ['a', 'd']);
    assert(!cfg.layout.pool.g._synthesized, 'user-declared entry is not synthesized');
    assert(!cfg.layout.pool.a._synthesized, 'user-declared entry is not synthesized');
  });

  it('bare-string cell mints a single-tab pane', () => {
    const p = tmpYaml(TRIVIAL_GROUPS + `
panels:
  g: { type: groups }
  a: { type: actions }
  d: { type: detail }
layout:
  left:  { panels: [g] }
  right: { panels: [a, d] }
`);
    const cfg = parse(p);
    const g = cfg.layout.left_panels[0];
    eq(g.tabs.length, 1, 'single-tab pane');
    eq(g.tabs[0].poolId, 'g', 'tab references pool entry');
    eq(g.activeTabId, 'g', 'active tab is the sole tab');
  });
});

describe('[mapping cells] {tabs: [...]} multi-tab pane + placement overrides', () => {
  it('multi-tab cell mints a pane with multiple tabs; activeTab defaults to tabs[0]', () => {
    const p = tmpYaml(TRIVIAL_GROUPS + `
panels:
  docker: { type: docker, title: Docker }
  logs:   { type: viewer, title: Logs }
  a:      { type: actions, title: Actions }
  d:      { type: detail, title: Detail }
layout:
  left:
    panels:
      - { tabs: [docker, logs] }
  right:
    panels: [a, d]
`);
    const cfg = parse(p);
    const pane = cfg.layout.left_panels[0];
    eq(pane.tabs.map(t => t.poolId), ['docker', 'logs'], 'tabs ordered as declared');
    eq(pane.activeTabId, 'docker', 'activeTab defaults to tabs[0]');
  });

  it('explicit activeTab picks a non-first tab', () => {
    const p = tmpYaml(TRIVIAL_GROUPS + `
panels:
  docker: { type: docker, title: Docker }
  logs:   { type: viewer, title: Logs }
  a:      { type: actions, title: Actions }
  d:      { type: detail, title: Detail }
layout:
  left:
    panels:
      - { tabs: [docker, logs], activeTab: logs }
  right:
    panels: [a, d]
`);
    const cfg = parse(p);
    eq(cfg.layout.left_panels[0].activeTabId, 'logs', 'activeTab honoured');
  });

  it('placement overrides (heightPct, collapsed, height) live on the cell', () => {
    const p = tmpYaml(TRIVIAL_GROUPS + `
panels:
  g: { type: groups, title: Groups }
  a: { type: actions, title: Actions }
  d: { type: detail, title: Detail }
layout:
  left:
    panels:
      - { tabs: [g], heightPct: 40 }
  right:
    panels:
      - a
      - { tabs: [d], height: 70% }
`);
    const cfg = parse(p);
    eq(cfg.layout.left_panels[0].heightPct, 40, 'heightPct lifted onto the pane');
    eq(cfg.layout.detail_height_pct, 70, 'detail height lifted onto layout-level field');
  });
});

describe('[hidden entries] declared pool entries with no placement remain in the pool', () => {
  it('declared but unplaced entries survive into cfg.layout.pool', () => {
    const p = tmpYaml(TRIVIAL_GROUPS + `
panels:
  g:     { type: groups }
  notes: { type: viewer, title: Notes }
  a:     { type: actions }
  d:     { type: detail }
layout:
  left:  { panels: [g] }
  right: { panels: [a, d] }
`);
    const cfg = parse(p);
    const placedIds = cfg.layout.left_panels.concat(cfg.layout.right_panels).map(p => p.id);
    assert(!placedIds.includes('notes'), 'notes is not placed');
    assert('notes' in cfg.layout.pool,    'notes is still in the pool — that is what makes it hideable');
  });
});

describe('[errors] schema-level rejection of legacy + malformed cells', () => {
  it("v0.6 inline {type:} cell rejects with a migration pointer", () => {
    expectThrow(/v0.6 inline cell shape.*not supported in v0\.6\.1/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  g: { type: groups }
  a: { type: actions }
  d: { type: detail }
layout:
  left:
    panels:
      - { type: viewer, title: Inline }
  right:
    panels: [a, d]
`)), SchemaError);
  });

  it("v0.6 inline {id:} cell rejects too", () => {
    expectThrow(/v0.6 inline cell shape/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  g: { type: groups }
  a: { type: actions }
  d: { type: detail }
layout:
  left:
    panels: [{ id: g }]
  right:
    panels: [a, d]
`)), SchemaError);
  });

  it("mapping cell missing tabs: → SchemaError", () => {
    expectThrow(/requires 'tabs:/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  g: { type: groups }
  a: { type: actions }
  d: { type: detail }
layout:
  left:
    panels: [{ heightPct: 40 }]
  right:
    panels: [a, d]
`)), SchemaError);
  });

  it("empty tabs: list → SchemaError", () => {
    expectThrow(/'tabs' must be a non-empty list/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  g: { type: groups }
  a: { type: actions }
  d: { type: detail }
layout:
  left:
    panels: [{ tabs: [] }]
  right:
    panels: [a, d]
`)), SchemaError);
  });

  it("activeTab not in tabs list → SchemaError", () => {
    expectThrow(/'activeTab' must be one of/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  g: { type: groups }
  a: { type: actions }
  d: { type: detail }
layout:
  left:
    panels: [{ tabs: [g], activeTab: a }]
  right:
    panels: [a, d]
`)), SchemaError);
  });
});

describe('[errors] resolver-level pool-aware rejection', () => {
  it('layout cell references unknown id → ParseError', () => {
    expectThrow(/unknown panel id 'ghost'|unknown pool id 'ghost'/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  a: { type: actions }
  d: { type: detail }
layout:
  right:
    panels: [a, ghost, d]
`)));
  });

  it("'panels:' must be a mapping", () => {
    expectThrow(/must be a mapping/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  - { id: foo, type: bar }
`)), SchemaError);
  });

  it('pool entry missing type → ParseError', () => {
    expectThrow(/missing required field 'type'/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  ghost: { title: Ghost }
`)));
  });

  it('placement-only field at pool level → ParseError', () => {
    expectThrow(/'hotkey' is a placement field/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  a: { type: actions, hotkey: 7 }
`)));
  });
});

describe('[detail invariant] exactly one detail tab anywhere; last pane of right column', () => {
  it('zero detail tabs → ParseError', () => {
    expectThrow(/exactly one tab of kind 'detail'/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  g: { type: groups }
  a: { type: actions }
layout:
  left:  { panels: [g] }
  right: { panels: [a] }
`)));
  });

  it('two detail tabs (split across panes) → ParseError', () => {
    expectThrow(/exactly one tab of kind 'detail'/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  g:  { type: groups }
  a:  { type: actions }
  d1: { type: detail, title: D1 }
  d2: { type: detail, title: D2 }
layout:
  left:  { panels: [g] }
  right: { panels: [a, d1, d2] }
`)));
  });

  it('detail tab in left column → ParseError', () => {
    expectThrow(/'detail' must be in the right column/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  g: { type: groups }
  a: { type: actions }
  d: { type: detail }
layout:
  left:  { panels: [g, d] }
  right: { panels: [a] }
`)));
  });

  it("detail tab not in last pane of right column → ParseError", () => {
    expectThrow(/last pane of the right column/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  g: { type: groups }
  a: { type: actions }
  d: { type: detail }
layout:
  left:  { panels: [g] }
  right: { panels: [d, a] }
`)));
  });
});

report();
