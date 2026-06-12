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

describe('[v0.6.4 Theme A Phase 5] per-pane nav READS', () => {
  // Phase 1 proved the key WRITE lands on the focused instance. Phase 5
  // closes the READ path: getSel/getScroll/getFilter/isMultiSel/getItems
  // must read THIS pane's own slice when handed a paneId, not collapse
  // every same-kind pane onto the kind's primary. Two same-kind panes
  // ⇒ two independent cursors/scrolls/filters/selections.
  const state = require('../app/state');
  const mnav = require('../leaves/nav');

  function setupTwoPanes() {
    resetRegistry();
    api.registerComponent({ name: 'layout', init: () => ({ focus: null }), update: (m, s) => s });
    // Single-panel Navigator owning panelType 'p5'. Its update delegates
    // nav Msgs to the nav leaf (the real navigator contract) and exposes
    // a filterable item list so getItems() exercises the per-pane filter.
    api.registerComponent({
      name: 'p5',
      panelTypes: {
        p5: {
          render: () => [],
          getItems: (slice) => slice.rows,
          filterable: true,
          filterText: (it) => it,
        },
      },
      init: () => ({ nav: mnav.init(), rows: ['alpha', 'beta', 'gamma'] }),
      update: (msg, slice) => {
        const navd = mnav.apply(slice, msg);
        return navd !== undefined ? navd : slice;
      },
    });
    // Drop the kind-keyed singleton registerComponent minted so the two
    // placed panes are the only instances; pane-a is primary.
    route.disposeInstance('p5');
    route.setInstance('pane-a', 'p5', { nav: mnav.init(), rows: ['alpha', 'beta', 'gamma'] });
    route.setInstance('pane-b', 'p5', { nav: mnav.init(), rows: ['alpha', 'beta', 'gamma'] });
  }

  it('cursor is independent per pane (was: both read the primary)', () => {
    setupTwoPanes();
    state.setSel('pane-a', 2);
    state.setSel('pane-b', 0);
    eq(state.getSel('pane-a'), 2, 'pane-a cursor = 2');
    eq(state.getSel('pane-b'), 0, 'pane-b cursor = 0 (NOT pane-a\'s 2)');
    // And the reverse, to prove neither aliases the primary.
    state.setSel('pane-b', 1);
    eq(state.getSel('pane-a'), 2, 'pane-a unchanged by pane-b write');
    eq(state.getSel('pane-b'), 1, 'pane-b cursor = 1');
  });

  it('scroll is independent per pane', () => {
    setupTwoPanes();
    state.setScroll('pane-a', 5);
    eq(state.getScroll('pane-a'), 5, 'pane-a scroll = 5');
    eq(state.getScroll('pane-b'), 0, 'pane-b scroll = 0');
  });

  it('multiSel set is independent per pane', () => {
    setupTwoPanes();
    state.toggleMultiSel('pane-a', 'alpha');
    state.toggleMultiSel('pane-a', 'beta');
    state.toggleMultiSel('pane-b', 'gamma');
    eq(state.multiSelCount('pane-a'), 2, 'pane-a has 2 selected');
    eq(state.multiSelCount('pane-b'), 1, 'pane-b has 1 selected');
    assert(state.isMultiSel('pane-a', 'alpha'), 'pane-a has alpha');
    assert(!state.isMultiSel('pane-b', 'alpha'), 'pane-b does NOT have alpha');
  });

  it('multiSel WRITE via the dispatch path lands on the focused pane, not the primary', () => {
    // Regression (v0.6.4 pre-release review, HIGH-1): toggleMultiSelOnFocused
    // wrapped the Msg under the Component NAME, which dispatchMsg resolves to
    // the kind's PRIMARY instance — so a multi-select toggle in the
    // non-primary pane wrote to pane-a's Set while the focused pane showed
    // nothing. The fix routes the wrap target on the focused paneId (mirrors
    // nav_select). Same class of fix covers selectAllVisible + the escape /
    // list_select multisel_clear arms.
    setupTwoPanes();
    const dispatch = require('../dispatch/dispatch');
    // Focus the NON-primary pane (pane-a is primary; pane-b is the trap).
    route.setInstanceSlice('layout', { focus: 'pane-b' });
    state.setSel('pane-b', 0);                       // cursor on 'alpha'
    dispatch._toggleMultiSelOnFocused();
    eq(state.multiSelCount('pane-b'), 1, 'focused pane-b got the selection');
    assert(state.isMultiSel('pane-b', 'alpha'), 'pane-b holds the toggled id');
    eq(state.multiSelCount('pane-a'), 0, 'primary pane-a did NOT get it (was the bug)');
  });

  it('committed filter + filtered getItems are independent per pane', () => {
    setupTwoPanes();
    // Commit a filter on pane-a only (set_filter routed to its instance).
    api.dispatchMsg(api.wrap('pane-a', { type: 'set_filter', panel: 'p5', text: 'a' }));
    eq(api.getFilter('pane-a'), 'a', 'pane-a filter committed');
    eq(api.getFilter('pane-b'), '', 'pane-b filter still empty');
    // getItems applies the per-pane committed filter: 'a' matches
    // alpha/beta/gamma (all contain "a"); use a tighter filter to prove it.
    api.dispatchMsg(api.wrap('pane-a', { type: 'set_filter', panel: 'p5', text: 'lph' }));
    eq(api.getItems('pane-a').join(','), 'alpha', 'pane-a items filtered to alpha');
    eq(api.getItems('pane-b').join(','), 'alpha,beta,gamma', 'pane-b items unfiltered');
  });

  it('filter MODAL (enter→commit) lands on the focused pane, not the primary', () => {
    setupTwoPanes();
    const dispatch = require('../dispatch/dispatch');
    // Simulate the modal as if pane-b (the non-primary) is being filtered:
    // _enterFilterMode seeds modal.filter.panel with the focused PANEID.
    dispatch.applyMsg({ type: 'filter_enter', panel: 'pane-b', text: 'lph' });
    // Live draft renders in pane-b only (getFilter compares paneId).
    eq(api.getFilter('pane-b'), 'lph', 'live draft shows in the filtered pane-b');
    eq(api.getFilter('pane-a'), '', 'pane-a shows no draft (not the filtered pane)');
    // Commit: the filter writes to pane-b's nav slice, NOT pane-a.
    dispatch.applyMsg({ type: 'filter_exit', keep: true });
    eq(api.getFilter('pane-b'), 'lph', 'committed filter on pane-b');
    eq(api.getFilter('pane-a'), '', 'pane-a uncommitted (pre-fix it took the write)');
  });

  it('the primary fallback still serves a kind-name read (legacy callers)', () => {
    setupTwoPanes();
    state.setSel('pane-a', 2);   // pane-a is the primary for kind p5
    // A legacy caller passing the kind/Component name resolves to primary.
    eq(state.getSel('p5'), 2, 'getSel(kind) falls back to the primary pane-a');
  });
});

// v0.6.4 multi-viewer — two `detail` (viewer) instances are independent.
// Drives the REAL viewer Component (init/update) rather than a stub, so
// the Phase-0 keystone (slice.paneId self-identity + per-pane writes) and
// Phase-1 scroll dispatch are both exercised.
describe('[v0.6.4 multi-viewer] two detail instances scroll independently', () => {
  const viewer = require('../panel/viewer/viewer');

  function setupTwoViewers() {
    resetRegistry();
    // Mint two viewer instances the way state.js does: init(paneId).
    route.setInstance('pane-left',  'detail', viewer._init('pane-left'));
    route.setInstance('pane-right', 'detail', viewer._init('pane-right'));
    // Seed each with content + a viewport so viewer_scroll has room.
    route.setInstanceSlice('pane-left',  { ...route.getInstanceSlice('pane-left'),
      infoLines: Array.from({ length: 50 }, (_, i) => `L${i}`), innerH: 10 });
    route.setInstanceSlice('pane-right', { ...route.getInstanceSlice('pane-right'),
      infoLines: Array.from({ length: 50 }, (_, i) => `R${i}`), innerH: 10 });
  }

  it('each instance self-identifies (Phase 0 keystone)', () => {
    setupTwoViewers();
    eq(route.getInstanceSlice('pane-left').paneId,  'pane-left');
    eq(route.getInstanceSlice('pane-right').paneId, 'pane-right');
  });

  it('viewer_scroll routed to one pane leaves the other at 0', () => {
    setupTwoViewers();
    // Dispatch through the wrapped-Msg path, addressed by paneId.
    api.dispatchMsg(route.wrap('pane-left', { type: 'viewer_scroll', delta: 5 }));
    eq(route.getInstanceSlice('pane-left').scroll, 5, 'left scrolled');
    eq(route.getInstanceSlice('pane-right').scroll, 0, 'right untouched');
    // And the reverse — right scrolls without disturbing left.
    api.dispatchMsg(route.wrap('pane-right', { type: 'viewer_scroll', delta: 3 }));
    eq(route.getInstanceSlice('pane-right').scroll, 3, 'right scrolled');
    eq(route.getInstanceSlice('pane-left').scroll, 5, 'left still at its own offset');
  });

  it('detailTitle writes tabBounds to the rendering pane`s OWN slice', () => {
    setupTwoViewers();
    // render() threads panel.paneId → detailTitle writes via slice.paneId,
    // not the hardcoded primary. Render pane-right; pane-left`s tabBounds
    // must not be the write target.
    const paneRight = { paneId: 'pane-right', type: 'detail', hotkey: 'o', tabs: [] };
    viewer._update;  // (no-op ref to keep the Component loaded)
    // Invoke the panel def render the way paint.js does.
    viewer.panelTypes.detail.render(paneRight, 40, 12, route.getInstanceSlice('pane-right'), { focused: true });
    const right = route.getInstanceSlice('pane-right');
    assert(Array.isArray(right.tabBounds), 'pane-right got its tabBounds written');
    // pane-left was never rendered → no tabBounds clobber from pane-right.
    const left = route.getInstanceSlice('pane-left');
    assert(left.tabBounds === undefined || left.tabBounds.length === 0,
      'pane-left tabBounds untouched by pane-right render');
  });
});

report();
