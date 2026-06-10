/**
 * v0.6.1 Phase 0 — tab-instance registry sanity.
 *
 * Pins the surface added in Phase 0 (empty registry, set / get / has /
 * dispose / kind / each). The registry stays empty in production until
 * Phase 4 starts populating; this test only exercises the data shape.
 *
 *   node js/test/test-instance-registry.js
 */
'use strict';

const route = require('../panel/route');
const api = require('../panel/api');
const { describe, it, assert, eq, report } = require('./test-runner');

// Helper — wipe any state a prior test left behind (defensive, the runner
// shares process state across files).
function resetRegistry() {
  route.eachInstance((inst) => route.disposeInstance(inst.id));
}

describe('[v0.6.1 Phase 0] tab-instance registry', () => {
  it('empty registry returns undefined / null / false', () => {
    resetRegistry();
    assert(route.getInstance('nope') === undefined, 'getInstance undefined');
    assert(route.getInstanceSlice('nope') === undefined, 'getInstanceSlice undefined');
    assert(route.hasInstance('nope') === false, 'hasInstance false');
    assert(route.instanceKind('nope') === null, 'instanceKind null');
  });

  it('setInstance populates id/kind/slice; getters read back', () => {
    resetRegistry();
    route.setInstance('t1', 'detail', { lines: ['hello'], tab: 0 });
    assert(route.hasInstance('t1') === true, 'has');
    eq(route.instanceKind('t1'), 'detail', 'kind');
    const inst = route.getInstance('t1');
    eq(inst.id, 't1', 'inst.id');
    eq(inst.kind, 'detail', 'inst.kind');
    eq(inst.slice.lines[0], 'hello', 'inst.slice');
    eq(route.getInstanceSlice('t1').lines[0], 'hello', 'getInstanceSlice');
  });

  it('setInstanceSlice mutates only the slice field', () => {
    resetRegistry();
    route.setInstance('t2', 'groups', { list: [] });
    route.setInstanceSlice('t2', { list: ['a', 'b'] });
    eq(route.instanceKind('t2'), 'groups', 'kind unchanged');
    eq(route.getInstanceSlice('t2').list.length, 2, 'slice updated');
  });

  it('setInstanceSlice on a missing id is a silent no-op', () => {
    resetRegistry();
    route.setInstanceSlice('ghost', { x: 1 });
    assert(route.hasInstance('ghost') === false, 'still missing');
  });

  it('disposeInstance clears entry', () => {
    resetRegistry();
    route.setInstance('t3', 'files', { cwd: '.' });
    assert(route.hasInstance('t3') === true, 'present');
    route.disposeInstance('t3');
    assert(route.hasInstance('t3') === false, 'gone');
    assert(route.instanceKind('t3') === null, 'kind null after dispose');
  });

  it('eachInstance iterates in insertion order', () => {
    resetRegistry();
    route.setInstance('a', 'detail', {});
    route.setInstance('b', 'groups', {});
    route.setInstance('c', 'files', {});
    const seen = [];
    route.eachInstance((inst) => seen.push(inst.id));
    eq(seen.join(','), 'a,b,c', 'order preserved');
  });

  it('panel/api re-exports the same registry surface', () => {
    resetRegistry();
    api.setInstance('via-api', 'history', { entries: [] });
    assert(route.hasInstance('via-api') === true, 'route sees api write');
    eq(api.instanceKind('via-api'), 'history', 'kind via api');
    api.disposeInstance('via-api');
    assert(api.hasInstance('via-api') === false, 'dispose via api');
  });

  it('registry is independent of the legacy name-keyed slice store', () => {
    // Phase 0 invariant: instance registry must not interfere with the
    // existing getInstanceSlice('name') path. Setting an instance with
    // id === some-component-name does NOT collide with the slice store.
    resetRegistry();
    route.setInstance('detail', 'detail', { fromInstance: true });
    // No expectation about getInstanceSlice('detail') here — it lives
    // in a separate map. Just confirm the two are not aliased.
    const inst = route.getInstanceSlice('detail');
    eq(inst.fromInstance, true, 'instance slice intact');
    route.disposeInstance('detail');
  });
});

describe('[v0.6.4 Theme A Phase 1] focused-instance key routing', () => {
  // dispatchKeyToFocused must route the keystroke to the FOCUSED
  // instance, not the kind's PRIMARY. Pre-fix it used
  // getPrimaryByKind(compName) unconditionally, so with two same-kind
  // panes the key always hit the first one regardless of focus.
  it('two same-kind panes: the key lands on the FOCUSED pane, not the primary', () => {
    resetRegistry();
    // layout must register first (the focus reader needs a slice).
    api.registerComponent({ name: 'layout', init: () => ({ focus: null }), update: (m, s) => s });
    // A stub Navigator-ish Component owning panelType 'probe'; its
    // update stamps the key it received onto the slice.
    api.registerComponent({
      name: 'probe',
      // panelType needs render() or registerComponent skips the owner
      // mapping (componentForPanel would then miss).
      panelTypes: { probe: { render: () => [], getItems: () => [] } },
      init: () => ({ gotKey: null }),
      update: (msg, slice) => (msg.type === 'key' ? [{ ...slice, gotKey: msg.key }, []] : slice),
    });
    // Two instances of kind 'probe' in distinct slots; pane-a is primary
    // (minted first), pane-b is the one we focus. Drop the singleton
    // registerComponent minted so the primary is genuinely pane-a.
    route.disposeInstance('probe');
    route.setInstance('pane-a', 'probe', { gotKey: null });
    route.setInstance('pane-b', 'probe', { gotKey: null });
    eq(route.getPrimaryByKind('probe'), 'pane-a', 'pane-a is the primary');

    // Focus the NON-primary pane, then dispatch a key.
    route.setInstanceSlice('layout', { focus: 'pane-b' });
    const claimed = api.dispatchKeyToFocused('x', 'x');

    assert(claimed === false, 'stub did not claim (no _claimed sentinel)');
    eq(route.getInstanceSlice('pane-b').gotKey, 'x', 'FOCUSED pane-b received the key');
    assert(route.getInstanceSlice('pane-a').gotKey === null,
      'primary pane-a did NOT receive it (pre-fix it would have)');

    route.disposeInstance('pane-a');
    route.disposeInstance('pane-b');
  });
});

report();
