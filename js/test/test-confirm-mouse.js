/**
 * Confirm popup — mouse (docs/mouse-hit-map.md Release 1, the field report:
 * "when confirm popup shows, I cannot click mouse").
 *
 * Every click here is RAW SGR bytes through input._dispatchToken (the real
 * parser → _classifyPress → handleMouse → hit-map router path), after a real
 * paint (smoke render) published the frame's regions.
 *
 *   [1] paint↔hit agreement: each chip region covers exactly its painted text
 *   [2] click [y] → accept (staged Cmd runs); click [n] → reject (rollback runs)
 *   [3] chip ≡ key: model after the click deep-equals model after the keystroke
 *   [4] outside click → reject; inside non-chip / wheel → consumed, no change
 *   [5] double-click on [y] → one accept; the pane beneath is NOT activated
 *   [6] narrow terminal: a truncated chip publishes nothing (no phantom)
 *
 * Run: node js/test/test-confirm-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const input = require('../dispatch/control/input');
const actions = require('../dispatch/control/actions');
const hm = require('../panel/hit-map');
const compositor = require('../render/overlay-compositor');
const { chainStamp } = require('../leaves/input/modes');
const { stripMarkup } = require('../leaves/text/ansi');
const { getModel } = require('../app/runtime');

const ACCEPT = { type: 'msg', msg: { type: 'register_push', text: 'ACCEPTED' } };
const REJECT = { type: 'msg', msg: { type: 'register_push', text: 'REJECTED' } };

// 40 groups → the groups pane's rows fill its whole height, so whatever cell
// the popup covers on the left column sits over a SELECTABLE row (the [5]
// double-click hazard needs a row beneath the chip to be meaningful).
function manyGroups(n) {
  const out = {};
  for (let i = 0; i < n; i++) {
    out[`g${i}`] = { name: `g${i}`, label: `Group ${i}`, containers: [], children: [], parent: null, depth: 0, quick: false,
                     actions: { a: { key: 'a', label: 'A', type: 'run', script: 'true', tab: false } } };
  }
  return out;
}

function openConfirm(cols = 120, rows = 30, opts = {}) {
  sm.bootFresh(opts.groups ? { groups: opts.groups } : undefined);
  sm.resize(cols, rows);
  getModel().register = { history: [], cap: 100 };
  sm.capture(() => sm.applyMsg({ type: 'confirm_enter', message: 'Really do it?', cmd: ACCEPT }));
  // The rollback slot confirm_enter preserves (v0.6.45) — observable on reject.
  getModel().modal = { ...getModel().modal, onReject: REJECT };
  sm.capture(sm.render);          // a real paint publishes the hit map
}
// Fire an off-screen press first so the parser's double-click triple can't
// pair this click with an earlier same-cell one from another test.
function click(mx, my, button = 0) {
  sm.capture(() => {
    input._dispatchToken('\x1b[<0;250;90M');
    input._dispatchToken(`\x1b[<${button};${mx + 1};${my + 1}M`);
  });
}
function wheel(mx, my) { sm.capture(() => input._dispatchToken(`\x1b[<65;${mx + 1};${my + 1}M`)); }
function region(id) { return hm.all().find(r => r.owner === 'confirm' && r.id === id) || null; }
const reg = () => getModel().register.history.slice();
const open = () => getModel().modes.confirmMode === true;

describe('[1] paint↔hit agreement', () => {
  it('each chip region covers exactly the hint text painted there', () => {
    openConfirm();
    // Re-composite into a buffer we can read, under the same hit-map bracket.
    const vp = require('../leaves/render/draw').viewportDims();
    const newRows = new Array(vp.rows).fill(' '.repeat(vp.cols));
    hm.clear(chainStamp(getModel().modes));
    compositor.paintActive(getModel(), newRows, vp.cols);
    const text = (r) => stripMarkup(newRows[r.rect.y]).slice(r.rect.x, r.rect.x + r.rect.w);
    eq(text(region('chip:y')), '[y] confirm');
    eq(text(region('chip:n')), '[n] cancel');
    const box = region('box');
    assert(box && box.opaque, 'opaque box published');
    const bd = region('backdrop');
    eq(bd.rect, { x: 0, y: 0, w: vp.cols, h: vp.rows }, 'full-screen backdrop');
    assert(bd.z < box.z && box.z < region('chip:y').z, 'backdrop < box < chip');
  });
});

describe('[2] chips', () => {
  it('click [y] → accept: the staged Cmd runs, the popup closes', () => {
    openConfirm();
    const y = region('chip:y');
    click(y.rect.x + 1, y.rect.y);
    eq(open(), false, 'closed');
    eq(reg(), ['ACCEPTED'], 'accept Cmd ran, rollback did not');
  });
  it('click [n] → reject: the rollback runs, the Cmd does not', () => {
    openConfirm();
    const n = region('chip:n');
    click(n.rect.x + n.rect.w - 1, n.rect.y);   // last cell of the chip
    eq(open(), false, 'closed');
    eq(reg(), ['REJECTED']);
  });
});

describe('[3] chip ≡ key', () => {
  for (const [id, key] of [['chip:y', 'y'], ['chip:n', 'n']]) {
    it(`clicking ${id} leaves the same model as pressing '${key}'`, () => {
      const pick = (m) => JSON.parse(JSON.stringify({ modes: m.modes, modal: m.modal, register: m.register }));
      openConfirm();
      sm.capture(() => sm.handleKey(key, key));
      const viaKey = pick(getModel());
      openConfirm();
      const r = region(id);
      click(r.rect.x, r.rect.y);
      eq(pick(getModel()), viaKey);
    });
  }
});

describe('[4] outside / inside / wheel', () => {
  it('a click outside the box rejects (Esc)', () => {
    openConfirm();
    click(0, 0);
    eq(open(), false);
    eq(reg(), ['REJECTED']);
  });
  it('a click on the FOOTER row rejects too (the backdrop covers the whole screen)', () => {
    openConfirm();
    const vp = require('../leaves/render/draw').viewportDims();
    click(5, vp.rows - 1);
    eq(open(), false);
    eq(reg(), ['REJECTED']);
  });
  it('a right-click outside rejects too (backdrop owns every button)', () => {
    openConfirm();
    click(0, 0, 2);
    eq(open(), false);
    eq(reg(), ['REJECTED']);
  });
  it('a click inside the box but off the chips is consumed: still open', () => {
    openConfirm();
    const box = region('box');
    click(box.rect.x + 2, box.rect.y + 1);          // the message line
    eq(open(), true);
    eq(reg(), []);
  });
  it('wheel anywhere is consumed: still open, nothing fired', () => {
    openConfirm();
    wheel(0, 0);
    const box = region('box');
    wheel(box.rect.x + 2, box.rect.y + 1);
    eq(open(), true);
    eq(reg(), []);
  });
});

describe('[5] double-click on [y]', () => {
  it('accepts once; the second click does not activate the pane beneath', () => {
    // 60 cols: the 58-wide box starts at x=1, so the [y] chip sits over the
    // groups pane (left column), whose 40 rows fill it top to bottom.
    openConfirm(60, 30, { groups: manyGroups(40) });
    const y = region('chip:y');
    const under = require('../leaves/wm/geometry').visibleBoundsFor(sm.api.getInstanceSlice('layout'), 'pane-groups');
    assert(under && y.rect.x + 2 >= under.x && y.rect.x + 2 < under.x + under.w
           && y.rect.y > under.y && y.rect.y < under.y + under.h - 1,
           'precondition: the chip sits over a groups-pane body row');
    const calls = [];
    const real = actions.handleAction;
    actions.handleAction = (...a) => { calls.push(a[0]); return real(...a); };
    try {
      sm.capture(() => {
        input._dispatchToken('\x1b[<0;250;90M');
        input._dispatchToken(`\x1b[<0;${y.rect.x + 2};${y.rect.y + 1}M`);   // press → accept
        input._dispatchToken(`\x1b[<0;${y.rect.x + 2};${y.rect.y + 1}M`);   // same cell, fast → double
      });
    } finally { actions.handleAction = real; }
    eq(reg(), ['ACCEPTED'], 'exactly one accept');
    eq(calls.filter(c => c === 'run_selected'), [], 'no pane activate leaked');
  });
});

describe('[6] narrow terminal', () => {
  it('a hint chip truncation cut publishes no region', () => {
    openConfirm(22, 12);          // box = 20 wide → inner 18: "[n] cancel" is cut
    assert(region('chip:y'), '[y] confirm still fits');
    eq(region('chip:n'), null, '[n] cancel truncated → not clickable');
  });
});

report();
