/**
 * Phase 0 — `panels:` pool + layout cell resolution.
 *
 * Pins the v0.6 schema: pool entries are first-class panel identities;
 * layout cells reference them by id (string or `{id, ...overrides}`);
 * legacy inline `{type:}` cells synthesize implicit pool entries with
 * `_synthesized: true` so Phase 6 round-trip can preserve them in
 * their original inline form.
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

// Schema-layer errors (structural shape) fire before the resolver runs;
// resolver-layer errors (semantic, pool-aware) fire during parseLayout.
function expectThrow(re, fn, kind = ParseError) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  assert(threw !== null, 'expected throw');
  if (threw) {
    assert(threw instanceof kind, `is ${kind.name} (got ${threw.constructor.name}): ${threw.message}`);
    assert(re.test(threw.message), `error message matches ${re}: ${threw.message}`);
  }
}

describe('[default layout] synthesizes a pool from built-in panels', () => {
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
});

describe('[legacy inline form] synthesizes pool from inline {type:} cells', () => {
  it('each unique type → pool entry keyed by type', () => {
    const p = tmpYaml(TRIVIAL_GROUPS + `
layout:
  left:
    panels:
      - { type: groups, title: G }
  right:
    panels:
      - { type: actions, title: A }
      - { type: stats,  title: S, topic: foo }
      - { type: detail, title: D }
`);
    const cfg = parse(p);
    eq(Object.keys(cfg.layout.pool).sort(), ['actions', 'detail', 'groups', 'stats']);
    eq(cfg.layout.pool.stats.config.topic, 'foo', 'plugin-specific config carried into pool');
    eq(cfg.layout.pool.stats._synthesized, true, 'synthesized flag set on inline-derived entries');
  });
  it('duplicate inline types autonumber: type, type-2, type-3', () => {
    const p = tmpYaml(TRIVIAL_GROUPS + `
layout:
  left:
    panels:
      - { type: viewer, title: V1 }
      - { type: viewer, title: V2 }
      - { type: viewer, title: V3 }
  right:
    panels:
      - { type: actions, title: A }
      - { type: detail,  title: D }
`);
    const cfg = parse(p);
    eq(cfg.layout.left_panels.map(p => p.id), ['viewer', 'viewer-2', 'viewer-3']);
    eq(cfg.layout.pool['viewer'].title,   'V1');
    eq(cfg.layout.pool['viewer-2'].title, 'V2');
    eq(cfg.layout.pool['viewer-3'].title, 'V3');
  });
});

describe('[explicit pool] top-level panels: block — declared entries are not synthesized', () => {
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
  it('layout cell as { id, ...overrides } applies placement-level overrides', () => {
    const p = tmpYaml(TRIVIAL_GROUPS + `
panels:
  g: { type: groups, title: Groups }
  a: { type: actions, title: Actions }
  d: { type: detail, title: Detail }
layout:
  right:
    panels:
      - a
      - { id: d, height: 70% }
`);
    const cfg = parse(p);
    eq(cfg.layout.detail_height_pct, 70, 'height override on placement lifted into detail_height_pct');
  });
  it('declared pool entries with no placement remain in pool (hidden)', () => {
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
    assert('notes' in cfg.layout.pool, 'notes is still in the pool — that is what makes it hideable');
  });
});

describe('[mixed] explicit pool + inline cells coexist; inline ids autonumber around the pool', () => {
  it('inline {type:viewer} uses viewer-2 when viewer is in pool', () => {
    const p = tmpYaml(TRIVIAL_GROUPS + `
panels:
  viewer: { type: viewer, title: PoolViewer }
  a:      { type: actions }
  d:      { type: detail }
layout:
  left:
    panels:
      - viewer
      - { type: viewer, title: InlineViewer }
  right:
    panels: [a, d]
`);
    const cfg = parse(p);
    eq(cfg.layout.left_panels.map(p => p.id), ['viewer', 'viewer-2']);
    eq(cfg.layout.pool.viewer.title,   'PoolViewer',   'pool entry preserved');
    eq(cfg.layout.pool['viewer-2'].title, 'InlineViewer', 'inline cell synthesized as viewer-2');
    eq(cfg.layout.pool['viewer-2']._synthesized, true);
  });
});

describe('[errors]', () => {
  it('layout cell references unknown id → ParseError', () => {
    expectThrow(/unknown panel id 'ghost'/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
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
  it('declare-in-place collision with declared pool id → ParseError', () => {
    expectThrow(/pool entry already exists with that id/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
panels:
  viewer: { type: viewer }
  a:      { type: actions }
  d:      { type: detail }
layout:
  left:
    panels: [{ id: viewer, type: viewer, title: Dup }]
  right:
    panels: [a, d]
`)));
  });
  it('layout cell missing both id and type → SchemaError', () => {
    expectThrow(/missing both 'id' and 'type'/, () => parse(tmpYaml(TRIVIAL_GROUPS + `
layout:
  right:
    panels: [{ title: Headless }]
`)), SchemaError);
  });
});

describe('[regression] existing inline-form layouts still produce v0.5 shape', () => {
  it('left_panels / right_panels arrays carry type/title/hotkey/column/config', () => {
    const p = tmpYaml(TRIVIAL_GROUPS + `
layout:
  left:
    panels:
      - { type: groups, title: G }
  right:
    panels:
      - { type: actions, title: A }
      - { type: detail,  title: D, height: 60% }
`);
    const cfg = parse(p);
    eq(cfg.layout.left_panels.length, 1);
    eq(cfg.layout.left_panels[0].type, 'groups');
    eq(cfg.layout.left_panels[0].hotkey, '1');
    eq(cfg.layout.left_panels[0].column, 'left');
    eq(cfg.layout.right_panels[1].type, 'detail');
    eq(cfg.layout.detail_height_pct, 60);
  });
});

report();
