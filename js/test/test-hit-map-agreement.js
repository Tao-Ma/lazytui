/**
 * Paint ↔ hit-map agreement, swept across terminal widths
 * (docs/mouse-hit-map.md §Test strategy; reference_paint_hittest_agreement).
 *
 * For each migrated overlay, at widths 20…200, paint it and check every region
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

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const hm = require('../panel/hit-map');
const compositor = require('../render/overlay-compositor');
const draw = require('../leaves/render/draw');
const { chainStamp } = require('../leaves/input/modes');
const { stripMarkup } = require('../leaves/text/ansi');
const { getModel } = require('../app/runtime');

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
};

function paintAndRead(owner) {
  const vp = draw.viewportDims();
  const newRows = new Array(vp.rows).fill(' '.repeat(vp.cols));
  hm.clear(chainStamp(getModel().modes));
  sm.capture(() => compositor.paintActive(getModel(), newRows, vp.cols));
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
