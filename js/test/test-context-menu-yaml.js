/**
 * YAML `context-menu:` reader — schema validation, parser threading, and the
 * dispatch.loadContextMenu install (builtin / action / command + `pane:`).
 * The pointer/builder side (rows, verb mapping, pane gate) lives in
 * test-context-menu.js; this pins the config edge.
 *
 * Run: node js/test/test-context-menu-yaml.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { describe, it, eq, assert, report } = require('./test-runner');
const { validate } = require('../parser/schema');
const { parse } = require('../parser');
const cm = require('../leaves/input/context-menu');

// Minimal valid base config; vary `context-menu` on top.
function base(extra) {
  return Object.assign({
    groups: { g: { label: 'G', actions: { build: { cmd: 'true', label: 'Build' } } } },
  }, extra);
}
const reject = (cfg) => { try { validate(cfg, 'test'); return false; } catch { return true; } };

// ---- [1] schema.validateContextMenu -------------------------------

describe('[1] context-menu schema', () => {
  it('accepts action / command / builtin entries + a pane gate', () => {
    validate(base({ 'context-menu': [
      { label: 'Build',  action: 'build' },
      { label: 'Logs',   command: 'logs' },
      { label: 'Help',   builtin: 'show_help' },
      { label: 'Pruned', builtin: 'refresh', pane: 'docker' },
      { label: 'Multi',  builtin: 'refresh', pane: ['groups', 'detail'] },
    ]}), 'test');
  });
  it('rejects a non-list block', () => {
    assert(reject(base({ 'context-menu': { label: 'x', builtin: 'refresh' } })), 'mapping (not list) throws');
  });
  it('rejects an entry with no verb', () => {
    assert(reject(base({ 'context-menu': [{ label: 'x' }] })), 'missing action/command/builtin throws');
  });
  it('rejects conflicting verbs', () => {
    assert(reject(base({ 'context-menu': [{ label: 'x', action: 'a', builtin: 'b' }] })), 'two verbs throws');
  });
  it('rejects a missing / empty label', () => {
    assert(reject(base({ 'context-menu': [{ builtin: 'refresh' }] })), 'no label throws');
    assert(reject(base({ 'context-menu': [{ label: '  ', builtin: 'refresh' }] })), 'blank label throws');
  });
  it('rejects an unknown key in an entry', () => {
    assert(reject(base({ 'context-menu': [{ label: 'x', builtin: 'refresh', bogus: 1 }] })), 'unknown key throws');
  });
  it('rejects a bad `pane:` (empty string / non-string list)', () => {
    assert(reject(base({ 'context-menu': [{ label: 'x', builtin: 'refresh', pane: '' }] })), 'empty pane throws');
    assert(reject(base({ 'context-menu': [{ label: 'x', builtin: 'refresh', pane: [1] }] })), 'non-string list throws');
  });
});

// ---- [2] parser threads context-menu through ---------------------

describe('[2] parser', () => {
  it('passes the context-menu block onto the parsed config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-ctxmenu-'));
    const file = path.join(dir, 'tui.yml');
    fs.writeFileSync(file, [
      'project_dir: .',
      'groups:',
      '  g:',
      '    label: G',
      '    actions:',
      '      build: { cmd: "true", label: Build }',
      'context-menu:',
      '  - { label: Build, action: build }',
      '  - { label: Logs,  command: logs, pane: detail }',
      '',
    ].join('\n'));
    try {
      const cfg = parse(file);
      const cm2 = cfg['context-menu'];
      assert(Array.isArray(cm2) && cm2.length === 2, 'context-menu present as a list');
      eq(cm2[0].action, 'build');
      eq(cm2[1].command, 'logs');
      eq(cm2[1].pane, 'detail');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('defaults context-menu to [] when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-ctxmenu-'));
    const file = path.join(dir, 'tui.yml');
    fs.writeFileSync(file, 'groups:\n  g:\n    label: G\n    actions:\n      x: { cmd: "true", label: X }\n');
    try {
      const cfg = parse(file);
      assert(Array.isArray(cfg['context-menu']) && cfg['context-menu'].length === 0, 'empty default');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- [3] dispatch.loadContextMenu ---------------------------------

const dispatch = require('../dispatch/control/dispatch');
const { getModel } = require('../app/runtime');

describe('[3] loadContextMenu', () => {
  it('installs the entries into the registry (appear in built rows)', () => {
    // _collectActionKeys reads the GLOBAL model config (same as
    // loadKeyBindings), so seed it for the resolve check to find 'build'.
    getModel().config = {
      groups: { g: { actions: { build: { key: 'build', label: 'Build', script: 'true', containers: [], type: 'run' } } } },
      'context-menu': [{ label: 'Do Build', action: 'build' }],
    };
    const real = console.error;
    const warns = [];
    console.error = (m) => warns.push(m);
    try {
      dispatch.loadContextMenu(getModel().config);
      const items = cm.buildContextItems({});
      const row = items.find(r => r && r[0] === 'Do Build');
      assert(row, 'config entry installed + built');
      eq(row[1], 'ctx_run_action', 'routed as ctx_run_action');
      eq(row[2], 'build', 'with the action key');
      assert(!warns.length, 'a resolvable action key does NOT warn');
    } finally { console.error = real; cm.reset(); }
  });

  it('warns (does not throw) on an `action:` whose short key is unknown', () => {
    const real = console.error;
    const warns = [];
    console.error = (m) => warns.push(m);
    try {
      dispatch.loadContextMenu({
        groups: { g: { label: 'G' } },
        'context-menu': [{ label: 'Ghost', action: 'nonexistent' }],
      });
    } finally { console.error = real; cm.reset(); }
    assert(warns.some(w => /nonexistent/.test(w)), 'unresolved action key warned');
  });

  it('absent / empty block installs nothing (built-ins only)', () => {
    dispatch.loadContextMenu({ groups: {} });
    const labels = cm.buildContextItems({}).map(r => r && r[0]);
    assert(labels.includes('Refresh') && labels.includes('Help'), 'built-ins remain');
    cm.reset();
  });
});

report();
