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
 * U2f — the `detail`/viewer Component is deleted, so a `detail` pane is now a
 * CONTENT SLOT (role:'content') whose runtime placement isn't yet re-seeded with
 * its Info/Transcript tabs (a documented P1b deferral in layout.js#pool_show).
 * The lifecycle invariant under test (runtime mint on placement, dispose on
 * removal, independent slices, kind resolution for a pooled pane) is orthogonal
 * to the content-slot seeding, so this test uses `text-view` — a surviving
 * ordinary single-tab multi-instance pane type — as its mint/dispose subject.
 * One `detail` slot is kept placed purely to satisfy the parser's "at least one
 * detail tab" invariant.
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
const mpool = require('../leaves/wm/pool');
const { getModel } = require('../model/store');
const { parse } = require('../parser');

// A files navigator + two `text-view` panes (the mint/dispose subjects): `v1`
// placed in a column, `v2` declared but UNplaced → it sits in the pool (hidden)
// at boot. `d` is a `detail` content slot kept placed to satisfy the parser's
// "at least one detail tab" invariant (its own seeded Info/Transcript instances
// are ignored here).
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
  d:  { type: detail, title: D }
  v1: { type: text-view, title: V1 }
  v2: { type: text-view, title: V2 }
layout:
  columns:
    - { width: 30, panels: [nav] }
    - { panels: [ { tabs: [d] }, { tabs: [v1] } ] }
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-inst-life-'));
const cfgPath = path.join(dir, 'tui.yml');
fs.writeFileSync(cfgPath, CONFIG);
if (!api.getInstanceSlice('files')) api.registerComponent(require('../panel/navigator/files'));
// U2f — register the content-slot tab kinds (info / text-view). text-view is also
// the mint/dispose subject below; reconcilePaneInstances only mints an instance
// for a tab whose Component is registered.
if (!api.getInstanceSlice('info')) api.registerComponent(require('../panel/info/info'));
if (!api.getInstanceSlice('text-view')) api.registerComponent(require('../panel/text-view/text-view'));
getModel().config = parse(cfgPath);
getModel().projectDir = '.';
require('../app/state').initState();

// U2f — a `text-view` pane is an ordinary single-tab pane (paneId === its active
// tab instance id), so the lifecycle invariants read directly off the paneId. We
// identify the text-view subjects by their resolved kind (via instanceKind, which
// resolves a placed paneId's active-tab kind and a pooled pane's declared kind
// from arrange.pool) rather than a role marker.
const arrange = () => api.getInstanceSlice('layout').arrange;
const tvPaneIds = () =>
  mpool.allPanesInColumns(arrange())
    .filter(p => route.instanceKind(p.paneId) === 'text-view')
    .map(p => p.paneId);

const v1 = tvPaneIds()[0];
let v2;

describe('per-pane instance lifecycle — runtime mint/dispose (v0.6.5 §5(b))', () => {
  it('boot mints only the PLACED pane; the pooled one stays uninstantiated', () => {
    eq(tvPaneIds().length, 1, 'exactly one text-view placed at boot');
    assert(route.hasInstance(v1), 'the placed pane holds its own instance');
    assert(Object.keys(arrange().pool || {}).includes('v2'), 'v2 sits in the pool (unplaced)');
  });

  it('a pool-only pane resolves its kind via instanceKind (§5(b3))', () => {
    assert(!route.hasInstance('v2'), 'v2 has no instance (pool-only, never placed)');
    // It is in no column either — only arrange.pool carries it. instanceKind
    // must still report its declared kind so downstream `=== "text-view"`
    // comparisons hold for a hidden pane.
    eq(route.instanceKind('v2'), 'text-view', 'instanceKind resolves the declared kind from arrange.pool');
  });

  it('pool_show mints an INDEPENDENT instance (no collapse onto the kind primary)', () => {
    api.dispatchMsg(api.wrap('layout', { type: 'pool_show', id: 'v2', columnIndex: 1 }));
    v2 = tvPaneIds().find(id => id !== v1);
    assert(v2, 'v2 is now placed with its own paneId');
    assert(route.hasInstance(v2), 'v2 minted its own instance at runtime');
    const s1 = route.getInstanceSlice(v1);
    const s2 = route.getInstanceSlice(v2);
    assert(s1 && s2 && s1 !== s2, 'the two panes hold DISTINCT slice objects');
  });

  it('pool_hide disposes the removed pane (the survivor is untouched)', () => {
    api.dispatchMsg(api.wrap('layout', { type: 'pool_hide', id: 'v2' }));
    assert(!tvPaneIds().includes(v2), 'v2 removed from the layout');
    assert(!route.hasInstance(v2), "v2's instance disposed on removal");
    assert(route.hasInstance(v1), 'the surviving pane keeps its instance');
  });
});

report();
