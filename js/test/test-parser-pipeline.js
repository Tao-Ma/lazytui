/**
 * End-to-end parser pipeline. JS port of tests/test_parser.py.
 *
 *   node js/test/test-parser-pipeline.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parse } = require('../parser');
const { ParseError, SchemaError, ResolutionError } = require('../parser/errors');
const { describe, it, assert, eq, report } = require('./test-runner');

const FIXTURES = path.resolve(__dirname, 'fixtures');
const parseFixture = (name) => parse(path.join(FIXTURES, name));

let _tmpDir = null;
function tmpYaml(content, name = 'test.yml') {
  if (!_tmpDir) _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-test-'));
  const p = path.join(_tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

function expectThrow(re, fn, kind = ParseError) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  assert(threw !== null, 'expected throw');
  if (threw) {
    assert(threw instanceof kind, `is ${kind.name} (got ${threw && threw.constructor && threw.constructor.name})`);
    assert(re.test(threw.message), `error message matches ${re}: ${threw.message}`);
  }
}

describe('plugins block pass-through (regression: JS parser port dropped it)', () => {
  it('plugins map appears verbatim on the parsed config', () => {
    // Historical: the JS parser port dropped this block, so the legacy
    // loadPlugins() silently never loaded `path: ./foo.js` plugins.
    // Phase 6 retired the Plugin API entirely; the field is now unused
    // at runtime, but the parser still preserves it so a config carrying
    // a stale `plugins:` block round-trips losslessly. tui.js surfaces a
    // one-time warning if the block is non-empty.
    const p = tmpYaml(`
groups:
  g:
    label: G
    actions:
      a: { cmd: 'echo a', label: A }
plugins:
  myplugin:
    path: ./myplugin.js
    custom_opt: 42
`);
    const cfg = parse(p);
    assert(cfg.plugins && typeof cfg.plugins === 'object',
      'cfg.plugins is present and a mapping');
    assert(cfg.plugins.myplugin, 'myplugin entry preserved');
    eq(cfg.plugins.myplugin.path, './myplugin.js');
    eq(cfg.plugins.myplugin.custom_opt, 42);
  });

  it('no plugins block → cfg.plugins is an empty object (never undefined)', () => {
    // `{}` is the kinder contract: lets callers Object.keys() /
    // Object.entries() without guarding. (Plugin loading itself retired
    // in Phase 6; this is purely a parser shape guarantee now.)
    const p = tmpYaml(`
groups:
  g:
    label: G
    actions:
      a: { cmd: 'echo a', label: A }
`);
    const cfg = parse(p);
    assert(cfg.plugins !== undefined, 'plugins key is present');
    eq(typeof cfg.plugins, 'object');
    eq(Object.keys(cfg.plugins).length, 0, 'empty object, not undefined');
  });
});

describe('successful parsing', () => {
  it('minimal_cmd', () => {
    const cfg = parseFixture('minimal_cmd.yml');
    eq(Object.keys(cfg.groups).length, 1);
    assert('mygroup' in cfg.groups);
    const g = cfg.groups.mygroup;
    eq(g.label, 'My Group');
    eq(Object.keys(g.actions).length, 1);
    const a = g.actions.hello;
    eq(a.script, 'echo hello');
    eq(a.type, 'run');
    eq(a.confirm, null);
  });

  it('full_cmd', () => {
    const cfg = parseFixture('full_cmd.yml');
    eq(Object.keys(cfg.groups).length, 4);
    eq(Object.keys(cfg.groups).sort(), ['config', 'dev9-core', 'dev9-vpn', 'work']);

    const core = cfg.groups['dev9-core'];
    eq(Object.keys(core.actions).length, 7);
    eq(core.label, 'Core Services');
    eq(core.compose, 'docker-compose.yml');

    for (const a of Object.values(core.actions)) {
      assert(typeof a.script === 'string' && a.script.length > 0, `script populated: ${a.key}`);
    }
    const ssh = core.actions.ssh;
    eq(ssh.script, './do.sh dev9-core ssh');
    eq(ssh.type, 'spawn');
    eq(ssh.confirm, null);

    eq(core.actions.init.confirm, 'Initialize SSH keys + VPN server?');
  });

  it('with_vars resolves', () => {
    const cfg = parseFixture('with_vars.yml');
    const a = cfg.groups.test.actions.connect;
    assert(a.script.includes('client/id_ed25519'), 'KEY_FILE substituted');
    assert(a.script.includes('2222'), 'PORT substituted');
    eq(a.type, 'spawn');
    eq(a.debug.vars_used, { KEY_FILE: 'client/id_ed25519', PORT: '2222' });
  });

  it('with_helpers expands', () => {
    const cfg = parseFixture('with_helpers.yml');
    const a = cfg.groups.test.actions.init;
    assert(a.script.includes('ssh-keygen'), 'helper body inlined');
    assert(a.script.includes('echo "Done."'), 'tail preserved');
    eq(a.debug.helpers_used, ['init_ssh']);
    eq(a.confirm, 'Initialize?');
  });

  it('mixed cmd + script', () => {
    const cfg = parseFixture('mixed_cmd_script.yml');
    const svc = cfg.groups.svc;
    const up = svc.actions.up;
    eq(up.script, 'docker compose up -d');
    eq(up.debug.vars_used, {});
    eq(up.debug.helpers_used, []);

    const status = svc.actions.status;
    assert(status.script.includes('docker compose -f docker-compose.yml ps --format json'));
    assert(status.script.includes('echo "Done checking."'));
    eq(status.debug.helpers_used, ['check_ready']);
    eq(status.debug.vars_used, { COMPOSE_FILE: 'docker-compose.yml' });
  });
});

describe('defaults', () => {
  it('action.type defaults to run', () => {
    const cfg = parseFixture('minimal_cmd.yml');
    eq(cfg.groups.mygroup.actions.hello.type, 'run');
  });
  it('confirm absent → null', () => {
    eq(parseFixture('minimal_cmd.yml').groups.mygroup.actions.hello.confirm, null);
  });
  it('compose absent → null', () => {
    eq(parseFixture('full_cmd.yml').groups.config.compose, null);
  });
  it('compose present', () => {
    eq(parseFixture('full_cmd.yml').groups['dev9-core'].compose, 'docker-compose.yml');
  });
  it('containers populated', () => {
    const cfg = parseFixture('full_cmd.yml');
    assert(cfg.groups['dev9-core'].containers.includes('dev9-env'));
    eq(cfg.groups['dev9-core'].containers.length, 7);
  });
  it('containers empty', () => {
    eq(parseFixture('minimal_cmd.yml').groups.mygroup.containers, []);
  });
});

describe('debug info', () => {
  it('source_file + action_line + resolved_script populated', () => {
    const cfg = parseFixture('minimal_cmd.yml');
    const d = cfg.groups.mygroup.actions.hello.debug;
    assert(d.source_file.includes('minimal_cmd.yml'), `source: ${d.source_file}`);
    eq(d.action_line, -1);
    eq(d.resolved_script, 'echo hello');
  });
});

describe('project_dir', () => {
  it('absolute path', () => {
    const cfg = parseFixture('minimal_cmd.yml');
    assert(path.isAbsolute(cfg.project_dir), `absolute: ${cfg.project_dir}`);
  });
  it('relative to yaml file', () => {
    const p = tmpYaml(
      `project_dir: subdir
groups:
  g:
    label: G
    containers: []
    actions:
      a:
        cmd: echo
        label: A
`);
    const cfg = parse(p);
    const expected = path.resolve(path.dirname(p), 'subdir');
    eq(cfg.project_dir, expected);
  });
});

describe('groups preserve YAML order', () => {
  it('full_cmd', () => {
    const cfg = parseFixture('full_cmd.yml');
    eq(Object.keys(cfg.groups), ['dev9-core', 'dev9-vpn', 'work', 'config']);
  });
});

describe('nested groups (tree)', () => {
  it('flat dict keyed by dotted path, DFS pre-order', () => {
    const cfg = parseFixture('nested_groups.yml');
    eq(Object.keys(cfg.groups), [
      'root',
      'root.branch',
      'root.branch.leaf',
      'root.sibling-leaf',
    ]);
  });
  it('parent / depth / children metadata', () => {
    const cfg = parseFixture('nested_groups.yml');
    const root = cfg.groups.root;
    eq(root.parent, null); eq(root.depth, 0);
    eq(root.children, ['root.branch', 'root.sibling-leaf']);
    eq(root.actions, {});

    const branch = cfg.groups['root.branch'];
    eq(branch.parent, 'root'); eq(branch.depth, 1);
    eq(branch.children, ['root.branch.leaf']);

    const leaf = cfg.groups['root.branch.leaf'];
    eq(leaf.parent, 'root.branch'); eq(leaf.depth, 2);
    eq(leaf.children, []);
    eq(leaf.containers, ['cont-a']);
    eq(Object.keys(leaf.actions).sort(), ['bye', 'hi']);
  });
  it('action.group = full dotted path', () => {
    const cfg = parseFixture('nested_groups.yml');
    eq(cfg.groups['root.branch.leaf'].actions.hi.group, 'root.branch.leaf');
  });
});

describe('panel hotkeys', () => {
  // v0.6.1 — pool entries declared once at the top in `panels:`;
  // layout cells reference them via bare-string shorthand (single-tab
  // pane) or `{tabs: [pool-id, ...], hotkey?}` mapping.
  const POOL_BLOCK = `panels:
  containers: { type: containers, title: C }
  groups:     { type: groups,     title: G }
  actions:    { type: actions,    title: A }
  stats:      { type: stats,      title: S }
  detail:     { type: detail,     title: D }
`;
  it('positional defaults (first col 1-6, last col 7-9)', () => {
    const p = tmpYaml(
      `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
${POOL_BLOCK}layout:
  columns:
    - panels:
        - containers
        - groups
    - panels:
        - actions
        - stats
        - detail
`);
    const cfg = parse(p);
    eq(cfg.layout.columns[0].panels.map(pp => [pp.hotkey, pp.type]),  [['1','containers'], ['2','groups']]);
    eq(cfg.layout.columns[1].panels.map(pp => [pp.hotkey, pp.type]), [['7','actions'], ['8','stats'], ['9','detail']]);
  });
  it('duplicate explicit hotkey WITHIN a column throws', () => {
    const p = tmpYaml(
      `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
${POOL_BLOCK}layout:
  columns:
    - panels:
        - { tabs: [groups],     hotkey: '1' }
        - { tabs: [containers], hotkey: '1' }
    - panels:
        - actions
        - detail
`);
    expectThrow(/declares hotkey '1' twice/, () => parse(p));
  });
  it('explicit hotkey collision ACROSS columns throws', () => {
    const p = tmpYaml(
      `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
${POOL_BLOCK}layout:
  columns:
    - panels:
        - { tabs: [groups], hotkey: '7' }
    - panels:
        - { tabs: [actions], hotkey: '7' }
        - detail
`);
    expectThrow(/hotkey '7' claimed by both/, () => parse(p));
  });
  it('explicit override wins, others skip claimed keys', () => {
    const p = tmpYaml(
      `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
${POOL_BLOCK}layout:
  columns:
    - panels:
        - { tabs: [groups], hotkey: g }
    - panels:
        - actions
        - { tabs: [detail], hotkey: o }
`);
    const cfg = parse(p);
    eq(cfg.layout.columns[0].panels[0].hotkey, 'g');
    eq(cfg.layout.columns[1].panels.map(pp => [pp.hotkey, pp.type]),
       [['7','actions'], ['o','detail']]);
  });
});

describe('layout invariants — detail / actions placement', () => {
  // v0.6.1 — invariants restated at the tab level. With one tab per
  // pane (these tests) the assertion strings shift slightly: "tab of
  // kind 'detail'" replaces "'detail' panel".
  const POOL_BLOCK = `panels:
  containers: { type: containers, title: C }
  groups:     { type: groups,     title: G }
  actions:    { type: actions,    title: A }
  detail:     { type: detail,     title: D }
`;
  it('detail outside the last column is rejected', () => {
    const p = tmpYaml(
      `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
${POOL_BLOCK}layout:
  columns:
    - panels:
        - detail
        - groups
    - panels:
        - actions
`);
    expectThrow(/'detail' must be in the last column/, () => parse(p));
  });
  it('detail not as the last cell in the last column is rejected', () => {
    const p = tmpYaml(
      `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
${POOL_BLOCK}layout:
  columns:
    - panels:
        - groups
    - panels:
        - detail
        - actions
`);
    expectThrow(/'detail' must be in the last pane of the last column/, () => parse(p));
  });
  it('actions outside the last column is rejected', () => {
    const p = tmpYaml(
      `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
${POOL_BLOCK}layout:
  columns:
    - panels:
        - actions
        - groups
    - panels:
        - detail
`);
    expectThrow(/'actions' must be in the last column/, () => parse(p));
  });

  it('duplicate pool-id refs across cells are rejected (T1.4)', () => {
    // Two cells reference `groups` — one in col 0, one again in col 0.
    // Old parser accepted this and produced two distinct panes wrapping
    // the same pool entry; new parser refuses.
    const p = tmpYaml(
      `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
${POOL_BLOCK}layout:
  columns:
    - panels:
        - groups
        - groups
        - actions
    - panels:
        - detail
`);
    expectThrow(/panel id 'groups' placed in two cells/, () => parse(p));
  });

  it('duplicate pool-id across columns is rejected (T1.4)', () => {
    const p = tmpYaml(
      `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
${POOL_BLOCK}layout:
  columns:
    - panels:
        - groups
    - panels:
        - groups
        - actions
        - detail
`);
    expectThrow(/panel id 'groups' placed in two cells/, () => parse(p));
  });
});

describe('user pool merges into the default layout when `layout:` block is absent', () => {
  // Regression: a top-level `panels:` block without a `layout:` block
  // used to silently drop every user-declared entry — defaultLayout()
  // was called without userPool. Now the user entries land in the
  // pool as hidden (available via the `w` overlay).
  it('user pool entries survive as hidden pool entries', () => {
    const p = tmpYaml(
      `panels:
  notes:
    type: history
    title: Notes
groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
`);
    const cfg = parse(p);
    assert(cfg.layout.pool.notes, 'user pool entry survived');
    eq(cfg.layout.pool.notes.type, 'history');
    eq(cfg.layout.pool.notes.title, 'Notes');
    // Not placed in any column — it's hidden.
    const placed = (cfg.layout.columns || []).flatMap(c => c.panels || []);
    assert(!placed.some(pp => pp.id === 'notes'), 'not placed in any column');
  });
  it('default entries still populate the pool', () => {
    const p = tmpYaml(
      `panels:
  notes:
    type: history
groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
`);
    const cfg = parse(p);
    assert(cfg.layout.pool.groups,  'default groups entry present');
    assert(cfg.layout.pool.actions, 'default actions entry present');
    assert(cfg.layout.pool.detail,  'default detail entry present');
    assert(cfg.layout.pool.notes,   'user notes entry present');
  });
});

describe('quick: bool flag', () => {
  it('defaults false, true round-trips', () => {
    const p = tmpYaml(
      `groups:
  pinned:
    label: Pinned
    quick: true
    actions:
      a: { cmd: 'echo', label: A }
  unpinned:
    label: Unpinned
    actions:
      b: { cmd: 'echo', label: B }
`);
    const cfg = parse(p);
    eq(cfg.groups.pinned.quick, true);
    eq(cfg.groups.unpinned.quick, false);
  });
});

describe('error propagation', () => {
  it('invalid yaml syntax → ParseError', () => {
    const p = tmpYaml('groups:\n  - bad: [unclosed');
    expectThrow(/.+/, () => parse(p));
  });
  it('file not found → ParseError', () => {
    expectThrow(/not found/, () => parse('/nonexistent/path.yml'));
  });
  it('empty file → ParseError', () => {
    const p = tmpYaml('');
    expectThrow(/empty/, () => parse(p));
  });
  it("missing 'groups' → SchemaError", () => {
    const p = tmpYaml('project_dir: .\n');
    expectThrow(/'groups' is required/, () => parse(p), SchemaError);
  });
  it('undefined helper → ResolutionError', () => {
    const p = tmpYaml(
      `groups:
  g:
    label: G
    containers: []
    actions:
      a:
        label: A
        script: |
          @use nonexistent
`);
    expectThrow(/undefined helper/, () => parse(p), ResolutionError);
  });
});

describe('args / default_cmd round-trip', () => {
  it('args present', () => {
    const p = tmpYaml(
      `groups:
  g:
    label: G
    containers: []
    actions:
      gen:
        label: Generate
        args: client-name
        script: |
          echo $1
`);
    eq(parse(p).groups.g.actions.gen.args, 'client-name');
  });
  it('args absent → null', () => {
    const p = tmpYaml(
      `groups:
  g:
    label: G
    containers: []
    actions:
      up: { cmd: echo up, label: Up }
`);
    eq(parse(p).groups.g.actions.up.args, null);
  });
  it('default_cmd carried alongside args', () => {
    const p = tmpYaml(
      `groups:
  g:
    label: G
    containers: []
    actions:
      ping:
        label: Ping
        args: '[host]'
        default_cmd: 'echo example.com'
        script: 'echo $1'
`);
    const a = parse(p).groups.g.actions.ping;
    eq(a.default_cmd, 'echo example.com');
    eq(a.args, '[host]');
  });
  it('default_cmd absent → null', () => {
    const p = tmpYaml(
      `groups:
  g:
    label: G
    containers: []
    actions:
      up: { cmd: echo up, label: Up }
`);
    eq(parse(p).groups.g.actions.up.default_cmd, null);
  });
});

describe('extensible group keys pass through to the parsed group (T6)', () => {
  it('a plugin-introduced group key lands verbatim on the parsed group', () => {
    const p = tmpYaml(`
groups:
  g:
    label: G
    kubernetes: { namespace: prod, replicas: 3 }
    actions:
      a: { cmd: 'echo a', label: A }
`);
    const cfg = parse(p);
    assert(cfg.groups.g.kubernetes, 'unknown group key preserved');
    eq(cfg.groups.g.kubernetes.namespace, 'prod');
    eq(cfg.groups.g.kubernetes.replicas, 3);
  });
  it('passthrough never clobbers framework-transformed keys (children → childPaths)', () => {
    const p = tmpYaml(`
groups:
  parent:
    label: P
    children:
      kid: { label: K, actions: { a: { cmd: 'echo', label: A } } }
`);
    const cfg = parse(p);
    // children must remain the transformed childPaths array, not the raw map.
    assert(Array.isArray(cfg.groups.parent.children), 'children stays an array of paths');
    eq(cfg.groups.parent.children[0], 'parent.kid');
  });
});

report();
