/**
 * YAML `keys:` reader — schema validation, parser threading, and the
 * dispatch.loadKeyBindings registration (builtin / action / command).
 *
 * Run: node js/test/test-keys-yaml.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { describe, it, eq, assert, report } = require('./test-runner');
const { validate } = require('../parser/schema');
const { parse } = require('../parser');

// Minimal valid base config; vary `keys` on top.
function base(extra) {
  return Object.assign({
    groups: { g: { label: 'G', actions: { build: { cmd: 'true', label: 'Build' } } } },
  }, extra);
}

// ---- [1] schema.validateKeys --------------------------------------

describe('[1] keys schema', () => {
  it('accepts action / command / builtin entries', () => {
    validate(base({ keys: {
      '<leader>b':  { action: 'build' },
      '<leader>L':  { command: 'logs' },
      '<leader>gg': { builtin: 'goto_top', label: 'top' },
    }}), 'test');
  });
  it('rejects a binding with no verb', () => {
    let t = false;
    try { validate(base({ keys: { '<leader>x': { label: 'noop' } } }), 'test'); } catch { t = true; }
    assert(t, 'missing action/command/builtin throws');
  });
  it('rejects conflicting verbs', () => {
    let t = false;
    try { validate(base({ keys: { '<leader>x': { action: 'a', builtin: 'b' } } }), 'test'); } catch { t = true; }
    assert(t, 'two verbs throws');
  });
  it('rejects a non-string verb value', () => {
    let t = false;
    try { validate(base({ keys: { '<leader>x': { action: 5 } } }), 'test'); } catch { t = true; }
    assert(t);
  });
  it('rejects unknown keys in a binding', () => {
    let t = false;
    try { validate(base({ keys: { '<leader>x': { builtin: 'refresh', bogus: 1 } } }), 'test'); } catch { t = true; }
    assert(t);
  });
  it('rejects a non-mapping keys block', () => {
    let t = false;
    try { validate(base({ keys: ['nope'] }), 'test'); } catch { t = true; }
    assert(t);
  });
});

// ---- [2] parser threads keys through ------------------------------

describe('[2] parser', () => {
  it('passes the keys block onto the parsed config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-keys-'));
    const file = path.join(dir, 'tui.yml');
    fs.writeFileSync(file, [
      'project_dir: .',
      'groups:',
      '  g:',
      '    label: G',
      '    actions:',
      '      build: { cmd: "true", label: Build }',
      'keys:',
      '  "<leader>b": { action: build }',
      '  "<leader>r": { builtin: refresh }',
      '',
    ].join('\n'));
    try {
      const cfg = parse(file);
      assert(cfg.keys && cfg.keys['<leader>b'], 'keys present on config');
      eq(cfg.keys['<leader>b'].action, 'build');
      eq(cfg.keys['<leader>r'].builtin, 'refresh');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('defaults keys to {} when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-keys-'));
    const file = path.join(dir, 'tui.yml');
    fs.writeFileSync(file, 'groups:\n  g:\n    label: G\n    actions:\n      x: { cmd: "true", label: X }\n');
    try {
      const cfg = parse(file);
      eq(Object.keys(cfg.keys).length, 0, 'empty keys default');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- [3] dispatch.loadKeyBindings ---------------------------------

const { S } = require('../state');
const kb = require('../keybindings');
const api = require('../plugins/api');
const dispatch = require('../dispatch');

// A stub plugin command so the {command:…} path resolves without UI.
let cmdRan = null;
api.registerPlugin({
  name: 'keys-yaml-test',
  commands: [{ name: 'stubcmd', desc: 'test', run: (args) => { cmdRan = args || []; } }],
});

describe('[3] loadKeyBindings', () => {
  it('registers builtin / action / command bindings into the tree', () => {
    kb.clearBindings();
    S.config = {
      groups: { g: { actions: { build: { key: 'build', label: 'Build', script: 'true', containers: [], type: 'run' } } } },
      keys: {
        '<leader>h':  { builtin: 'show_help', label: 'help' },
        '<leader>b':  { action: 'build' },
        '<leader>cc': { command: 'stubcmd one two', label: 'stub' },
      },
    };
    dispatch.loadKeyBindings(S.config);

    const h = kb.resolve(kb.rootNode(), 'h');
    eq(h && h.label, 'help', 'builtin binding registered with label');
    const b = kb.resolve(kb.rootNode(), 'b');
    eq(b && b.label, 'build', 'action binding falls back to action name label');
    const c0 = kb.resolve(kb.rootNode(), 'c');
    assert(c0 && c0.children, 'nested command binding builds a subtree');
    eq(c0.children.c.label, 'stub');
  });

  it('command binding run() resolves + executes with args', () => {
    cmdRan = null;
    const leaf = kb.resolve(kb.resolve(kb.rootNode(), 'c'), 'c');
    leaf.run();
    assert(Array.isArray(cmdRan), 'stub command ran');
    eq(cmdRan.join(','), 'one,two', 'args forwarded to the command');
  });

  it('a bad binding sequence surfaces as a thrown conflict', () => {
    kb.clearBindings();
    let threw = false;
    try {
      dispatch.loadKeyBindings({ keys: {
        'a':  { builtin: 'refresh' },
        'ab': { builtin: 'refresh' },   // runs through the 'a' leaf
      }});
    } catch { threw = true; }
    assert(threw, 'conflicting sequences throw at load');
  });
});

// ---- [4] command binding resolves by EXACT name only --------------

const { runCommandString } = require('../cmdline');

describe('[4] runCommandString exact match', () => {
  it('runs the exact-named command with args', () => {
    cmdRan = null;
    const r = runCommandString('stubcmd a b', S);
    assert(Array.isArray(cmdRan), 'exact match ran');
    eq(cmdRan.join(','), 'a,b');
    assert(r !== false, 'returns the command result');
  });
  it('does NOT prefix-match a near-miss (typo) onto another command', () => {
    cmdRan = null;
    // "stub" is a prefix of "stubcmd" but not an exact name → no run.
    const r = runCommandString('stub', S);
    eq(r, false, 'no exact match → false');
    eq(cmdRan, null, 'the prefix-sharing command did NOT fire');
  });
});

// ---- [5] action binding with args: routes through the prompt ------

const dispatch2 = require('../dispatch');

describe('[5] action binding honors args:', () => {
  it('an action with args: opens the prompt instead of running argless', () => {
    kb.clearBindings();
    S.config = {
      groups: { g: { actions: {
        deploy: { key: 'deploy', label: 'Deploy', script: 'echo', containers: [], type: 'run', args: ['env'] },
      } } },
      keys: { '<leader>d': { action: 'deploy' } },
    };
    // Reset prompt/confirm so we can observe the prompt opening.
    S.promptMode = false; S.confirmMode = false;
    dispatch2.loadKeyBindings(S.config);
    const leaf = kb.resolve(kb.rootNode(), 'd');
    assert(leaf && typeof leaf.run === 'function', 'binding registered');
    leaf.run();
    assert(S.promptMode === true, 'args: action opened the prompt rather than running with empty args');
    // Clean up prompt mode so we don't leak into other files.
    S.promptMode = false;
  });
});

// ---- [6] leader resolves PLUGIN-synthesized actions (not just YAML) ----

describe('[6] action binding finds plugin-synthesized actions', () => {
  it('resolves an action contributed by a plugin groupActions hook', () => {
    // A plugin contributes `deploy` to group g; group g declares NO
    // actions of its own. The old _runActionByKey searched only
    // g.actions and would miss this; the fix merges getGroupActions.
    api.registerPlugin({
      name: 'kb-groupactions-test',
      groupActions: (group, groupName) => groupName === 'g'
        ? { deploy: { key: 'deploy', label: 'Deploy', script: 'echo', containers: [], type: 'run', args: ['env'] } }
        : {},
    });
    kb.clearBindings();
    S.config = {
      groups: { g: { label: 'G' } },          // no `actions:` here — only the plugin's
      keys: { '<leader>x': { action: 'deploy' } },
    };
    S.promptMode = false; S.confirmMode = false;
    dispatch2.loadKeyBindings(S.config);
    const leaf = kb.resolve(kb.rootNode(), 'x');
    assert(leaf && typeof leaf.run === 'function', 'binding registered');
    leaf.run();
    assert(S.promptMode === true, 'plugin-synthesized action resolved + opened its args prompt');
    S.promptMode = false;
  });
});

report();
