/**
 * Paint ↔ hit-map agreement, swept across terminal widths
 * (docs/mouse-hit-map.md §Test strategy; reference_paint_hittest_agreement).
 *
 * For every hit-mapped overlay (all 12 of Release 1, plus fabric-form with
 * its choices list open), at widths 20…200, paint it and check every region
 * it published against the cells the frame actually drew:
 *   - every region lies inside the screen and inside its owner's box;
 *   - every chip covers an INTACT `[cap] label` — starts with `[`, has the
 *     closing `]`, and no truncation ellipsis — so a cut chip is never
 *     clickable (the narrow-pane phantom-hit class, for popups);
 *   - rows sit strictly inside the box borders.
 *
 * Release 2 — PANE CHROME (the `[chrome]` sweep below): for representative
 * layouts (default boot + a long tab strip, free-config, a collapsed pane, a
 * tree table with border controls, a running action's ✗ cancel chip), at each
 * width every chrome-band (z 40) and in-pane (z 30) region lies inside the
 * screen and its owner pane, and the painted text under it is what it claims:
 * `[_]` / `[+]` / `[X]` / `[≡]`, an intact tab label, a control part with no
 * ellipsis, the cancel block, a fold marker. Non-vacuity: every kind is seen,
 * and some width drops a pane's chrome (so the drop path is exercised).
 *
 * Run: node js/test/test-hit-map-agreement.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hm = require('../panel/hit-map');
const draw = require('../leaves/render/draw');
const { compositeOverlays } = require('./_helpers/overlay-capture');
const { stripMarkup } = require('../leaves/text/ansi');
const { getModel } = require('../app/runtime');
const api = sm.api;

const WIDTHS = [20, 26, 32, 44, 60, 80, 120, 200];

// Open one overlay in a fresh session. Each returns its compositor id.
const SCENARIOS = {
  confirm: () => { sm.capture(() => sm.applyMsg({ type: 'confirm_enter', message: 'Really do it?', cmd: null })); return 'confirm'; },
  'fabric-field': () => { sm.capture(() => sm.applyMsg({ type: 'fabric_field_enter', paneId: null, addr: 'g1.host', text: '', pendingAction: null })); return 'fabric-field'; },
  'diag-log': () => {
    getModel().diagLog = [{ level: 'warn', code: 'C1', message: 'something happened here', t: 0 }];
    sm.capture(() => sm.applyMsg({ type: 'diag_log_open', now: 0 }));
    return 'diag-log';
  },
  'register-popup': () => {
    getModel().register = { history: ['one', 'two'], cap: 10 };
    sm.capture(() => sm.applyMsg({ type: 'register_popup_enter' }));
    return 'register-popup';
  },
  jobs: () => {
    getModel().jobs = [{ id: 'j', kind: 'background', label: 'build', startedAt: 0, status: 'running' }];
    sm.capture(() => sm.applyMsg({ type: 'jobs_open', now: 0 }));
    return 'jobs';
  },
  copy: () => {
    const opts = [{ label: 'Name' }, { label: 'A rather long path label to truncate' }, { label: '— Cancel —', cancel: true }];
    require('../overlay/copy')._setOptions(opts.map(o => ({ ...o, content: 'x' })));
    sm.capture(() => sm.applyMsg({ type: 'copy_enter', options: opts }));
    return 'copy';
  },
  'which-key': () => {
    const kb = require('../leaves/input/keybindings');
    kb.clearBindings();
    kb.registerKeyBinding('g g', { label: 'go to the top of the list', run: () => {} });
    kb.registerKeyBinding('?', { label: 'help', run: () => {} });
    sm.capture(() => sm.applyMsg({ type: 'enter_prefix' }));
    return 'which-key';
  },
  'action-palette': () => {
    const cli = require('../app/cli');
    require('../overlay/action-palette').setConfigAccessors({ iterActions: cli.iterActions, resolveAction: cli.resolveAction });
    sm.capture(() => sm.applyMsg({ type: 'palette_open' }));
    return 'action-palette';
  },
  menu: () => {
    const items = [['Copy line', 'copy_text', 'a'], null, ['A much longer menu entry label here', 'noop']];
    sm.capture(() => sm.applyMsg({ type: 'menu_open', items, title: 'Actions', anchor: { x: 3, y: 3 } }));
    return 'menu';
  },
  'pane-menu': () => {
    sm.capture(() => api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups', cursor: 0, scroll: 0 })));
    return 'pane-menu';
  },
  cmdline: () => {
    sm.capture(() => sm.applyMsg({ type: 'cmdline_enter' }));
    sm.capture(() => sm.applyMsg({ type: 'cmdline_set_matches', matches: ['focus', 'filter'].map(n => ({ display: n, desc: `${n} things`, kind: 'cmd' })) }));
    return 'cmdline';
  },
  'fabric-form': () => { openForm(false); return 'fabric-form'; },
  'fabric-form (choices open)': () => { openForm(true); return 'fabric-form'; },
};

function openForm(picking) {
  const field = (port, extra) => ({ port, text: '', required: true, default: null, desc: `${port} desc`,
    choicesFnRef: null, choicesCmd: null, choicesLabeled: false, choicesTimeout: null, dependsOn: [], choices: null, ...extra });
  sm.capture(() => sm.applyMsg({ type: 'fabric_form_enter',
    pendingAction: { actionKey: 'restart', action: { label: 'Restart', type: 'run', script: 'true', ports: { in: { host: {}, svc: {} } } } },
    fields: [field('host'), field('svc', { choices: { items: ['nginx', 'sshd'], labels: null, truncated: false } })] }));
  sm.capture(() => sm.applyMsg({ type: 'fabric_form_focus', idx: 1 }));   // [space] choices hint shows
  if (picking) sm.capture(() => sm.applyMsg({ type: 'fabric_form_choices_open', port: 'svc' }));
}

function paintAndRead(owner) {
  const vp = draw.viewportDims();
  const newRows = compositeOverlays(getModel());
  const plain = newRows.map(r => stripMarkup(r));
  const regions = hm.all().filter(r => r.owner === owner);
  return { vp, plain, regions };
}

for (const [name, open] of Object.entries(SCENARIOS)) {
  describe(`[${name}] agreement across widths`, () => {
    for (const cols of WIDTHS) {
      it(`cols=${cols}`, () => {
        sm.bootFresh();
        sm.resize(cols, 24);
        const owner = open();
        const { vp, plain, regions } = paintAndRead(owner);
        const box = regions.find(r => r.id === 'box');
        if (!box) { assert(regions.length <= 1, 'no box → at most a backdrop'); return; }
        const inScreen = (r) => r.rect.x >= 0 && r.rect.y >= 0 && r.rect.x + r.rect.w <= vp.cols && r.rect.y + r.rect.h <= vp.rows;
        const inBox = (r) => r.rect.x >= box.rect.x && r.rect.y >= box.rect.y
          && r.rect.x + r.rect.w <= box.rect.x + box.rect.w && r.rect.y + r.rect.h <= box.rect.y + box.rect.h;
        for (const r of regions) {
          assert(inScreen(r), `${r.id} inside the screen`);
          if (r.id !== 'backdrop') assert(inBox(r), `${r.id} inside the box`);
          if (r.id.startsWith('row:')) {
            assert(r.rect.y > box.rect.y && r.rect.y < box.rect.y + box.rect.h - 1, `${r.id} not on a border row`);
          }
          if (r.id.startsWith('chip:')) {
            const text = plain[r.rect.y].slice(r.rect.x, r.rect.x + r.rect.w);
            assert(text.startsWith('[') && text.includes(']') && !text.includes('…'),
              `${r.id} covers an intact hint, got ${JSON.stringify(text)}`);
          }
        }
      });
    }
  });
}


// ── Release 2: pane chrome ───────────────────────────────────────────────────
const hc = require('./_helpers/hit-click');
const geo = require('../leaves/wm/geometry');
const route = require('../panel/route');
const mpool = require('../leaves/wm/pool');
const loop = require('../dispatch/runtime/loop');
const toLayout = (msg) => sm.capture(() => loop.dispatchMsg(api.wrap('layout', msg)));
const contentTab = require('../panel/content-tab');
const CH_WIDTHS = [20, 26, 32, 44, 60, 80, 120, 160];
const G = { g: { name: 'g', label: 'G', containers: [], children: [], parent: null, depth: 0, quick: false, actions: {} } };

function withLongStrip() {
  for (const n of ['Alpha', 'Bravo', 'Charlie', 'Delta']) contentTab.addContentTab('doc-' + n, n + '-tab', [n]);
}
const CHROME_SCENARIOS = {
  'default + long tab strip': { boot: () => { sm.bootFresh(); toLayout({ type: 'view_set', mode: 'normal' }); withLongStrip(); } },
  'free-config': { boot: () => { sm.bootFresh(); toLayout({ type: 'view_set', mode: 'normal' }); sm.capture(() => sm.applyMsg({ type: 'mode_set', flag: 'freeConfigMode' })); } },
  'collapsed pane': { boot: () => {
    const P = { groups: { id: 'groups', type: 'groups' }, groups2: { id: 'groups2', type: 'groups' }, detail: { id: 'detail', type: 'detail' } };
    sm.bootFresh({ layout: { pool: P, columns: [{ width: 40, panels: [P.groups, P.groups2] }, { panels: [P.detail] }] } });
    toLayout({ type: 'view_set', mode: 'normal' });
    toLayout({ type: 'panel_collapse_toggle', id: 'groups2' });
  } },
  'tree table + border controls': { boot: () => {
    if (!api.getComponent('table')) api.registerComponent(require('../panel/monitor/table'));
    const cfg = { id: 'procs', type: 'table', title: 'Procs', config: { topic: 'host.sweep', columns: ['cpu', 'comm'], sort: 'cpu', tree: { parent: 'ppid' } } };
    const det = { id: 'detail', type: 'detail' };
    sm.bootFresh({ groups: G, layout: { pool: { procs: cfg, detail: det }, columns: [{ width: 60, panels: [cfg] }, { panels: [det] }] } });
    toLayout({ type: 'view_set', mode: 'normal' });
    getModel().metrics = { ...(getModel().metrics || {}), 'host.sweep': {
      schema: { columns: { cpu: { type: 'percent' }, comm: { type: 'string' }, ppid: { type: 'number' } } },
      series: { '1': [{ cpu: 5, comm: 'init', ppid: 0 }], '100': [{ cpu: 9, comm: 'bash', ppid: 1 }], '200': [{ cpu: 1, comm: 'vim', ppid: 100 }] } } };
    toLayout({ type: 'focus_set', focus: 'pane-procs' });
  } },
  'running action (cancel chip)': {
    boot: () => {
      if (!api.getComponent('text-view')) api.registerComponent(require('../panel/text-view/text-view'));
      const ACT = { key: 'logs', label: 'logs', type: 'run', script: 'sleep 5', tab: true };
      sm.bootFresh({ groups: { g1: { name: 'g1', label: 'G1', containers: [], children: [], parent: null, depth: 0, quick: false, actions: { logs: ACT } } } });
      toLayout({ type: 'view_set', mode: 'normal' });
      require('../dispatch/runtime/action-runner').runAction('logs', ACT);
    },
    done: () => require('../dispatch/runtime/action-runner').killAll(),
  },
};

const seen = { collapse: 0, expand: 0, close: 0, trigger: 0, tab: 0, ctl: 0, cancel: 0, tree: 0 };
let chromeDropped = 0;

function checkChromeFrame(cols, label) {
  const ROWS = 30;
  const rows = hc.screenRows();
  const text = (r) => { let t = ''; for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) t += ((rows[r.rect.y] || [])[x]) || ' '; return t; };
  const layout = api.getInstanceSlice('layout');
  const viewer = route.resolveViewerPaneId();
  const panes = mpool.allPanesInColumns(layout.arrange);
  const regions = hm.all().filter(r => r.z === hm.BANDS.CHROME || r.z === hm.BANDS.IN_PANE);
  for (const r of regions) {
    const where = `${label} cols=${cols} ${r.owner}/${r.id}`;
    assert(r.rect.x >= 0 && r.rect.y >= 0 && r.rect.x + r.rect.w <= cols && r.rect.y + r.rect.h <= ROWS, `${where}: inside the screen`);
    const b = geo.visibleBoundsFor(layout, r.paneId, viewer);
    assert(b, `${where}: owner pane is visible`);
    if (b) assert(r.rect.x >= b.x && r.rect.y >= b.y && r.rect.x + r.rect.w <= b.x + b.w && r.rect.y + r.rect.h <= b.y + b.h, `${where}: inside its pane`);
    const t = text(r);
    const pane = panes.find(p => p.paneId === r.paneId);
    if (r.id === 'collapse') {
      const want = pane && pane.collapsed ? '[+]' : '[_]';
      assert(t === want, `${where}: painted ${JSON.stringify(t)}, want ${want}`);
      seen[pane && pane.collapsed ? 'expand' : 'collapse']++;
    } else if (r.id === 'close') { assert(t === '[X]', `${where}: painted ${JSON.stringify(t)}`); seen.close++; }
    else if (r.id === 'trigger') { assert(t === '[≡]', `${where}: painted ${JSON.stringify(t)}`); seen.trigger++; }
    else if (r.id.startsWith('tab:')) {
      assert(t.trim() && !t.includes('…') && !t.includes('─'), `${where}: an intact tab label, got ${JSON.stringify(t)}`);
      seen.tab++;
    } else if (r.id.startsWith('ctl:')) {
      assert(!t.includes('…') && !/[─╮╭]/.test(t), `${where}: an intact control part, got ${JSON.stringify(t)}`);
      seen.ctl++;
    } else if (r.id === 'cancel') { assert(t.includes('cancel') && t.includes('✗'), `${where}: the cancel block, got ${JSON.stringify(t)}`); seen.cancel++; }
    else if (r.id.startsWith('tree:')) {
      const g = (rows[r.rect.y] || [])[r.rect.x];
      assert(g === '▾' || g === '▸', `${where}: a fold marker at x0, got ${JSON.stringify(g)}`);
      seen.tree++;
    } else assert(false, `${where}: unexpected pane-band region id`);
  }
  // Drop path: a visible, non-content, expanded pane that published no [_].
  for (const p of panes) {
    if (p.collapsed || p.role === 'content' || p.type === 'detail') continue;
    if (!geo.visibleBoundsFor(layout, p.paneId, viewer)) continue;
    if (!regions.some(r => r.paneId === p.paneId && r.id === 'collapse')) chromeDropped++;
  }
}

for (const [label, sc] of Object.entries(CHROME_SCENARIOS)) {
  describe(`[chrome: ${label}] agreement across widths`, () => {
    for (const cols of CH_WIDTHS) {
      it(`cols=${cols}`, () => {
        sc.boot();
        sm.resize(cols, 30);
        try { checkChromeFrame(cols, label); } finally { if (sc.done) sc.done(); }
      });
    }
  });
}

describe('[chrome] non-vacuity', () => {
  it('the sweep saw every region kind and at least one dropped chrome cluster', () => {
    for (const [k, n] of Object.entries(seen)) assert(n > 0, `saw ${k} regions (${n})`);
    assert(chromeDropped > 0, `some width dropped a pane's chrome (${chromeDropped})`);
  });
});

report();
