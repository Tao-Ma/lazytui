/**
 * test-viewer-model-bundle.js — blessed-exceptions #3 (viewer.update purity).
 *
 * The viewer's tab/content readers need a fixed fact-set from the model
 * (current group, its config, the COMPUTED merged actions, yaml terminals).
 * `pt.viewerModelBundle` captures it once in the shell so `viewer.update`
 * can read it from the Msg payload instead of `getModel()`.
 *
 * P0: the bundle shape. (P1+ wire it through flatTabInfo/viewerLines and the
 * framework dispatch; later phases extend this file.)
 *
 * Run: node js/test/test-viewer-model-bundle.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getModel, setModel } = require('../app/runtime');
const pt = require('../leaves/wm/pane-tabs');
const viewer = require('../panel/viewer/viewer');

describe('[P0] viewerModelBundle captures the model fact-set', () => {
  it('has currentGroup, group, mergedActions, yamlTerminals', () => {
    sm.bootFresh();
    const m = getModel();
    const b = pt.viewerModelBundle(m, m.currentGroup);
    eq(b.currentGroup, m.currentGroup, 'currentGroup mirrors the model');
    assert(b.group && typeof b.group === 'object', 'group config present');
    assert(b.mergedActions && typeof b.mergedActions === 'object', 'mergedActions is an object');
    assert(b.yamlTerminals === null || typeof b.yamlTerminals === 'object',
      'yamlTerminals is an object or null');
  });

  it('mergedActions equals the live getMergedActions snapshot', () => {
    sm.bootFresh();
    const m = getModel();
    const api = require('../panel/api');
    const b = pt.viewerModelBundle(m, m.currentGroup);
    eq(Object.keys(b.mergedActions).sort().join(','),
       Object.keys(api.getMergedActions(m.currentGroup)).sort().join(','),
       'same action keys as getMergedActions');
  });

  it('an unknown group yields empty merged actions + null terminals', () => {
    sm.bootFresh();
    const m = getModel();
    const b = pt.viewerModelBundle(m, '__no_such_group__');
    eq(b.group, null, 'no group');
    eq(Object.keys(b.mergedActions).length, 0, 'no merged actions');
    eq(b.yamlTerminals, null, 'no terminals');
  });
});

// P1 — the *FromBundle readers must be byte-for-byte parity with the
// model-path readers (so wiring them into viewer.update at P3 is safe).
describe('[P1] *FromBundle parity with the model-path readers', () => {
  it('flatTabInfo / viewerLines / resolveTabKey match across every tab idx', () => {
    sm.bootFresh();
    const m = getModel();
    const g = m.currentGroup;
    const bundle = pt.viewerModelBundle(m, g);
    // Exercise a representative slice: a content tab + an ephemeral term so
    // the action/term/content branches are all populated.
    const slice = {
      tab: 0,
      infoLines: ['info-a', 'info-b'],
      ephemeralTerminals: { [g]: { sh: { cmd: 'bash', label: 'sh' } } },
      contentTabs: { [g]: { log: { lines: ['line-1', 'line-2'] } } },
      actionTabBuffers: {},
      viewerStreamBuffer: { lines: [], cap: 1000 },
    };

    const infoModel = pt.flatTabInfo(slice, m, g);
    const infoBundle = pt.flatTabInfoFromBundle(slice, bundle);
    eq(JSON.stringify(infoBundle), JSON.stringify(infoModel), 'flatTabInfo parity');

    const total = infoModel.total;
    for (let tab = 0; tab <= total + 1; tab++) {
      const s = { ...slice, tab };
      eq(JSON.stringify(pt.viewerLinesFromBundle(s, bundle)),
         JSON.stringify(pt.viewerLines(s, m, g)),
         `viewerLines parity @ tab ${tab}`);
      eq(String(pt.resolveTabKeyFromBundle(tab, s, bundle)),
         String(pt.resolveTabKey(tab, s, m)),
         `resolveTabKey parity @ tab ${tab}`);
    }
  });

  it('viewerOverride + infoFromFocus lookups behave identically', () => {
    sm.bootFresh();
    const m = getModel();
    const g = m.currentGroup;
    const bundle = pt.viewerModelBundle(m, g);
    const lookups = { infoFromFocus: () => ['focus-line'] };
    const s0 = { tab: 0, infoLines: ['stored'] };
    eq(JSON.stringify(pt.viewerLinesFromBundle(s0, bundle, lookups)),
       JSON.stringify(pt.viewerLines(s0, m, g, lookups)),
       'infoFromFocus parity');
    const sOv = { tab: 3, viewerOverride: { lines: ['ov-1'] } };
    eq(JSON.stringify(pt.viewerLinesFromBundle(sOv, bundle)),
       JSON.stringify(pt.viewerLines(sOv, m, g)),
       'viewerOverride parity');
  });
});

// P3/P4 — viewer.update follows the THREADED bundle, never the live model.
// Teeth: corrupt getModel()'s return; if update reintroduced a getModel read,
// the tab-transition capture (which needs the group's tab structure) would
// break. With the bundle threaded it must still resolve correctly.
describe('[P4] viewer.update is pure of getModel (bundle-driven)', () => {
  it('tab-transition capture uses the bundle group even when the live model is wrong', () => {
    sm.bootFresh();
    const m = getModel();
    const g = m.currentGroup;
    // A slice with a content tab in the current group.
    const slice = {
      tab: 0, scroll: 0, infoLines: ['i'],
      contentTabs: { [g]: { log: { lines: ['L1', 'L2'] } } },
      ephemeralTerminals: {}, actionTabBuffers: {},
    };
    const info = pt.flatTabInfo(slice, m, g);
    const contentIdx = info.total - 1;                 // content tab is last
    const goodBundle = pt.viewerModelBundle(m, g);

    // Corrupt the live model: any stray getModel() read in update would now
    // derive the WRONG group (or no groups) and skip/misplace the capture.
    setModel({ ...m, currentGroup: '__wrong__', config: { groups: {} } });

    // Switch FROM the content tab TO Info — triggers _withDerivedFields.
    const fromSlice = { ...slice, tab: contentIdx, scroll: 1 };
    const r = viewer._update(
      { type: 'viewer_set_tab', tab: 0, total: 2, toTabKey: 'info', viewerModel: goodBundle },
      fromSlice);
    const next = Array.isArray(r) ? r[0] : r;
    const key = `${g}:content:log`;
    assert(next.tabState && next.tabState[key],
      'captured the leaving content-tab state under the bundle-derived key');
    eq(next.tabState[key].scroll, 1, 'captured the original scroll');
  });
});

report();
