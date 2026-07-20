/**
 * U2c P1 — routing a tab:true action's output into a minted text-view instance.
 * See docs/one-tab-system.md. Run: node js/test/test-action-tab-route.js
 *
 * End-to-end through the real dispatch: running a tab:true `run` action mints
 * (or reuses) a text-view tab in the viewer's slot keyed by a stable hint-derived
 * poolId (tv-act-<group>-<key>), seeds its header, stamps the hint, and streams to
 * it by paneId — without stealing focus from a non-viewer pane. Re-run reuses the
 * same tab (reseed, no duplicate); a different action accretes a second tab.
 *
 * Actions run `sleep 5` (no synchronous output) so the assertions see just the
 * header; killAll tears the procs down at the end.
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const { runAction, killAll } = require('../dispatch/runtime/action-runner');
const { dispatchMsg } = require('../dispatch/runtime/loop');

const api = sm.api;
if (!api.getComponent('text-view')) api.registerComponent(require('../panel/text-view/text-view'));

const ACT = (key) => ({ key, label: key, type: 'run', script: 'sleep 5', tab: true });

function bootWithActions() {
  sm.bootFresh({
    groups: {
      g1: {
        name: 'g1', label: 'G1', containers: [], children: [], parent: null, depth: 0, quick: false,
        actions: { build: ACT('build'), test: ACT('test') },
      },
    },
  });
}

function tabCount(container) {
  const arr = route.getInstanceSlice('layout').arrange;
  for (const c of arr.columns) for (const p of c.panels) if (p.paneId === container) return (p.tabs || []).length;
  return 0;
}

describe('[action-tab] a tab:true action mints + routes to a text-view instance', () => {
  it('mints pane-tv-act-<group>-<key>, seeds the header, stamps the hint, keeps focus', () => {
    bootWithActions();
    const focusBefore = route.getFocus();
    const container = route.resolveViewerPaneId();
    assert(container, 'a viewer slot resolves');

    runAction('build', ACT('build'));

    const tvId = 'pane-tv-act-g1-build';
    const inst = route.getInstance(tvId);
    assert(inst, 'text-view instance minted at ' + tvId);
    eq(inst.kind, 'text-view', 'minted instance is a text-view');
    eq(route.getInstanceSlice(tvId).lines[0], '[dim]$ build[/]', 'stream header seeded into the instance');

    const entry = route.getInstanceSlice('layout').arrange.pool['tv-act-g1-build'];
    assert(entry && entry.hint && entry.hint.origin === 'action'
      && entry.hint.group === 'g1' && entry.hint.key === 'build', 'hint stamped on the pool entry');

    eq(route.paneTypeOf(container), 'text-view', 'the viewer slot now shows the text-view (activated)');
    // The action was run from a non-viewer pane (boot focus) → output shows without
    // stealing keyboard focus.
    if (focusBefore !== container) {
      eq(route.getFocus(), focusBefore, 'a background action run does not steal focus');
    }
    killAll({ silent: true });
  });

  it('re-run reuses the same tab (reseed, no duplicate); a different action accretes', () => {
    bootWithActions();
    const container = route.resolveViewerPaneId();

    runAction('build', ACT('build'));
    const afterFirst = tabCount(container);
    assert(afterFirst >= 1, 'the build tab was added');

    runAction('build', ACT('build'));   // re-run → same slot
    eq(tabCount(container), afterFirst, 're-run does NOT add a second tab (reuse by hint)');
    eq(route.getInstanceSlice('pane-tv-act-g1-build').lines.length, 1,
       're-run reseeds the instance to just the header (killJob footer + reseed cleared)');

    runAction('test', ACT('test'));     // different action → new tab (now the active one)
    eq(tabCount(container), afterFirst + 1, 'a different action accretes a second tab');
    assert(route.getInstance('pane-tv-act-g1-test'), 'distinct instance for the second action');
    assert(route.getInstance('pane-tv-act-g1-build'), 'the build instance persists alongside test (accrete)');

    // Off-tab streaming: build is no longer the slot's active tab (test is), yet a
    // streamed line addressed to its distinct instance id still lands (no R2
    // collision — the mechanism P1 relies on for background output).
    eq(route.paneTypeOf(container), 'text-view', 'test is the active tab');
    const before = route.getInstanceSlice('pane-tv-act-g1-build').lines.length;
    dispatchMsg(route.wrap('pane-tv-act-g1-build', { type: 'tv_append', line: 'off-tab line' }));
    eq(route.getInstanceSlice('pane-tv-act-g1-build').lines.length, before + 1,
       'a tv_append to the NON-active build instance lands in its own slice');
    killAll({ silent: true });
  });
});

setTimeout(() => report(), 200);
