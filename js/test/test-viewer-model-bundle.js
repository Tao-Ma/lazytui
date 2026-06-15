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
const { getModel } = require('../app/runtime');
const pt = require('../leaves/pane-tabs');

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

report();
