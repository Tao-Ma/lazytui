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
    eq(r.config.theme, 'nord');
    eq(r.config.editor, 'nvim');
    eq(Object.keys(r.config).length, 2, 'project keys dropped');
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
  it('a MALFORMED project section still rejects when the global defines it too', () => {
    // Pre-fix (v0.6.12 review MED): the merge ran before validation, so a
    // global keymap MASKED a project keymap typo (binding silently vanished)
    // and a non-mapping project section crashed with a raw TypeError instead
    // of the composed SchemaError. Project errors must surface unchanged.
    const typo = write('km-typo.yml',
      fs.readFileSync(MINIMAL, 'utf8') + '\nkeymap:\n  normall:\n    q: quit\n');
    let msg = '';
    try { parse(typo, { global: { keymap: { normal: { G: 'cursor_bottom' } } } }); }
    catch (e) { msg = e.message; }
    assert(/unknown key\(s\): normall/.test(msg), `typo must reject: ${msg}`);
    const nonMap = write('km-nonmap.yml',
      fs.readFileSync(MINIMAL, 'utf8') + '\nkeymap: nonsense\n');
    msg = '';
    try { parse(nonMap, { global: { keymap: { normal: { G: 'cursor_bottom' } } } }); }
    catch (e) { msg = e.message; }
    assert(/'keymap' must be a mapping/.test(msg), `non-mapping must reject cleanly: ${msg}`);
    const badMouse = write('mouse-bad.yml',
      fs.readFileSync(MINIMAL, 'utf8') + '\nmouse: true\n');
    msg = '';
    try { parse(badMouse, { global: { mouse: { 'right-click': 'context' } } }); }
    catch (e) { msg = e.message; }
    assert(/'mouse' must be a mapping/.test(msg), `bad mouse must reject: ${msg}`);
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

describe('[json] resolved-shape configs — keyed sections layer, editor null counts as unset', () => {
  it('a global editor lands through the .json path; explicit theme stays', () => {
    // v0.6.12 review MED: parse-output JSON always stamps theme/selection/
    // editor, so wholesale-if-absent never fired — the stamped `editor: null`
    // blocked a global editor. null now counts as unset for scalars.
    const resolved = parse(MINIMAL);   // the canonical resolved shape
    const jsonPath = write('resolved.json', JSON.stringify(resolved));
    const globPath = write('json-global.yml', 'editor: nvim\ntheme: nord\nkeymap:\n  normal:\n    G: cursor_bottom\n');
    const prev = process.env.LAZYTUI_GLOBAL_CONFIG;
    process.env.LAZYTUI_GLOBAL_CONFIG = globPath;
    try { require('../app/state').loadConfig(jsonPath); }
    finally { process.env.LAZYTUI_GLOBAL_CONFIG = prev; }
    const cfg = require('../app/runtime').getModel().config;
    eq(cfg.editor, 'nvim', 'stamped null no longer blocks the global editor');
    eq(cfg.theme, resolved.theme, 'explicit resolved theme stays (documented JSON caveat)');
    eq(cfg.keymap.normal.G, 'cursor_bottom', 'keyed sections layer as usual');
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

describe('[global] quick_keys — global-only item-action placement', () => {
  it('valid values load; an invalid one drops the whole global with a warning (never-brick)', () => {
    const ok = g.loadGlobal({ LAZYTUI_GLOBAL_CONFIG: write('qk-ok.yml', 'quick_keys: footer\n') });
    eq(ok.config.quick_keys, 'footer');
    const off = g.loadGlobal({ LAZYTUI_GLOBAL_CONFIG: write('qk-off.yml', 'quick_keys: off\n') });
    eq(off.config.quick_keys, 'off');
    const bad = g.loadGlobal({ LAZYTUI_GLOBAL_CONFIG: write('qk-bad.yml', 'quick_keys: sidebar\n') });
    eq(bad.config, null, 'invalid value → global dropped (project-only)');
    assert(bad.warnings.some(w => /quick_keys/.test(w.message)), 'warns about quick_keys');
  });
  it('mergeGlobal lifts it onto the config (global-only — project never carries it)', () => {
    eq(g.mergeGlobal({ theme: 'x' }, { quick_keys: 'off' }).quick_keys, 'off');
    eq(g.mergeGlobal({}, { quick_keys: 'border' }).quick_keys, 'border');
  });
});

report();
