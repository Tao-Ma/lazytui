/**
 * Global user config (~/.config/lazytui/config.yml, docs/global-config) —
 * path resolution, tolerant load, the app-behavior allowlist, the merge
 * rules (entry-level for keyed sections, wholesale project-wins for
 * scalars), and the end-to-end layer through parse() and loadConfig().
 *
 * Also pins the `selection:` pass-through fix: the key validated but was
 * DROPPED by parse() until this arc, so `selection: false` did nothing.
 *
 * Run: node js/test/test-global-config.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const g = require('../parser/global');
const { parse } = require('../parser');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-global-'));
const write = (name, text) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, text);
  return p;
};
const MINIMAL = path.join(__dirname, 'fixtures', 'minimal_cmd.yml');

describe('[global] path resolution', () => {
  it('LAZYTUI_GLOBAL_CONFIG overrides; empty string disables', () => {
    eq(g.globalConfigPath({ LAZYTUI_GLOBAL_CONFIG: '/x/y.yml' }), path.resolve('/x/y.yml'));
    eq(g.globalConfigPath({ LAZYTUI_GLOBAL_CONFIG: '' }), null, 'empty disables');
  });
  it('XDG_CONFIG_HOME wins over the homedir default', () => {
    eq(g.globalConfigPath({ XDG_CONFIG_HOME: '/xdg' }), path.join('/xdg', 'lazytui', 'config.yml'));
    eq(g.globalConfigPath({}), path.join(os.homedir(), '.config', 'lazytui', 'config.yml'));
  });
});

describe('[global] tolerant load', () => {
  it('missing file → null config, no warnings', () => {
    const r = g.loadGlobal({ LAZYTUI_GLOBAL_CONFIG: path.join(TMP, 'nope.yml') });
    eq(r.config, null); eq(r.warnings, []);
  });
  it('empty file → null config, no warnings', () => {
    const p = write('empty.yml', '');
    const r = g.loadGlobal({ LAZYTUI_GLOBAL_CONFIG: p });
    eq(r.config, null); eq(r.warnings, []);
  });
  it('broken YAML → null + global.unreadable warning (never throws)', () => {
    const p = write('broken.yml', 'theme: [unclosed');
    const r = g.loadGlobal({ LAZYTUI_GLOBAL_CONFIG: p });
    eq(r.config, null);
    eq(r.warnings.length, 1);
    eq(r.warnings[0].code, 'global.unreadable');
  });
  it('malformed honored section → null + global.invalid warning', () => {
    const p = write('badsection.yml', 'editor: 42\n');
    const r = g.loadGlobal({ LAZYTUI_GLOBAL_CONFIG: p });
    eq(r.config, null);
    eq(r.warnings[0].code, 'global.invalid');
    assert(/'editor' must be a non-empty string/.test(r.warnings[0].message), r.warnings[0].message);
  });
  it('project keys warn per key and are dropped; honored sections survive', () => {
    const p = write('mixed.yml', [
      'theme: nord',
      'groups: { x: { label: X } }',
      'layout: { columns: [] }',
      'editor: nvim',
    ].join('\n') + '\n');
    const r = g.loadGlobal({ LAZYTUI_GLOBAL_CONFIG: p });
    eq(r.config, { theme: 'nord', editor: 'nvim' });
    eq(r.warnings.map((w) => w.code), ['global.ignored_key', 'global.ignored_key']);
    assert(/'groups' is not a global section/.test(r.warnings[0].message), r.warnings[0].message);
  });
});

describe('[global] merge rules (raw shapes)', () => {
  it('keys/mouse merge at the entry level — a project rebind wins per key', () => {
    const merged = g.mergeGlobal(
      { keys: { a: { builtin: 'proj' } }, mouse: { 'right-click': 'activate' } },
      { keys: { a: { builtin: 'glob' }, b: { builtin: 'glob-only' } },
        mouse: { 'right-click': 'context', 'middle-click': 'context' } });
    eq(merged.keys, { a: { builtin: 'proj' }, b: { builtin: 'glob-only' } });
    eq(merged.mouse, { 'right-click': 'activate', 'middle-click': 'context' });
  });
  it('keymap.normal merges per key; version is project-wins', () => {
    const merged = g.mergeGlobal(
      { keymap: { version: 2, normal: { q: 'quit' } } },
      { keymap: { version: 1, normal: { q: 'noop', r: 'refresh' } } });
    eq(merged.keymap, { version: 2, normal: { q: 'quit', r: 'refresh' } });
    const globOnly = g.mergeGlobal({}, { keymap: { version: 1, normal: { r: 'refresh' } } });
    eq(globOnly.keymap, { version: 1, normal: { r: 'refresh' } });
  });
  it('context-menu concatenates: global entries first', () => {
    const merged = g.mergeGlobal(
      { 'context-menu': [{ label: 'P', builtin: 'refresh' }] },
      { 'context-menu': [{ label: 'G', builtin: 'refresh' }] });
    eq(merged['context-menu'].map((e) => e.label), ['G', 'P']);
  });
  it('theme/selection/editor are wholesale, project-wins', () => {
    const merged = g.mergeGlobal(
      { theme: 'proj', selection: true },
      { theme: 'glob', selection: false, editor: 'nvim' });
    eq(merged.theme, 'proj');
    eq(merged.selection, true);
    eq(merged.editor, 'nvim', 'absent in project → global applies');
  });
  it('null global is a pass-through', () => {
    const proj = { theme: 'x' };
    assert(g.mergeGlobal(proj, null) === proj);
  });
});

describe('[global] through parse() — defaulting applies to the MERGED result', () => {
  it('global theme lands when the project sets none; project theme wins otherwise', () => {
    const out = parse(MINIMAL, { global: { theme: 'nord' } });
    eq(out.theme, 'nord');
    const themed = write('themed.yml',
      fs.readFileSync(MINIMAL, 'utf8') + '\ntheme: monokai\n');
    eq(parse(themed, { global: { theme: 'nord' } }).theme, 'monokai');
  });
  it('global selection:false + editor land on the parsed output', () => {
    const out = parse(MINIMAL, { global: { selection: false, editor: 'code --wait' } });
    eq(out.selection, false);
    eq(out.editor, 'code --wait');
  });
  it('global keymap.normal merges under a project keymap', () => {
    const proj = write('km.yml',
      fs.readFileSync(MINIMAL, 'utf8') + '\nkeymap:\n  normal:\n    q: quit\n');
    const out = parse(proj, { global: { keymap: { normal: { q: 'noop', G: 'cursor_bottom' } } } });
    eq(out.keymap.normal, { q: 'quit', G: 'cursor_bottom' });
  });
});

describe('[parse] selection/editor pass-through (the pre-existing drop)', () => {
  it('selection: false survives parse; absent defaults true', () => {
    const p = write('sel.yml', fs.readFileSync(MINIMAL, 'utf8') + '\nselection: false\n');
    eq(parse(p).selection, false, 'was silently dropped pre-arc');
    eq(parse(MINIMAL).selection, true);
  });
  it('editor: passes through; absent defaults null; non-string rejects', () => {
    const p = write('ed.yml', fs.readFileSync(MINIMAL, 'utf8') + '\neditor: nvim\n');
    eq(parse(p).editor, 'nvim');
    eq(parse(MINIMAL).editor, null);
    const bad = write('edbad.yml', fs.readFileSync(MINIMAL, 'utf8') + '\neditor: 42\n');
    let threw = false;
    try { parse(bad); } catch (e) { threw = /'editor' must be a non-empty string/.test(e.message); }
    assert(threw, 'non-string editor rejects at parse');
  });
});

describe('[boot] loadConfig layers the global file (real seam)', () => {
  it('set_config carries the merged config + global warnings', () => {
    const globPath = write('boot-global.yml', [
      'theme: nord',
      'editor: nvim',
      'groups: { x: { label: X } }',   // ignored + warned
    ].join('\n') + '\n');
    const prev = process.env.LAZYTUI_GLOBAL_CONFIG;
    process.env.LAZYTUI_GLOBAL_CONFIG = globPath;
    try {
      require('../app/state').loadConfig(MINIMAL);
    } finally {
      process.env.LAZYTUI_GLOBAL_CONFIG = prev;
    }
    const m = require('../app/runtime').getModel();
    eq(m.config.theme, 'nord', 'global theme applied through the real boot seam');
    eq(m.config.editor, 'nvim');
    assert(m.config.warnings.some((w) => w.code === 'global.ignored_key'),
      'the ignored-key warning rides config.warnings');
    eq(m.configPath, path.resolve(MINIMAL));
  });
});

report();
