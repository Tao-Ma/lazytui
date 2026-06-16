/**
 * Per-pane instance lifecycle — runtime mint-on-placement + dispose-on-removal
 * (v0.6.5 §5(b)).
 *
 * The v0.6.4 multi-viewer arc gave each PLACED pane its own Component instance
 * (keyed by paneId), but only at BOOT — `initState` minted from the parsed
 * layout. A pane placed at RUNTIME (pool_show / pool-drag / pane-select) got a
 * fresh paneId but NO instance, so `sliceForPane` fell back to the kind
 * primary: a second same-kind pane added live MIRRORED the primary instead of
 * being an independent viewer. Symmetrically, removing a pane never disposed
 * its instance.
 *
 * Fix: the dispatch finalizer re-runs `state.reconcilePaneInstances` (injected
 * via `api.setInstanceReconciler`, gated on arrange-ref change), minting
 * newly-placed panes and disposing removed ones. This test drives the full
 * dispatch pipeline (not the bare reducer) so the finalizer actually fires.
 *
 * Run: node js/test/test-instance-lifecycle.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const api = require('../panel/api');
const route = require('../panel/route');
const mpool = require('../leaves/pool');
const { getModel } = require('../model/store');
const { parse } = require('../parser');

// A files navigator feeding two `detail` viewers: `v1` placed in a column,
// `v2` declared but UNplaced → it sits in the pool (hidden) at boot.
const CONFIG = `
project_dir: .
groups:
  g:
    label: G
    containers: []
    actions:
      noop: { label: noop, desc: noop, type: run, script: "true" }
panels:
  nav: { type: files, source: filesystem, root: js }
  v1: { type: detail, title: V1 }
  v2: { type: detail, title: V2 }
layout:
  columns:
    - { width: 30, panels: [nav] }
    - { panels: [ { tabs: [v1] } ] }
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-inst-life-'));
const cfgPath = path.join(dir, 'tui.yml');
fs.writeFileSync(cfgPath, CONFIG);
if (!api.getInstanceSlice('files')) api.registerComponent(require('../panel/navigator/files'));
getModel().config = parse(cfgPath);
getModel().projectDir = '.';
require('../app/state').initState();

const arrange = () => api.getInstanceSlice('layout').arrange;
const detailPaneIds = () =>
  mpool.allPanesInColumns(arrange()).filter(p => p.type === 'detail').map(p => p.paneId);

const v1 = detailPaneIds()[0];
let v2;

describe('per-pane instance lifecycle — runtime mint/dispose (v0.6.5 §5(b))', () => {
  it('boot mints only the PLACED viewer; the pooled one stays uninstantiated', () => {
    eq(detailPaneIds().length, 1, 'exactly one detail placed at boot');
    assert(route.hasInstance(v1), 'the placed viewer holds its own instance');
    assert(Object.keys(arrange().pool || {}).includes('v2'), 'v2 sits in the pool (unplaced)');
  });

  it('pool_show mints an INDEPENDENT instance (no collapse onto the kind primary)', () => {
    api.dispatchMsg(api.wrap('layout', { type: 'pool_show', id: 'v2', columnIndex: 1 }));
    v2 = detailPaneIds().find(id => id !== v1);
    assert(v2, 'v2 is now placed with its own paneId');
    assert(route.hasInstance(v2), 'v2 minted its own instance at runtime');
    const s1 = route.getInstanceSlice(v1);
    const s2 = route.getInstanceSlice(v2);
    assert(s1 && s2 && s1 !== s2, 'the two viewers hold DISTINCT slice objects');
  });

  it('pool_hide disposes the removed pane (the survivor is untouched)', () => {
    api.dispatchMsg(api.wrap('layout', { type: 'pool_hide', id: 'v2' }));
    assert(!detailPaneIds().includes(v2), 'v2 removed from the layout');
    assert(!route.hasInstance(v2), "v2's instance disposed on removal");
    assert(route.hasInstance(v1), 'the surviving viewer keeps its instance');
  });
});

report();
