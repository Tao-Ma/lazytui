/**
 * action palette — mouse (docs/mouse-hit-map.md Release 1).
 *
 *   [1] a row covers its painted action (paint↔hit agreement, filter row offset)
 *   [2] click a row → invokes THAT action (palette_run_action for its pair)
 *   [3] [enter] chip ≡ Enter; [esc] chip ≡ Esc (two-step: clears filter first)
 *   [4] outside click is SWALLOWED: the typed filter survives
 *   [5] wheel steps the highlight
 *
 * palette_run_action is captured (re-registered) so nothing spawns.
 *
 * Run: node js/test/test-action-palette-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const effects = require('../dispatch/runtime/effects');
const { getModel } = require('../app/runtime');

// The palette's config walker is boot-injected (tui.js); tests wire the same
// accessors test-action-palette.js does.
const cli = require('../app/cli');
require('../overlay/action-palette').setConfigAccessors({ iterActions: cli.iterActions, resolveAction: cli.resolveAction });

const O = 'action-palette';
let runs = [];
effects.registerEffect('palette_run_action', (eff) => runs.push(`${eff.groupPath}:${eff.actionKey}`));

const act = (key) => ({ key, label: key.toUpperCase(), type: 'run', script: 'true', tab: false });
const GROUPS = {
  ops: { name: 'ops', label: 'Ops', containers: [], children: [], parent: null, depth: 0, quick: false,
         actions: { build: act('build'), deploy: act('deploy'), lint: act('lint') } },
};

function openPalette(filter) {
  sm.bootFresh({ groups: GROUPS });
  sm.resize(120, 30);
  runs = [];
  sm.capture(() => sm.applyMsg({ type: 'palette_open' }));
  for (const ch of filter || '') sm.capture(() => sm.handleKey(ch, ch));
  hc.paint();
}
const rowWith = (text) => hc.regions(O).find(r => r.id.startsWith('row:') && hc.paintedText(O, r.id).includes(text));
const pal = () => getModel().modal.palette;

describe('[1] agreement', () => {
  it('each row covers its action; the /filter line has no target', () => {
    openPalette('');
    const rows = hc.regions(O).filter(r => r.id.startsWith('row:'));
    eq(rows.length, 3);
    assert(rowWith('deploy'), 'a row paints "deploy"');
    openPalette('de');
    eq(hc.region(O, 'row:0'), null, 'line 0 is the /filter row');
    assert(rowWith('deploy'), 'filtered row still covers its text');
  });
});

describe('[2] row click', () => {
  it('invokes the clicked action, not the highlighted one', () => {
    openPalette('');
    eq(pal().idx, 0);
    hc.clickRegion(O, rowWith('lint').id);
    eq(runs, ['ops:lint']);
    eq(getModel().modes.paletteMode, false, 'closed');
  });
});

describe('[3] chips', () => {
  it('[enter] chip ≡ Enter (invokes the highlighted row)', () => {
    openPalette('');
    sm.capture(() => sm.handleKey('return', '\r'));
    const viaKey = { model: hc.snapshot(), runs: runs.slice() };
    openPalette('');
    hc.clickRegion(O, 'chip:return');
    eq({ model: hc.snapshot(), runs: runs.slice() }, viaKey);
  });
  it('[esc] chip is two-step like Esc: clears a filter, then closes', () => {
    openPalette('li');
    hc.clickRegion(O, 'chip:escape');
    eq(pal().filter, '', 'first click clears the filter');
    eq(getModel().modes.paletteMode, true);
    hc.paint();
    hc.clickRegion(O, 'chip:escape');
    eq(getModel().modes.paletteMode, false, 'second click closes');
  });
});

describe('[4] outside', () => {
  it('is swallowed: filter intact, still open', () => {
    openPalette('dep');
    hc.click(0, 0);
    eq(getModel().modes.paletteMode, true);
    eq(pal().filter, 'dep');
    eq(runs, []);
  });
});

describe('[5] wheel', () => {
  it('steps the highlight', () => {
    openPalette('');
    hc.wheelRegion(O, 'box', 'down');
    eq(pal().idx, 1);
    hc.wheelRegion(O, 'box', 'up');
    eq(pal().idx, 0);
  });
});

report();
