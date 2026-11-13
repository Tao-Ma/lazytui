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

report();
