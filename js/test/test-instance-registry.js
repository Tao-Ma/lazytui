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
// shares process state across files). Full registry wipe: an
// eachInstance+dispose loop can't remove service slots (dispose refuses),
// so a stub 'layout' service would leak across cases.
function resetRegistry() {
  route._resetRegistryForTest();
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
    // U2f — `kind` here is an opaque registry label (never resolved to a
    // Component); reparam'd off the deleted `detail` kind to the surviving
    // content-slot kind `info`.
    route.setInstance('t1', 'info', { lines: ['hello'], scroll: 0 });
    assert(route.hasInstance('t1') === true, 'has');
    eq(route.instanceKind('t1'), 'info', 'kind');
    const inst = route.getInstance('t1');
    eq(inst.id, 't1', 'inst.id');
    eq(inst.kind, 'info', 'inst.kind');
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
    route.setInstance('a', 'info', {});
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
    // U2f — id/kind reparam'd off the deleted `detail` kind to `info`.
    resetRegistry();
    route.setInstance('info', 'info', { fromInstance: true });
    // No expectation about getInstanceSlice('info') here — it lives
    // in a separate map. Just confirm the two are not aliased.
    const inst = route.getInstanceSlice('info');
    eq(inst.fromInstance, true, 'instance slice intact');
    route.disposeInstance('info');
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
  const mnav = require('../leaves/wm/nav');

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
    const dispatch = require('../dispatch/control/dispatch');
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
    const dispatch = require('../dispatch/control/dispatch');
    // Simulate the modal as if pane-b (the non-primary) is being filtered:
    // _enterFilterMode seeds modal.filter.panel with the focused PANEID.
    // blessed-A — the handler stamps msg.route; filter_key/exit reuse the
    // session bundle stored at enter, so only filter_enter needs it threaded.
    dispatch.applyMsg({ type: 'filter_enter', panel: 'pane-b', text: 'lph', route: route.bundle('pane-b') });
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

// v0.6.4 multi-viewer — two content-slot instances are independent.
// U2f — the `detail`/viewer Component is deleted; the content slot's scrollable
// text pane is now the `info` kind (a near-clone of the viewer's Info tab,
// sharing the tvu interaction reducer). Drives the REAL info Component
// (init/update) rather than a stub, so the Phase-0 keystone (slice.paneId
// self-identity + per-pane writes) and Phase-1 scroll dispatch are both
// exercised — two content slots ⇒ two independent info instances.
describe('[v0.6.4 multi-viewer] two content-slot instances scroll independently', () => {
  const info = require('../panel/info/info');

  function setupTwoViewers() {
    resetRegistry();
    // Mint two info instances the way state.js does: init(paneId).
    route.setInstance('pane-left',  'info', info.init('pane-left'));
    route.setInstance('pane-right', 'info', info.init('pane-right'));
    // Seed each with content + a viewport so viewer_scroll has room. U2f — the
    // content instances store their buffer on `slice.lines` (the retired
    // `infoLines` field is gone).
    route.setInstanceSlice('pane-left',  { ...route.getInstanceSlice('pane-left'),
      lines: Array.from({ length: 50 }, (_, i) => `L${i}`), innerH: 10 });
    route.setInstanceSlice('pane-right', { ...route.getInstanceSlice('pane-right'),
      lines: Array.from({ length: 50 }, (_, i) => `R${i}`), innerH: 10 });
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

  it('render writes NO tabBounds (pure view); the slot strip recomputes per-pane', () => {
    // v0.6.4 blessed-exceptions tabBounds follow-on — the render-side
    // slice.tabBounds WRITE is retired. render() is a pure view. U2f — the
    // viewer's own `tabBoundsFor(slice, ...)` is gone with the viewer; the
    // surviving on-demand recompute is `slot-strip.unifiedSlotStrip(pane)`,
    // which derives the tab-strip hit-test bounds from the pane's `tabs[]`
    // (input.js drives it on a top-border click).
    setupTwoViewers();
    const paneRight = { paneId: 'pane-right', type: 'info', hotkey: 'o', title: 'Info' };
    // Invoke the panel def render the way paint.js does — it must NOT mutate
    // the slice (teeth: this fails against the pre-follow-on write).
    info.panelTypes.info.render(paneRight, 40, 12, route.getInstanceSlice('pane-right'), { focused: true });
    assert(route.getInstanceSlice('pane-right').tabBounds === undefined,
      'render did not write tabBounds onto the slice');
    assert(route.getInstanceSlice('pane-left').tabBounds === undefined,
      'render did not write tabBounds onto any sibling slice');
    // On-demand recompute returns a bounds array per pane (a multi-tab slot).
    const ss = require('../panel/slot-strip');
    const mkMultiTab = (paneId, hotkey) => ({
      paneId, type: 'info', hotkey, activeTabId: `info-${paneId}`,
      tabs: [{ poolId: `info-${paneId}` }, { poolId: `transcript-${paneId}` }],
    });
    const rb = ss.unifiedSlotStrip(mkMultiTab('pane-right', 'o'));
    const lb = ss.unifiedSlotStrip(mkMultiTab('pane-left',  'p'));
    assert(rb && Array.isArray(rb.tabBounds) && lb && Array.isArray(lb.tabBounds),
      'unifiedSlotStrip computes per-pane tab-strip bounds on demand');
  });
});

// _primaryByKind split arc P0 — service slots. A SERVICE is the
// kind-global instance registerComponent mints for chrome Components
// (no panelTypes) and `service: true` opt-ins (docker's content owner).
// It lives inside _instances (broadcast + dispatch reach it unchanged)
// but is undisposable and unoverwritable.
describe('[service slots] kind-global instances are undisposable', () => {
  it('setService registers a visible instance + the direct handle', () => {
    resetRegistry();
    route.setService('svc', { v: 1 });
    assert(route.hasInstance('svc'), 'visible via hasInstance');
    eq(route.getInstanceSlice('svc').v, 1, 'readable via getInstanceSlice (id read)');
    eq(route.serviceSlice('svc').v, 1, 'readable via serviceSlice');
    assert(route.isService('svc'), 'marked as service');
    eq(route.getPrimaryByKind('svc'), 'svc', 'seeds the kind primary (dispatch fallback)');
    assert(route.serviceSlice('nope') === undefined, 'unknown kind → undefined');
  });

  it('chrome Components (no panelTypes) auto-register as services', () => {
    resetRegistry();
    api.registerComponent({ name: 'layout', init: () => ({ focus: null }), update: (m, s) => s });
    assert(route.isService('layout'), 'chrome Component is a service');
  });

  it('disposeInstance refuses a service slot', () => {
    resetRegistry();
    route.setService('svc', { v: 1 });
    route.disposeInstance('svc');   // logs a refusal, no-op
    assert(route.hasInstance('svc'), 'still present');
    eq(route.serviceSlice('svc').v, 1, 'slice intact');
  });

  it('setInstance refuses to overwrite a service slot', () => {
    resetRegistry();
    route.setService('svc', { v: 1 });
    route.setInstance('svc', 'svc', { v: 'clobbered' });   // logs a refusal, no-op
    eq(route.serviceSlice('svc').v, 1, 'slice not clobbered');
    assert(route.isService('svc'), 'still a service');
  });

  it('setInstanceSlice still WRITES a service slice (dispatch write-back path)', () => {
    resetRegistry();
    route.setService('svc', { v: 1 });
    route.setInstanceSlice('svc', { v: 2 });
    eq(route.serviceSlice('svc').v, 2, 'update applied');
    assert(route.isService('svc'), 'service marker survives');
  });

  it('broadcast fan-out reaches a service Component', () => {
    resetRegistry();
    api.registerComponent({ name: 'layout', init: () => ({ focus: null }), update: (m, s) => s });
    api.registerComponent({
      name: 'svc-comp',
      service: true,
      panelTypes: { 'svc-panel': { render: () => [] } },
      init: () => ({ refreshed: false }),
      update: (msg, slice) => (msg.type === 'refresh' ? { ...slice, refreshed: true } : slice),
    });
    assert(route.isService('svc-comp'), 'service: true opt-in honored despite panelTypes');
    api.dispatchMsg({ type: 'refresh' });
    eq(route.getInstanceSlice('svc-comp').refreshed, true, 'refresh reached the service');
    let seen = false;
    route.eachInstance((inst) => { if (inst.id === 'svc-comp') seen = true; });
    assert(seen, 'eachInstance iterates the service');
  });

  it('re-registration updates the service slice in place (wrapper identity preserved)', () => {
    resetRegistry();
    route.setService('svc', { v: 1 });
    const wrapper = route.getInstance('svc');
    route.setService('svc', { v: 2 });
    assert(route.getInstance('svc') === wrapper, 'same wrapper object');
    eq(route.serviceSlice('svc').v, 2, 'fresh slice');
  });
});

// _primaryByKind split arc P1 — primarySliceOf is the ONLY sanctioned
// kind-name slice read (callers declare kind-level intent); paneId
// reads go through getInstanceSlice/sliceForPane.
describe('[primarySliceOf] explicit kind-level slice read', () => {
  it('resolves the kind primary (first-registered instance)', () => {
    resetRegistry();
    route.setInstance('pane-a', 'pk', { v: 'a' });
    route.setInstance('pane-b', 'pk', { v: 'b' });
    eq(route.primarySliceOf('pk').v, 'a', 'primary = first registered');
    assert(route.primarySliceOf('nope') === undefined, 'unknown kind → undefined');
  });

  it('follows successor promotion after the primary is disposed', () => {
    resetRegistry();
    route.setInstance('pane-a', 'pk', { v: 'a' });
    route.setInstance('pane-b', 'pk', { v: 'b' });
    route.disposeInstance('pane-a');
    eq(route.primarySliceOf('pk').v, 'b', 'promoted successor resolves');
    route.disposeInstance('pane-b');
    assert(route.primarySliceOf('pk') === undefined, 'no instances → undefined');
  });

  it('resolves service kinds (setService seeds the primary)', () => {
    resetRegistry();
    route.setService('svc', { v: 1 });
    eq(route.primarySliceOf('svc').v, 1, 'service resolves via primary too');
  });
});

// _primaryByKind split arc P2 — get/setInstanceSlice are STRICT
// (instance ids only). The v0.6.3 Phase-B kind-name fallback is
// deleted: a kind-name read/write resolves nothing instead of
// silently collapsing onto the primary pane.
describe('[strict resolution] kind-name ids no longer resolve', () => {
  it('kind-name READ of a multi-instance kind returns undefined', () => {
    resetRegistry();
    route.setInstance('pane-a', 'sk', { v: 'a' });
    route.setInstance('pane-b', 'sk', { v: 'b' });
    assert(route.getInstanceSlice('sk') === undefined, 'no collapse onto the primary');
    eq(route.getInstanceSlice('pane-a').v, 'a', 'paneId reads unaffected');
  });

  it('kind-name WRITE mutates neither pane', () => {
    resetRegistry();
    route.setInstance('pane-a', 'sk', { v: 'a' });
    route.setInstance('pane-b', 'sk', { v: 'b' });
    route.setInstanceSlice('sk', { v: 'clobber' });
    eq(route.getInstanceSlice('pane-a').v, 'a', 'primary untouched');
    eq(route.getInstanceSlice('pane-b').v, 'b', 'sibling untouched');
  });

  it('disposed singleton: id read misses while primarySliceOf resolves the promoted pane', () => {
    resetRegistry();
    route.setInstance('sk', 'sk', { v: 'seed' });        // register-time-style seed
    route.setInstance('pane-a', 'sk', { v: 'pane' });
    route.disposeInstance('sk');                         // initState-style swap
    assert(route.getInstanceSlice('sk') === undefined, 'kind-name id read misses post-swap');
    eq(route.primarySliceOf('sk').v, 'pane', 'explicit kind-level read resolves the pane');
  });

  it('service ids still read directly (they ARE instance ids)', () => {
    resetRegistry();
    route.setService('svc', { v: 1 });
    eq(route.getInstanceSlice('svc').v, 1, 'id === Component name → direct hit');
  });

  // Build a P1b content SLOT fixture the way state.reconcilePaneInstances does:
  // one pane carries the `detail` anchor + seeded info/transcript sibling tabs,
  // its `role` is 'content' (P1a), its ACTIVE tab is `info`, and the
  // active-instance map diverts the slot paneId → the info instance. `pool`
  // carries per-tab entry shape (info kind / transcript hint) so the intent-aware
  // resolveTarget can pick a sibling. Returns the arrange for the layout slice.
  function seedContentSlot(paneId) {
    const info = `info-${paneId}`;
    const trans = `transcript-${paneId}`;
    route.setInstance(paneId, 'detail', { v: `anchor:${paneId}` });        // hidden anchor
    route.setInstance(`pane-${info}`, 'info', { v: `info:${paneId}` });    // ACTIVE
    route.setInstance(`pane-${trans}`, 'text-view', { v: `transcript:${paneId}` });
    return {
      pane: {
        id: 'detail', paneId, type: 'info', role: 'content', activeTabId: info,
        tabs: [{ poolId: paneId }, { poolId: info }, { poolId: trans }],
      },
      pool: {
        [paneId]: { id: paneId, type: 'detail' },
        [info]: { id: info, type: 'info' },
        [trans]: { id: trans, type: 'text-view', hint: 'transcript' },
      },
      activeMap: { [paneId]: `pane-${info}` },
    };
  }

  it('resolveTarget arrange-walk returns the content slot ACTIVE instance, not the tab/pool id', () => {
    // Regression — split-arc P2 follow-up, updated for U2e P1b. Tier 3 (arrange
    // walk) used to return the viewer TAB id ('detail'); the mounted instance is
    // keyed under a pane-<poolId> id and only the deleted kind-name fallback
    // bridged the gap. Every `getInstanceSlice(resolveTarget('viewer'))` read
    // (footer/select/copy) returned undefined with the viewer unfocused.
    // P1b: the slot's default active tab is now `info`, resolved via role
    // ('content'), so resolveTarget('viewer') returns the ACTIVE info instance
    // (pane-info-pane-detail) — still a mounted id, still strict-readable.
    resetRegistry();
    api.registerComponent({
      name: 'layout',
      init: () => ({ focus: null, lastViewerTab: null, arrange: null }),
      update: (m, s) => s,
    });
    for (const kind of ['detail', 'info', 'text-view']) {
      api.registerComponent({
        name: kind,
        panelTypes: { [kind]: { render: () => [] } },
        init: () => ({}),
        update: (m, s) => s,
      });
      route.disposeInstance(kind);   // initState-style swap: seed disposed, minted per-pane
    }
    const slot = seedContentSlot('pane-detail');
    route.setActiveInstanceMap(slot.activeMap);
    // Viewer unfocused + no sticky lastViewerTab → tier 3 (arrange walk) fires;
    // the slot is found by role==='content'.
    route.setInstanceSlice('layout', {
      focus: 'pane-groups', lastViewerTab: null,
      arrange: { columns: [{ panels: [slot.pane] }], pool: slot.pool },
    });
    eq(route.resolveTarget('viewer'), 'pane-info-pane-detail',
      'active (info) instance id, not the tab/pool id');
    eq(route.getInstanceSlice(route.resolveTarget('viewer')).v, 'info:pane-detail',
      'strict read resolves the active info instance');
    // Intent-aware siblings resolve to their own mounted instances.
    eq(route.resolveTarget('viewer_info'), 'pane-info-pane-detail', 'viewer_info → info sibling');
    eq(route.resolveTarget('viewer_transcript'), 'pane-transcript-pane-detail',
      'viewer_transcript → transcript (hint) sibling');
  });

  it('multi-viewer: two content slots each resolve their OWN active instance', () => {
    // Two role==='content' slots. resolveTarget follows the focus → sticky →
    // arrange-order tiers to pick the SLOT, then diverts to that slot's active
    // instance — so focusing one slot resolves its own info instance, not the
    // other's.
    resetRegistry();
    api.registerComponent({
      name: 'layout',
      init: () => ({ focus: null, lastViewerTab: null, arrange: null }),
      update: (m, s) => s,
    });
    for (const kind of ['detail', 'info', 'text-view']) {
      api.registerComponent({
        name: kind,
        panelTypes: { [kind]: { render: () => [] } },
        init: () => ({}),
        update: (m, s) => s,
      });
      route.disposeInstance(kind);
    }
    const left = seedContentSlot('pane-left');
    const right = seedContentSlot('pane-right');
    route.setActiveInstanceMap({ ...left.activeMap, ...right.activeMap });
    const arrange = {
      columns: [{ panels: [left.pane] }, { panels: [right.pane] }],
      pool: { ...left.pool, ...right.pool },
    };
    // Focus the LEFT content slot → its own active info instance.
    route.setInstanceSlice('layout', { focus: 'pane-left', lastViewerTab: null, arrange });
    eq(route.resolveTarget('viewer'), 'pane-info-pane-left', 'left slot resolves its own info');
    // Focus the RIGHT content slot → the OTHER slot's active info instance.
    route.setInstanceSlice('layout', { focus: 'pane-right', lastViewerTab: null, arrange });
    eq(route.resolveTarget('viewer'), 'pane-info-pane-right', 'right slot resolves its own info');
  });
});

report();
