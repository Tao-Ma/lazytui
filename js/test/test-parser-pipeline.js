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
    // The bug: parse() returned {project_dir, groups, source_file,
    // files, layout, theme} with no `plugins` field, so loadPlugins
    // received undefined and JS plugins (`path: ./foo.js`) silently
    // never loaded. Demos with custom panel types (e.g. ssh-fleet's
    // `hosts:` panel) then rendered as empty strings, the right
    // column's rows spilled into column 0 of the bottom of the
    // screen, and the user saw "left bottom occupied by detail".
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
    // Callers (loadPlugins, etc.) treat undefined as "skip" and {} as
    // "iterate zero times" — same effect, but {} is the kinder
    // contract: lets callers Object.keys() / Object.entries() without
    // guarding.
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
  it('positional defaults (left 1-6, right 7-9)', () => {
    const p = tmpYaml(
      `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
layout:
  left:
    panels:
      - { type: containers, title: C }
      - { type: groups, title: G }
  right:
    panels:
      - { type: actions, title: A }
      - { type: stats, title: S }
      - { type: detail, title: D }
`);
    const cfg = parse(p);
    eq(cfg.layout.left_panels.map(pp => [pp.hotkey, pp.type]),  [['1','containers'], ['2','groups']]);
    eq(cfg.layout.right_panels.map(pp => [pp.hotkey, pp.type]), [['7','actions'], ['8','stats'], ['9','detail']]);
  });
  it('explicit override wins, others skip claimed keys', () => {
    const p = tmpYaml(
      `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
layout:
  left:
    panels:
      - { type: groups, title: G, hotkey: g }
  right:
    panels:
      - { type: actions, title: A }
      - { type: detail, title: D, hotkey: o }
`);
    const cfg = parse(p);
    eq(cfg.layout.left_panels[0].hotkey, 'g');
    eq(cfg.layout.right_panels.map(pp => [pp.hotkey, pp.type]),
       [['7','actions'], ['o','detail']]);
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
