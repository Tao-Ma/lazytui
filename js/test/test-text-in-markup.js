/**
 * Text that is NOT markup — a config title, a port or column name, a path, an
 * error message, a JSON value, a label — reads as itself wherever lazytui puts
 * it into markup, and markup lazytui appends never gets eaten by the text in
 * front of it. Read back from the HOST screen (a headless xterm fed the bytes
 * lazytui writes) where it matters. Plus the other v0.6.60 pre-release review
 * T1 fixes: ^H under a user binding, console output while the TUI draws, popups
 * above the footer, kitty keypad keys.
 *
 * 2026-11-18 (v0.6.60 pre-release review). 19e9d2d4 made `\\` one backslash in
 * markup. Text that reached markup unescaped then lost a backslash (a pane
 * border read `C:\\share` as `C:\share` while its tab strip, menus and lists
 * showed it as typed), text escaped twice gained one (the `x` menu), and text
 * measured as markup but drawn escaped drew a column wider than its column
 * (table header, ports, wires). A splice that appended `[/]` after a lone `\`
 * printed `[/]` as text and pushed the row two columns wide.
 *
 *   [1] pane titles are text — border, collapsed bar, tab strip, `x` menu
 *   [2] names measured as shown — table header, ports pane, wire list
 *   [3] markup appended after a lone `\` stays markup — compositor splice, a
 *       full content row
 *   [4] text in labels and lines — which-key title, free-config hint, empty
 *       pool, file-loader error, replay diff, item-action legend, readiness
 *       reason, `:record-save` path
 *   [5] ^H — a user `keymap: normal:` binding on "\b" fires; fields still delete
 *   [6] console output while the TUI draws goes to diagnostics, never the screen
 *   [7] an anchored popup stops above the footer row
 *   [8] kitty keypad Enter / arrows act as the main keys
 *
 * Run: node js/test/test-text-in-markup.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { section, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const store = require('../model/store');
const { parse } = require('../parser');
const ansi = require('../leaves/text/ansi');
const { stripMarkup, visibleLen, esc } = ansi;
const hsMod = require('./_helpers/host-screen');

for (const comp of require('../app/components').BUILTIN_COMPONENTS) {
  if (!sm.api.getComponent(comp.name)) sm.api.registerComponent(comp);
}

const COLS = 100, ROWS = 24;
const hs = hsMod.install({ cols: COLS, rows: ROWS });
const { type } = require('./_helpers/text-fields').keys({ capture: false });   // (the host screen reads the frames)
const screen = () => Array.from({ length: hs.vt.rows }, (_, y) => hs.line(y));
const onScreen = (ok, label) => { if (!ok) hs.write(`${screen().join('\n')}\n`); assert(ok, label); };
const rowWith = (re) => screen().find((l) => re.test(l)) || '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-text-in-markup-'));
function bootYaml(yamlText, cols = COLS, rows = ROWS) {
  const yml = path.join(tmp, `tui-${Math.random().toString(36).slice(2)}.yml`);
  fs.writeFileSync(yml, yamlText);
  sm.bootFresh(parse(yml)); sm.resize(cols, rows); hs.reset(cols, rows);
}
async function step(name, fn) {
  try { await fn(); } catch (e) { assert(false, `${name} threw: ${e.stack}`); }
}

const TITLES = String.raw`
project_dir: .
groups:
  g1: { label: G, actions: { a: { label: A, script: 'true' } } }
panels:
  groups:  { type: groups,  title: 'Share \\srv\x' }
  actions: { type: actions, title: 'Acts [prod]' }
  notes:   { type: text-view, title: 'Tab \\srv\x', lines: [ hi ] }
  notes2:  { type: text-view, title: 'Other', lines: [ yo ] }
  detail:  { type: detail,  title: Detail }
layout:
  columns:
    - width: 40
      panels: [ groups ]
    - panels:
        - actions
        - detail
        - { tabs: [ notes, notes2 ] }
`;

(async () => {
  // ─────────────────────────────────────────────────────────────────────────
  section('[1] pane titles are text');
  await step('titles', async () => {
    bootYaml(TITLES);
    await hs.paint();
    const border = rowWith(/Share/);
    onScreen(border.includes('Share \\\\srv\\x'), `the border shows the title as typed (two backslashes): ${JSON.stringify(border.trim().slice(0, 50))}`);
    onScreen(rowWith(/Acts/).includes('Acts [prod]'), 'a `[prod]` in a title is text on the border');
    onScreen(rowWith(/Tab /).includes('Tab \\\\srv\\x'), 'the tab strip agrees');
    onScreen(rowWith(/Tab /).includes('─[Tab \\\\srv\\x]─Other'), 'the strip\'s own markup stays markup (the active tab\'s brackets, no stray `\\`)');

    // A filter on the pane extends its title — text, as typed.
    type('\x1b[C'); type('/'); type('a\\b'); type('\r');
    await hs.paint();
    onScreen(rowWith(/Acts/).includes('Acts [prod] /a\\b─'), `the filtered title shows the filter as typed: ${JSON.stringify(rowWith(/Acts/).slice(40, 90))}`);

    // The collapsed bar draws the same title.
    const layoutSlice = sm.api.getInstanceSlice('layout');
    const mpool = require('../leaves/wm/pool');
    const g = mpool.allPanesInColumns(layoutSlice.arrange).find((p) => p.title && p.title.startsWith('Share'));
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'panel_collapse_toggle', id: g.id }));
    await hs.paint();
    const bar = rowWith(/Share/);
    assert(sm.api.getInstanceSlice('layout').arrange.pool[g.id].collapsed || /▸|\[\+\]/.test(bar), `the pane collapsed: ${JSON.stringify(bar.slice(0, 50))}`);
    onScreen(bar.includes('Share \\\\srv\\x'), `the collapsed bar shows the title as typed: ${JSON.stringify(bar.slice(0, 50))}`);
  });

  await step('groups quick tabs', async () => {
    bootYaml(String.raw`
project_dir: .
groups:
  g1: { label: G, quick: true, actions: { a: { label: A, script: 'true' } } }
panels:
  groups:  { type: groups,  title: 'Gr' }
  detail:  { type: detail,  title: Detail }
layout:
  columns:
    - width: 40
      panels: [ groups ]
    - panels: [ detail ]
`);
    await hs.paint();
    onScreen(rowWith(/Gr─/).includes('Gr─[All]─Quick'), `the groups title shows its tabs: ${JSON.stringify(rowWith(/Gr─/).slice(0, 40))}`);
  });

  await step('files title (a styled title)', async () => {
    bootYaml(String.raw`
project_dir: .
groups:
  g1: { label: G, actions: { a: { label: A, script: 'true' } } }
files:
  - { path: README.md, desc: readme }
panels:
  docs:    { type: files, title: 'Docs \x', source: declared }
  detail:  { type: detail,  title: Detail }
layout:
  columns:
    - width: 40
      panels: [ docs ]
    - panels: [ detail ]
`);
    await hs.paint();
    onScreen(rowWith(/Docs/).includes('Docs \\x [declared]─'), `the text title as typed + the source chip: ${JSON.stringify(rowWith(/Docs/).slice(0, 40))}`);
  });

  await step('menu title', async () => {
    sm.applyMsg({ type: 'menu_open', items: [['One', 'noop']], title: 'Send [x] to C:\\' });
    await hs.paint();
    onScreen(screen().some((l) => l.includes('Send [x] to C:\\─')), 'a menu title is text');
    sm.applyMsg({ type: 'menu_close' });
  });

  await step('x menu', async () => {
    bootYaml(TITLES.replace(String.raw`'Share \\srv\x'`, String.raw`'Logs C:\tmp'`));
    await hs.paint();
    sm.applyMsg({ type: 'menu_open', items: require('../leaves/input/menu').buildItems(sm.api.getInstanceSlice('layout')) });
    await hs.paint();
    const logs = rowWith(/\[1\]\s+Logs/), acts = rowWith(/\[\d\]\s+Acts/);
    onScreen(/Logs C:\\tmp\s/.test(logs), `the x menu shows one backslash, as typed: ${JSON.stringify(logs.trim())}`);
    onScreen(/Acts \[prod\]/.test(acts), `the x menu shows [prod] once-escaped: ${JSON.stringify(acts.trim())}`);
    sm.applyMsg({ type: 'menu_close' });
  });

  // ─────────────────────────────────────────────────────────────────────────
  section('[2] names measured as they are shown');
  await step('table header', async () => {
    if (!sm.api.getComponent('table')) sm.api.registerComponent(require('../panel/monitor/table'));
    const COL = 'a\\\\b';   // a\\b — e.g. a JSON key from a metrics producer
    const paneCfg = { id: 'procs', type: 'table', title: 'Procs', config: { topic: 'p.stat', columns: [COL, 'cpu'] } };
    sm.bootFresh({ groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { procs: paneCfg }, columns: [{ panels: [paneCfg] }] } });
    sm.resize(70, 10); hs.reset(70, 10);
    store.getModel().metrics = { 'p.stat': { series: { r1: [{ [COL]: 1, cpu: 5 }] },
      schema: { columns: { [COL]: { type: 'number' }, cpu: { type: 'percent' } } } } };
    await hs.paint();
    const header = rowWith(/cpu/), data = rowWith(/^│r1/);
    onScreen(header.includes('a\\\\b'), 'the header shows the name as is');
    eq(header.trimEnd().length, data.trimEnd().length, 'the header row ends where the data rows end (its right border is not pushed)');
    eq(header.indexOf('│', 1), data.indexOf('│', 1), 'the right border is in the same column');
  });

  await step('ports + wires', async () => {
    const { setModel } = require('../app/runtime');
    const { wireFabricHost } = require('../dispatch/runtime/host-wiring');
    const mnav = require('../leaves/wm/nav');
    setModel({
      currentGroup: 'pg', modes: {},
      fabric: { injects: {}, output: { pg: {} }, wires: { pg: [] } },
      config: { groups: { pg: { label: 'pg', actions: {
        src: { label: 'src', run: ['true'], ports: { out: { 'o\\\\x': { type: 't' } } } },
        sink: { label: 'sink', run: ['true'], ports: { in: { 'a\\\\b': { type: 't' }, 'c[dddddd]': { type: 't' }, plain: { type: 't' } } } },
      }, wires: [{ from: 'src.o\\\\x', to: 'sink.a\\\\b' }, { from: 'src.o\\\\x', to: 'sink.plain' }] } } },
    });
    wireFabricHost();
    const ports = require('../panel/fabric/ports-pane').panelTypes['component-ports'];
    const out = ports.render({ paneId: 'p', title: 'Ports', hotkey: '' }, 80, 16, { nav: mnav.init(), pinned: 'sink' }, { focused: false });
    const rows = out.split('\n').map(stripMarkup);
    const typeCol = (name) => { const r = rows.find((l) => l.startsWith(`│  ${name} `)); return r ? r.indexOf(' t ', r.indexOf(name)) : -1; };
    const cols = ['a\\\\b', 'c[dddddd]', 'plain'].map(typeCol);
    assert(cols.every((c) => c > 0), `each port row draws: ${JSON.stringify(rows.slice(0, 8))}`);
    eq(new Set(cols).size, 1, `the type column lines up across port names a\\\\b, c[dddddd], plain: ${JSON.stringify(cols)}`);

    const wires = require('../panel/fabric/wire-list').panelTypes['fabric-wires'];
    const wout = wires.render({ paneId: 'w', title: 'Wires', hotkey: '' }, 80, 8, { nav: mnav.init(), paneId: 'w' }, { focused: false });
    const wrows = wout.split('\n').map(stripMarkup).filter((l) => l.includes('→'));
    const markCol = wrows.map((l) => l.search(/[✓✗]/));
    eq(wrows.length, 2, 'both wires draw');
    eq(markCol[0], markCol[1], `the mark column lines up after edges holding a\\\\b: ${JSON.stringify(wrows)}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  section('[3] markup appended after a lone `\\` stays markup');
  await step('splice', async () => {
    const { compositeRow } = require('../leaves/render/row-compositor');
    const rows = ['  Ctrl+\\         Exit terminal mode   '];
    const w0 = visibleLen(rows[0]);
    compositeRow(rows, 40, '[bold]MENU[/]', 8, 0, 4);
    const shown = stripMarkup(rows[0]);
    eq(visibleLen(rows[0]), w0, 'the row keeps its width');
    assert(shown.startsWith('  Ctrl+\\MENU'), `the backslash stays, no [/] text: ${JSON.stringify(shown)}`);

    const { renderPanel } = require('../leaves/render/draw');
    const box = renderPanel({ width: 10, height: 3, lines: ['abcdefg\\'] }).split('\n');
    eq(stripMarkup(box[1]), '│abcdefg\\│', 'a content line that fills its row and ends in `\\` keeps its border');
  });

  await step('splice on screen', async () => {
    bootYaml(TITLES.replace(String.raw`'Share \\srv\x'`, String.raw`'Logs C:\tmp'`));
    await hs.paint();
    const y = screen().findIndex((l) => l.includes('Logs C:\\tmp'));
    const x = screen()[y].indexOf('C:\\') + 3;   // the cell right after the backslash
    sm.applyMsg({ type: 'menu_open', items: [['Copy', 'noop'], ['Paste', 'noop']], anchor: { x: x + 1, y: y + 1 }, title: 'Menu' });
    await hs.paint();
    const row = hs.line(y);
    onScreen(row.includes('Logs C:\\╭') && !row.includes('[/]'), `a menu opened right after the title's \`\\\` keeps it: ${JSON.stringify(row.slice(0, 70))}`);
    eq(hs.scrolled(), 0, 'nothing wrapped or scrolled');
    sm.applyMsg({ type: 'menu_close' });
  });

  // ─────────────────────────────────────────────────────────────────────────
  section('[4] text in labels and lines');
  await step('which-key title', async () => {
    sm.bootFresh(); sm.resize(COLS, ROWS); hs.reset(COLS, ROWS);
    const kb = require('../leaves/input/keybindings');
    kb.registerKeyBinding('[x', { label: 'bracket x', run: () => {} });
    await hs.paint();
    type(' '); type('[');
    await hs.paint();
    onScreen(screen().some((l) => l.includes('[leader []')), 'a `[` step shows in the which-key title');
    type('\x1b');
    kb.clearBindings && kb.clearBindings();
  });

  await step('free-config hint', async () => {
    sm.bootFresh(); sm.resize(200, ROWS); hs.reset(200, ROWS);
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'free_config_enter' }));
    await hs.paint();
    onScreen(hs.line(ROWS - 1).includes('· [/] panel h'), `the footer names the [ and ] keys: ${JSON.stringify(hs.line(ROWS - 1).slice(0, 120))}`);
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'free_config_exit' }));
  });

  await step('empty pool', async () => {
    const mpool = require('../leaves/wm/pool');
    const real = mpool.panelListItems;
    sm.bootFresh(); sm.resize(60, ROWS); hs.reset(60, ROWS);   // narrow: the list-only overlay
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'free_config_enter' }));
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'panel_list_open' }));
    mpool.panelListItems = () => [];
    try { await hs.paint(); } finally { mpool.panelListItems = real; }
    onScreen(screen().some((l) => l.includes(' (pool is empty)')) && !screen().some((l) => l.includes('\\(pool')), 'the empty pool reads (pool is empty)');
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'panel_list_close' }));
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'free_config_exit' }));
  });

  await step(':save-layout path', async () => {
    const dir = path.join(tmp, 'cfg[1]');
    fs.mkdirSync(dir, { recursive: true });
    const yml = path.join(dir, 'tui.yml');
    fs.writeFileSync(yml, TITLES);
    sm.bootFresh(parse(yml)); sm.resize(COLS, ROWS);
    store.getModel().configPath = yml;
    const transcript = () => { const id = sm.route.resolveTarget('viewer_transcript'); const sl = id && sm.api.getInstanceSlice(id); return ((sl && sl.lines) || []).map(stripMarkup).join('\n'); };
    sm.capture(() => { type(':'); type('save-layout'); type('\r'); });
    assert(transcript().includes(`Layout saved to ${yml}`), `the saved-to path shows as is: ${JSON.stringify(transcript().split('\n').slice(-2))}`);
  });

  await step('file-loader error', async () => {
    const { loadFile } = require('../io/file-loader');
    const r = await loadFile(path.join(tmp, 'pages', '[id].tsx'), {});
    const shown = r.lines.map(stripMarkup);
    assert(shown[0].endsWith('pages/[id].tsx'), `the path shows as is: ${JSON.stringify(shown[0])}`);
    assert(shown[2].includes('[id].tsx'), `the error message shows as is: ${JSON.stringify(shown[2])}`);
  });

  await step('replay diff', async () => {
    sm.bootFresh(); sm.resize(120, 40);
    const scrub = require('../overlay/replay-scrubber');
    const md = require('../leaves/replay/model-diff');
    const fn = md.diffModels || md.modelDiff || md.diff || Object.values(md).find((f) => typeof f === 'function');
    const diff = fn({ a: 'C:\\proj', b: 'x\\[y] z' }, { a: 'C:\\proj\\new', b: 'x\\[y] zz' });
    const data = { paneView: 'full', checkpoints: [], t: 0, firstT: 0, mode: 'even', ratio: 1, pos: 1, total: 2, cursor: 0, diff };
    const rows = new Array(39).fill(' '.repeat(120));
    scrub.render(data, rows, 120);
    const shown = rows.map(stripMarkup);
    assert(shown.some((l) => l.includes('"C:\\\\proj" → "C:\\\\proj\\\\new"')), 'the JSON value shows its escapes as JSON writes them');
    assert(shown.some((l) => l.includes('"x\\\\[y] z"')), 'a `\\[` in a value is text, not a tag');
  });

  await step('item-action legend', async () => {
    const legend = require('../leaves/render/action-legend');
    const fn = legend.actionLegendRender || Object.values(legend).find((f) => typeof f === 'function' && f.name === 'actionLegendRender');
    const r = fn([{ key: '[', label: 'x[k]ill' }, { key: 'i', label: 'inspect' }], 60);
    assert(stripMarkup(r.text).includes('x[k]ill'), `a label holding [k] shows it: ${JSON.stringify(stripMarkup(r.text))}`);
    eq(visibleLen(r.text), r.visibleW, 'the legend draws the width it reports (its hit regions sit on it)');
  });

  await step('readiness reason + record path', async () => {
    sm.bootFresh(); sm.resize(COLS, ROWS);
    const viewer = () => { const id = sm.route.resolveTarget('viewer_transcript'); const s = id && sm.api.getInstanceSlice(id); return ((s && s.lines) || []).map(stripMarkup).join('\n'); };
    const recPath = path.join(tmp, 'rec[1].jsonl');
    sm.capture(() => { type(':'); type(`record-save ${recPath}`); type('\r'); });
    assert(viewer().includes(`→ ${recPath}`), `the :record-save path shows as is: ${JSON.stringify(viewer().split('\n').slice(-2))}`);
    sm.capture(() => { type(':'); type('record-stop'); type('\r'); });

    // The readiness lines print only when a run is not ready and nothing can be
    // prompted for — no key path reaches them today; pinned at the source.
    const src = fs.readFileSync(require.resolve('../dispatch/runtime/action-runner'), 'utf8');
    eq((src.match(/not ready: \$\{esc\(m\.reason\)\}/g) || []).length, 2, 'both readiness lines escape the reason (it names ports)');
  });

  // ─────────────────────────────────────────────────────────────────────────
  section('[5] ^H under a user binding');
  await step('ctrl-h', async () => {
    const dispatch = require('../dispatch/control/dispatch');
    const viewerHas = (s) => { const id = sm.route.resolveTarget('viewer'); const sl = id && sm.api.getInstanceSlice(id); return ((sl && sl.lines) || []).join('\n').includes(s); };
    sm.bootFresh(); sm.resize(COLS, ROWS);
    const ce = console.error; console.error = () => {};
    try { dispatch.loadKeymap({ keymap: { normal: { '\b': 'show_help' } } }, { checkActions: false }); } finally { console.error = ce; }
    eq(viewerHas('Command mode'), false, 'help not shown yet');
    sm.capture(() => type('\b'));
    eq(viewerHas('Command mode'), true, 'a keymap binding on "\\b" fires on ^H in normal mode');
    sm.capture(() => { type(':'); type('ab'); type('\b'); });
    eq(store.getModel().modal.cmdline.text, 'a', '…and ^H still deletes in the command line');
    sm.capture(() => type('\x1b'));
    dispatch.loadKeymap({}, { checkActions: false });
    sm.capture(() => { type(':'); type('xy'); type('\b'); });
    eq(store.getModel().modal.cmdline.text, 'x', 'unbound, ^H is Backspace');
    sm.capture(() => type('\x1b'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  section('[6] console output while the TUI draws');
  await step('console capture', async () => {
    const capture = require('../io/console-capture');
    const diag = require('../io/diag-log');
    sm.bootFresh(); sm.resize(COLS, ROWS); hs.reset(COLS, ROWS);
    await hs.paint();
    type(':'); type('quit');
    await hs.paint();
    const comp = sm.api.getComponent(sm.api.getComponentOwningPanel('groups'));
    const def = comp.panelTypes.groups;
    const real = def.render;
    const errWrite = process.stderr.write;
    let errBytes = 0;
    process.stderr.write = (chunk) => { errBytes += String(chunk).length; return true; };
    diag.clear();
    capture.install();
    def.render = () => { throw new Error('boom-render'); };
    try {
      for (let i = 0; i < 3; i++) await hs.paint();
      diag.flushDeferred();   // what the dispatch finalizer does after the frame
    } finally { def.render = real; capture.restore(); process.stderr.write = errWrite; }
    eq(errBytes, 0, 'nothing reached stderr (the screen) while three frames threw');
    eq(hs.scrolled(), 0, 'the screen did not scroll');
    onScreen(hs.line(ROWS - 1).startsWith(' :quit') && !hs.line(ROWS - 1).includes('boom'), 'the prompt row is clean');
    const hits = diag.snapshot().filter((e) => e.message.includes('boom-render'));
    eq(hits.length, 1, `the error is in diagnostics once (not once per frame): ${JSON.stringify(diag.snapshot().slice(0, 3))}`);
    type('\x1b');

    capture.install();
    const before = console.error;
    require('../dispatch/runtime/cleanup').cleanup();
    assert(console.error !== before && !capture.installed(), 'cleanup hands console back to the terminal');
  });

  // ─────────────────────────────────────────────────────────────────────────
  section('[7] an anchored popup stops above the footer');
  await step('anchored menu', async () => {
    const hitMap = require('../panel/hit-map');
    sm.bootFresh(); sm.resize(COLS, ROWS); hs.reset(COLS, ROWS);
    await hs.paint();
    sm.applyMsg({ type: 'menu_open', items: [['Alpha', 'noop'], ['Beta', 'noop']], anchor: { x: 40, y: ROWS } });
    await hs.paint();
    onScreen(hs.line(ROWS - 2).slice(39, 50).startsWith('╰'), `the menu's bottom border is drawn on the row above the footer: ${JSON.stringify(hs.line(ROWS - 2).slice(30, 90))}`);
    const over = hitMap.all().filter((r) => r.owner === 'menu' && r.id !== 'backdrop' && r.rect && r.rect.y + r.rect.h > ROWS - 1);
    eq(over.length, 0, `no menu region covers the footer row: ${JSON.stringify(over.map((r) => r.rect))}`);
    sm.applyMsg({ type: 'menu_close' });
  });

  // ─────────────────────────────────────────────────────────────────────────
  section('[8] kitty keypad keys');
  await step('keypad', async () => {
    const { kkpToLegacy } = require('../leaves/input/kkp-decode');
    eq([kkpToLegacy('\x1b[57414u'), kkpToLegacy('\x1b[57419u'), kkpToLegacy('\x1b[57420;2u'), kkpToLegacy('\x1b[57423u')],
      ['\r', '\x1b[A', '\x1b[B', '\x1b[H'], 'keypad Enter / Up / Shift+Down / Home → the main keys\' bytes');
    eq([kkpToLegacy('\x1b[57420;5u'), kkpToLegacy('\x1b[57376u')], [null, null], 'Ctrl+keypad and F13 stay unbound');
    sm.bootFresh(); sm.resize(COLS, ROWS);
    sm.capture(() => { type(':'); type('help'); type('\x1b[57414u'); });
    eq(store.getModel().modes.cmdMode, false, 'keypad Enter runs the command line');
  });

  hs.restore();
  fs.rmSync(tmp, { recursive: true, force: true });
  report();
})();
