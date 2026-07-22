/**
 * Content-tab mint — the U2e P1b successor to the retired test-content-tabs.js.
 *
 * The old viewer `contentTabs` facade (a per-group map on the `detail` slice, a
 * flat tab strip, addContentTab/removeContentTab index arithmetic) is GONE.
 * Opening a file / docker path now mints a real `text-view` POSITION-tab into the
 * content slot via feature/content-tab.js (which wires the hosts/feature-host
 * seam). This file pins that behaviour end-to-end at the feature-host boundary:
 *
 *   - addContentTab mints a `text-view` tab (kind 'text-view', poolId
 *     `content-<sanitized key>`) into the content slot and activates it.
 *   - Content lands via `tv_set_lines` (wholesale buffer replace) — the
 *     Loading→resolved swap the async open path relies on.
 *   - `x` on the tab → remove_tab closes it (disposes the instance, drops the
 *     tab from the slot's tabs[]). Info / Transcript are permanent.
 *
 * Booting a SEEDED content slot needs the info + text-view Components registered
 * (test-runner only auto-registers layout/detail/groups), then a real
 * parse-less initState pass (rebuildLayoutFromConfig seeds role:'content' slots
 * with the Info(active)+Transcript transient tabs).
 *
 * Run: node js/test/test-content-tab-mint.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const api = require('../panel/api');
// U2e P1b — the content slot's Info/Transcript/text-view instances only mint if
// their Components are registered (reconcilePaneInstances skips unregistered
// tab kinds); test-runner registers only layout/detail/groups.
api.registerComponent(require('../panel/info/info'));
api.registerComponent(require('../panel/text-view/text-view'));

const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const route = require('../panel/route');
const mpane = require('../leaves/wm/pane');
const loop = require('../dispatch/runtime/loop');
const cfeat = require('../panel/content-tab');
const { getInstanceSlice } = api;

const _grp = (n) => ({ name: n, label: n, containers: [], actions: {},
  children: [], parent: null, depth: 0, quick: false });

// Boot a seeded model with a content slot (the default arrange places a
// role:'content' detail slot, which rebuildLayoutFromConfig seeds).
function boot() {
  process.stdout.columns = 100;
  process.stdout.rows = 40;
  getModel().config = { project_dir: '.', theme: 'monokai', register: {},
    files: [], plugins: {}, groups: { g: _grp('g') } };
  getModel().projectDir = '.';
  getModel().currentGroup = 'g';
  initState();
}

describe('[mint] open-file → text-view position-tab', () => {
  it('addContentTab mints a text-view tab (kind, poolId) and activates it', () => {
    boot();
    const key = 'file:/tmp/mint-probe.txt';
    const poolId = cfeat._poolId(key);
    eq(poolId, 'content-file-tmp-mint-probe.txt', 'poolId derives from the sanitized key');
    const instId = mpane.newPaneId(poolId);

    cfeat.addContentTab('g', key, 'mint-probe.txt', ['line 1', 'line 2']);

    assert(route.hasInstance(instId), 'the text-view instance was minted');
    eq(route.instanceKind(instId), 'text-view', 'minted tab is kind text-view');
    eq(getInstanceSlice(instId).lines.join('\n'), 'line 1\nline 2',
      'the tab buffer holds the opened content (via tv_set_lines)');

    // The content slot activated the new tab and appended it to tabs[].
    const slotPaneId = route.resolveViewerPaneId();
    const loc = require('../leaves/wm/pool').findPaneLocation(
      getInstanceSlice('layout').arrange, p => p.paneId === slotPaneId);
    assert(loc, 'content slot resolved');
    eq(loc.pane.activeTabId, poolId, 'the minted tab is active');
    assert(loc.pane.tabs.some(t => t.poolId === poolId), 'tab present in the slot tabs[]');
    // The permanent siblings are still there (Info + Transcript + detail anchor).
    assert(loc.pane.tabs.some(t => t.poolId === `info-${slotPaneId}`), 'Info tab persists');
    assert(loc.pane.tabs.some(t => t.poolId === `transcript-${slotPaneId}`), 'Transcript tab persists');
  });

  it('re-opening the same key updates the buffer in place (no duplicate tab)', () => {
    boot();
    const key = 'file:/tmp/mint-reuse.txt';
    const poolId = cfeat._poolId(key);
    const instId = mpane.newPaneId(poolId);
    cfeat.addContentTab('g', key, 'reuse', ['v1']);
    eq(getInstanceSlice(instId).lines.join('\n'), 'v1');
    cfeat.addContentTab('g', key, 'reuse', ['v2', 'v2b']);
    // mint_tab no-ops on a poolId collision; tv_set_lines replaces the buffer.
    eq(getInstanceSlice(instId).lines.join('\n'), 'v2\nv2b', 'buffer replaced, tab reused');
    const slotPaneId = route.resolveViewerPaneId();
    const loc = require('../leaves/wm/pool').findPaneLocation(
      getInstanceSlice('layout').arrange, p => p.paneId === slotPaneId);
    const n = loc.pane.tabs.filter(t => t.poolId === poolId).length;
    eq(n, 1, 'still exactly one tab for the key');
  });

  it('updateContentTabLines on a closed tab is a silent no-op', () => {
    boot();
    // No tab minted for this key → the async-resolve path must drop silently.
    cfeat.updateContentTabLines('g', 'file:/tmp/never-opened.txt', ['ignored']);
    const instId = mpane.newPaneId(cfeat._poolId('file:/tmp/never-opened.txt'));
    assert(!route.hasInstance(instId), 'no instance created by a stray update');
  });
});

describe('[mint] closing a content tab', () => {
  it('remove_tab closes the tab, disposes its instance, and drops it from tabs[]', () => {
    boot();
    const key = 'file:/tmp/mint-close.txt';
    const poolId = cfeat._poolId(key);
    const instId = mpane.newPaneId(poolId);
    cfeat.addContentTab('g', key, 'close-me', ['x']);
    assert(route.hasInstance(instId), 'minted');

    const slotPaneId = route.resolveViewerPaneId();
    loop.dispatchMsg(route.wrap('layout',
      { type: 'remove_tab', paneId: slotPaneId, tabPoolId: poolId }));

    assert(!route.hasInstance(instId), 'instance disposed on close');
    const loc = require('../leaves/wm/pool').findPaneLocation(
      getInstanceSlice('layout').arrange, p => p.paneId === slotPaneId);
    assert(!loc.pane.tabs.some(t => t.poolId === poolId), 'tab removed from the slot');
    // The permanent siblings survive the close.
    assert(loc.pane.tabs.some(t => t.poolId === `info-${slotPaneId}`), 'Info still present');
    assert(loc.pane.tabs.some(t => t.poolId === `transcript-${slotPaneId}`),
      'Transcript still present');
  });
});

report();
