/**
 * Smoke — batched stdin chunks parse fully and paint ONCE.
 *
 * Network-lag fix, 2026-08-05. Over SSH, autorepeat keystrokes arrive
 * BATCHED in a single stdin 'data' chunk. Pre-fix, the input layer
 * (1) painted once per key inside a plain-char burst — N queued frames
 * per chunk, the user-reported crawling-highlight lag on the Actions
 * pane — and (2) DROPPED a batched escape-prefixed chunk whole
 * (`'\x1b[B\x1b[B'` matched no exact case → unknown-escape), so held
 * arrow-down over a laggy link ate keystrokes. Sequences split ACROSS
 * chunks by TCP (`'\x1b['` + `'B'`) misparsed as drop + stray plain 'B'.
 *
 * Drives the REAL stdin data handler (input._makeDataHandler on an
 * EventEmitter stub) over the real dispatch/render pipeline and asserts,
 * per chunk shape: the cursor lands where ALL the batched keys say, the
 * chunk paints exactly once, and the single-key path still paints
 * synchronously (local latency contract).
 *
 * Run: node js/scripts/run-smoke.js input-burst   (or directly)
 */
'use strict';

const EventEmitter = require('events');
const sm = require('./_helpers/smoke');
const api = sm.api;
const paint = require('../../render/paint');
const rq = require('../../leaves/infra/render-queue');
const input = require('../../dispatch/control/input');
const navState = require('../../panel/nav-state');
const { getModel } = require('../../model/store');
const { describe, it, assert, eq, report } = require('../test-runner');

if (!api.getComponent('actions')) api.registerComponent(require('../../panel/navigator/actions'));

const N = 60;
const actions = {};
for (let i = 1; i <= N; i++) {
  actions[`a${i}`] = { key: `a${i}`, label: `Action number ${i}`, type: 'run', script: 'true', tab: false };
}
sm.bootFresh({
  groups: {
    g1: { name: 'g1', label: 'G1', containers: [], actions, children: [], parent: null, depth: 0, quick: false },
  },
});
sm.resize(100, 24);
paint.setColorDepth('truecolor');

let actionsPane = null;
for (const col of (api.getInstanceSlice('layout').arrange.columns || [])) {
  for (const p of (col.panels || [])) if (p.type === 'actions') actionsPane = p.paneId;
}
api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: actionsPane }));

// The real handler on an emitter stub (reemit re-entry works as in prod).
const stdin = new EventEmitter();
const handler = input._makeDataHandler(stdin);
stdin.on('data', handler);

// Count paints by wrapping the registered renderer; writes are captured
// so frames don't leak into the test output.
let paints = 0;
rq.setRenderers({ render: () => { paints++; paint.render(getModel()); } });
const feed = (chunk) => sm.capture(() => stdin.emit('data', chunk));
const sel = () => navState.getSel(actionsPane);

describe('[1] plain-char autorepeat burst', () => {
  it('one chunk of 5 j’s advances 5 and paints once', () => {
    const before = sel();
    paints = 0;
    feed('jjjjj');
    eq(sel(), before + 5, 'all 5 keys dispatched');
    eq(paints, 1, 'exactly one paint for the whole chunk');
  });
  it('a single-key chunk still paints synchronously (local path)', () => {
    const before = sel();
    paints = 0;
    feed('j');
    eq(sel(), before + 1, 'key dispatched');
    eq(paints, 1, 'painted within the chunk (not deferred)');
  });
});

describe('[2] batched arrow-key chunk (pre-fix: dropped whole)', () => {
  it('one chunk of 3 down-arrows advances 3', () => {
    const before = sel();
    paints = 0;
    feed('\x1b[B\x1b[B\x1b[B');
    eq(sel(), before + 3, 'all 3 arrow events dispatched');
    eq(paints, 1, 'one paint for the chunk');
  });
});

describe('[3] mixed keys + arrows in one chunk', () => {
  it('j + down-arrow + j advances 3', () => {
    const before = sel();
    feed('j\x1b[Bj');
    eq(sel(), before + 3);
  });
});

describe('[4] sequence split across chunks (pre-fix: drop + stray key)', () => {
  it('‘\\x1b[’ then ‘B’ joins into ONE down-arrow', () => {
    const before = sel();
    feed('\x1b[');
    eq(sel(), before, 'partial sequence dispatches nothing');
    feed('B');
    eq(sel(), before + 1, 'continuation completes the arrow (no stray plain B)');
  });
});

describe('[5] burst ending in a partial sequence', () => {
  it('completed tokens dispatch; the partial carries to the next chunk', () => {
    const before = sel();
    feed('jj\x1b[');
    eq(sel(), before + 2, 'the two j’s dispatched');
    feed('B');
    eq(sel(), before + 3, 'carried partial completed by the next chunk');
  });
});

report();
