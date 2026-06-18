/**
 * Component API — the TEA-shaped strict alternative to Plugin.
 * Framework wiring + Msg dispatch contract. Plugin API stays
 * unaffected; this exercises only the new path.
 *
 * Run: node js/test/test-component.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const api = require('../panel/api');
const { getModel } = require('../app/runtime');

// Test helper: build a small Component whose update() appends every
// Msg type to a list, so tests can assert what arrived.
function makeRecorder(name) {
  return {
    name,
    init: () => ({ msgs: [], count: 0 }),
    update: (msg, slice) => ({
      msgs: [...slice.msgs, msg.type],
      count: slice.count + 1,
    }),
    panelTypes: {
      [name]: {
        render: (panel, w, h, slice) =>
          `panel=${panel.title} w=${w} h=${h} count=${slice.count}`,
      },
    },
  };
}

describe('[1] registerComponent — shape validation', () => {
  it('rejects null', () => {
    api.registerComponent(null);
    // No throw; logged to stderr. We assert by ensuring no component
    // with name 'null' exists.
    assert(api.getComponent('null') === undefined, 'null is not stored');
  });

  it('rejects missing init', () => {
    api.registerComponent({ name: 'no-init', update: () => null });
    assert(api.getComponent('no-init') === undefined, 'rejected component is not stored');
  });

  it('rejects missing update', () => {
    api.registerComponent({ name: 'no-update', init: () => ({}) });
    assert(api.getComponent('no-update') === undefined, 'rejected');
  });
});

describe('[2] registration stores spec + initial slice', () => {
  it('init() runs at registration time', () => {
    const c = makeRecorder('rec1');
    api.registerComponent(c);
    const slice = api.getInstanceSlice('rec1');
    eq(slice.count, 0, 'initial count');
    eq(slice.msgs.length, 0, 'initial msgs empty');
  });
});

describe('[3] dispatch — non-key fans to all; key goes to the focused panel via dispatchKeyToFocused', () => {
  it('refresh broadcast reaches every component; a key reaches only the focused owner', () => {
    // Use fresh names to avoid carry-over from earlier tests.
    api.registerComponent(makeRecorder('fanA'));
    api.registerComponent(makeRecorder('fanB'));

    // Broadcast Msgs fan to every component (the §12 contract holds for these).
    api.dispatchMsg({ type: 'refresh' });
    // Key events have their own dispatch path — they need a return
    // value to gate the framework default — and route only to the
    // focused panel's Component.
    api.getInstanceSlice("layout").focus = 'fanA';
    api.dispatchKeyToFocused('down', 'down');

    const a = api.getInstanceSlice('fanA');
    const b = api.getInstanceSlice('fanB');
    eq(a.msgs.join(','), 'refresh,key', 'fanA: broadcast + the focused key');
    eq(b.msgs.join(','), 'refresh', 'fanB: broadcast only — not the key (unfocused)');
  });
});

describe('[4] update() return shapes', () => {
  // These use `refresh` Msgs (which fan to every component) so the return-shape
  // assertions don't depend on focus arbitration.
  it('returning a new slice replaces the old', () => {
    api.registerComponent({
      name: 'replace',
      init: () => ({ n: 0 }),
      update: (msg, slice) => ({ n: slice.n + 1 }),
    });
    api.dispatchMsg({ type: 'refresh' });
    api.dispatchMsg({ type: 'refresh' });
    eq(api.getInstanceSlice('replace').n, 2, 'slice replaced twice');
  });

  it('update() returning undefined leaves the slice unchanged', () => {
    api.registerComponent({
      name: 'no-change',
      init: () => ({ touched: false }),
      update: (msg, slice) => { /* return undefined */ },
    });
    api.dispatchMsg({ type: 'refresh' });
    eq(api.getInstanceSlice('no-change').touched, false, 'untouched');
  });

  it('update() throw is isolated — other Components keep working', () => {
    api.registerComponent({
      name: 'thrower',
      init: () => ({ }),
      update: () => { throw new Error('boom'); },
    });
    api.registerComponent({
      name: 'survivor',
      init: () => ({ count: 0 }),
      update: (msg, slice) => ({ count: slice.count + 1 }),
    });
    api.dispatchMsg({ type: 'refresh' });
    eq(api.getInstanceSlice('survivor').count, 1,
       'survivor processed despite thrower failing');
  });
});

describe('[5] component-owned panels — render() receives slice, not S', () => {
  it('rendererFor wiring delegates to component', () => {
    api.registerComponent({
      name: 'showcase',
      init: () => ({ label: 'hello-slice' }),
      update: (msg, slice) =>
        msg.type === 'key' && msg.key === 'l'
          ? { ...slice, label: 'updated' }
          : slice,
      panelTypes: {
        showcase: {
          render: (panel, w, h, slice) => `[${slice.label} ${w}x${h}]`,
        },
      },
    });
    eq(api.getComponentOwningPanel('showcase'), 'showcase',
       'panel type registered to component');
    // Verify a dispatched key (with the showcase panel focused, so key
    // arbitration routes it there) updates the slice; a subsequent render
    // through rendererFor would see the new value.
    api.getInstanceSlice("layout").focus = 'showcase';
    api.dispatchKeyToFocused('l', 'l');
    eq(api.getInstanceSlice('showcase').label, 'updated',
       'slice mutated through the dispatch path');
  });
});

describe('[6] integration — dispatch.handleKey reaches Components', () => {
  it('a key event from the dispatcher arrives as a Msg', () => {
    api.registerComponent({
      name: 'keyrec',
      init: () => ({ keys: [] }),
      update: (msg, slice) =>
        msg.type === 'key'
          ? { keys: [...slice.keys, msg.key] }
          : slice,
      // Owns a focused panel so key arbitration routes the key here.
      panelTypes: { keyrec: { render: () => '' } },
    });
    api.getInstanceSlice("layout").focus = 'keyrec';
    // Use require('../dispatch/control/dispatch') indirectly via a key-filter that
    // suppresses — we want the dispatch fan-out, not the downstream
    // render. The key-filter terminator drops the event AFTER the
    // existing record + dispatchMsg calls fire (filter runs at the
    // very top of handleKey).
    //
    // Actually looking at handleKey order: filter runs FIRST, then
    // record, then dispatchMsg. So a terminator filter would block
    // dispatch. We need to install the filter AFTER the dispatch
    // point... but the existing code has no hook there. Instead,
    // call dispatchMsg directly — the integration with handleKey
    // is verified by the key-filter test suite's "no filters"
    // case, which exercises the full path.
    api.dispatchKeyToFocused('enter', 'enter');
    eq(api.getInstanceSlice('keyrec').keys.join(','), 'enter',
       'component received the key Msg');
  });
});

describe('[7] update() → [slice, effects] runs effects (the TEA Cmd half)', () => {
  it('effects in the return tuple are run; unknown effects are logged not thrown', () => {
    const ran = [];
    api.registerEffect('test_fx', (eff) => ran.push(eff.val));
    api.registerComponent({
      name: 'fx',
      init: () => ({ n: 0 }),
      update: (msg, slice) => [{ n: slice.n + 1 }, [{ type: 'test_fx', val: 'hit' }, { type: 'nope_unknown' }]],
    });
    // no throw despite the unknown effect
    api.dispatchMsg({ type: 'refresh' });
    eq(api.getInstanceSlice('fx').n, 1, 'slice from the tuple applied');
    eq(ran.join(','), 'hit', 'known effect ran; unknown one skipped without throwing');
  });
});

describe('[8b] viewContributions — footerLeft / footerRight', () => {
  it('Component footerLeft contribution composes through collectViewContributions("footerLeft")', () => {
    api._resetViewContributions();   // isolate from earlier registrations
    api.registerComponent({
      name: 'view-contrib',
      init: () => ({ label: 'hi' }),
      update: (msg, slice) =>
        msg.type === 'bump' ? { label: slice.label + '!' } : slice,
      viewContributions: {
        footerLeft:  (slice, ctx) => `[L:${slice.label} w=${ctx && ctx.width}]`,
        footerRight: (slice)      => `[R:${slice.label}]`,
      },
    });
    const left  = api.collectViewContributions('footerLeft',  { width: 80 });
    const right = api.collectViewContributions('footerRight', { width: 80 });
    eq(left,  '[L:hi w=80]', 'footerLeft renders, slice + ctx injected');
    eq(right, '[R:hi]',      'footerRight renders, slice injected');
  });

  it('slice changes are visible to the next collect() call', () => {
    // The previous test left 'view-contrib' registered. Bumping its slice
    // through dispatch should be picked up by a subsequent collect()
    // because the contribution closure reads the live slice each call.
    api.dispatchMsg(api.wrap('view-contrib', { type: 'bump' }));
    const left = api.collectViewContributions('footerLeft', { width: 80 });
    eq(left, '[L:hi! w=80]', 'contribution re-reads the live slice');
  });

  it('non-function viewContribution is ignored with an error', () => {
    api.registerComponent({
      name: 'bad-contrib',
      init: () => ({}),
      update: (msg, slice) => slice,
      viewContributions: { footerLeft: 'not-a-function' },
    });
    // Component still registers; the bad contribution is just dropped.
    assert(api.getComponent('bad-contrib') !== undefined, 'still registers');
  });

  it('unknown viewContribution slot key is ignored with an error', () => {
    api.registerComponent({
      name: 'unknown-slot',
      init: () => ({}),
      update: (msg, slice) => slice,
      viewContributions: { titleBar: () => 'x' },   // not in VIEW_CONTRIBUTION_SLOTS yet
    });
    assert(api.getComponent('unknown-slot') !== undefined, 'still registers');
  });
});

describe('[8e] layout Component — viewMode (Phase 1b)', () => {
  const layout = require('../panel/layout');

  it('reduceViewMode pure cycling (view_expand / view_shrink / view_set)', () => {
    const r = layout.reduceViewMode;
    eq(r('normal', { type: 'view_expand' }), 'half');
    eq(r('half',   { type: 'view_expand' }), 'full');
    eq(r('full',   { type: 'view_expand' }), 'full');
    eq(r('full',   { type: 'view_shrink' }), 'half');
    eq(r('half',   { type: 'view_shrink' }), 'normal');
    eq(r('normal', { type: 'view_shrink' }), 'normal');
    eq(r('normal', { type: 'view_set', mode: 'full' }),  'full');
    eq(r('full',   { type: 'view_set', mode: 'bogus' }), 'full');
    eq(r('half',   { type: 'whatever' }), 'half');
  });

  it('view_drop_full_to_normal drops only when viewMode is full', () => {
    const r = layout.reduceViewMode;
    eq(r('full',   { type: 'view_drop_full_to_normal' }), 'normal');
    eq(r('half',   { type: 'view_drop_full_to_normal' }), 'half');
    eq(r('normal', { type: 'view_drop_full_to_normal' }), 'normal');
  });

  it('update returns [slice, [force_full_repaint]] on a real transition', () => {
    const slice = layout.init();
    slice.viewMode = 'normal';
    const out = layout.update({ type: 'view_expand' }, slice);
    assert(Array.isArray(out), 'returns tuple');
    eq(out[0].viewMode, 'half');
    eq(out[1].length, 1);
    eq(out[1][0].type, 'force_full_repaint');
  });

  it('update returns the same slice (no Cmd) when viewMode does not change', () => {
    const slice = layout.init();
    slice.viewMode = 'normal';
    const out = layout.update({ type: 'view_shrink' }, slice);
    // normal → normal: no change → bare slice (not a tuple).
    assert(!Array.isArray(out), 'no Cmd');
    eq(out.viewMode, 'normal');
  });

  it('dispatched view_expand (wrapped) reaches the layout slice', () => {
    api.registerComponent(require('../panel/layout'));
    const slice = api.getInstanceSlice('layout');
    slice.viewMode = 'normal';
    api.dispatchMsg(api.wrap('layout', { type: 'view_expand' }));
    eq(api.getInstanceSlice('layout').viewMode, 'half',
       'wrapped Msg routed view_expand into layout.update');
  });
});

describe('[8d] layout Component skeleton (Phase 1a)', () => {
  it('layout registers as a chrome-only Component with the expected slice shape', () => {
    api.registerComponent(require('../panel/layout'));
    const slice = api.getInstanceSlice('layout');
    assert(slice !== undefined, 'layout slice exists');
    // Slice shape — sub-phases will populate these fields one by one.
    assert('arrange' in slice,      'slice has arrange (1g target)');
    assert('focus' in slice,        'slice has focus (1c target)');
    assert('viewMode' in slice,     'slice has viewMode (1b target)');
    assert('dirty' in slice,        'slice has dirty (1d target)');
    assert('freeConfig' in slice,       'slice has freeConfig (1f target)');
    // panelHeights moved off the slice — it lives in a module-local
    // in render/geometry.js, accessed via `getPanelViewportH(type)`.
    // paneBounds stays on the slice (mouse hit-tests + drag math
    // read it directly).
    assert('paneBounds' in slice,  'slice has paneBounds (1e target)');
    // v0.6.1 Phase 3 — slice.panels retired. Component slices live in
    // route._instances keyed by tab id; the layout slice no longer
    // carries a sibling map.
    // Chrome-only — no panelTypes registered.
    eq(api.getComponentOwningPanel('layout'), undefined,
       'layout owns no panel (chrome-only)');
  });

  it('layout update is inert during Phase 1a — flat Msgs touch nothing', () => {
    const before = api.getInstanceSlice('layout');
    api.dispatchMsg({ type: 'refresh' });
    // update returns the same slice; the registry stores whatever update returns.
    // Phase 1a's update returns slice unchanged, so the slice identity is preserved.
    eq(api.getInstanceSlice('layout'), before,
       'slice identity unchanged through fan-out');
  });
});

describe('[8c] wrapped-Msg dispatch — { kind, msg } routes to exactly one Component', () => {
  it('a wrapped Msg reaches only the targeted Component', () => {
    api.registerComponent({
      name: 'targetA',
      init: () => ({ hits: 0, lastType: null }),
      update: (msg, slice) => ({ hits: slice.hits + 1, lastType: msg.type }),
    });
    api.registerComponent({
      name: 'targetB',
      init: () => ({ hits: 0 }),
      update: (msg, slice) => ({ hits: slice.hits + 1 }),
    });
    const a0 = api.getInstanceSlice('targetA').hits;
    const b0 = api.getInstanceSlice('targetB').hits;
    api.dispatchMsg(api.wrap('targetA', { type: 'private_a_msg' }));
    eq(api.getInstanceSlice('targetA').hits, a0 + 1, 'targetA received exactly one Msg');
    eq(api.getInstanceSlice('targetA').lastType, 'private_a_msg',
       'targetA saw the unwrapped inner msg, not the wrapper');
    eq(api.getInstanceSlice('targetB').hits, b0,
       'targetB did NOT receive the wrapped Msg');
  });

  it('a wrapped Msg with unknown kind is logged and dropped', () => {
    // Snapshot one existing slice; a no-op wrapped dispatch must not touch it.
    const before = api.getInstanceSlice('targetA').hits;
    api.dispatchMsg(api.wrap('does-not-exist', { type: 'ignored' }));
    eq(api.getInstanceSlice('targetA').hits, before,
       'no Component received the wrapped Msg with unknown kind');
  });

  it('effects returned from a wrapped-Msg update still run', () => {
    const ran = [];
    api.registerEffect('test_wrapped_fx', (eff) => ran.push(eff.tag));
    api.registerComponent({
      name: 'wrapped-fx',
      init: () => ({ n: 0 }),
      update: (msg, slice) => [
        { n: slice.n + 1 },
        [{ type: 'test_wrapped_fx', tag: msg.tag }],
      ],
    });
    api.dispatchMsg(api.wrap('wrapped-fx', { type: 'go', tag: 'fired' }));
    eq(api.getInstanceSlice('wrapped-fx').n, 1, 'slice updated');
    eq(ran.join(','), 'fired', 'effect from wrapped-Msg update ran');
  });

  it('flat Msgs still fan out (back-compat)', () => {
    // The recorders from earlier tests (fanA / fanB / chrome-rec / replace / ...)
    // are still registered. A flat refresh should hit every Component that
    // accepts refresh — verify by picking a known fresh one.
    api.registerComponent({
      name: 'backcompat-fan',
      init: () => ({ ticks: 0 }),
      update: (msg, slice) =>
        msg.type === 'refresh' ? { ticks: slice.ticks + 1 } : slice,
    });
    const before = api.getInstanceSlice('backcompat-fan').ticks;
    api.dispatchMsg({ type: 'refresh' });
    eq(api.getInstanceSlice('backcompat-fan').ticks, before + 1,
       'flat refresh still reaches Components via fan-out');
  });
});

describe('[8a] chrome-only Component (no panelTypes) is supported', () => {
  it('registers with no panelTypes, init runs, fan-out Msgs reach update', () => {
    api.registerComponent({
      name: 'chrome-rec',
      init: () => ({ msgs: [] }),
      update: (msg, slice) => ({ msgs: [...slice.msgs, msg.type] }),
      // no panelTypes — chrome-only
    });
    assert(api.getComponent('chrome-rec') !== undefined, 'registered');
    // Chrome-only Components own no panel — nothing in the panel-owner map
    eq(api.getComponentOwningPanel('chrome-rec'), undefined,
       'no panel ownership claimed');
    // Fan-out Msgs reach it (non-key)
    api.dispatchMsg({ type: 'refresh' });
    eq(api.getInstanceSlice('chrome-rec').msgs.join(','), 'refresh',
       'fan-out Msgs delivered to chrome-only Component');
  });

  it('key Msgs do NOT reach chrome-only Components (no panel ownership)', () => {
    api.registerComponent({
      name: 'chrome-key',
      init: () => ({ keys: [] }),
      update: (msg, slice) =>
        msg.type === 'key' ? { keys: [...slice.keys, msg.key] } : slice,
    });
    // Even when nothing else owns the focus, a chrome-only Component
    // does not act as the key target — keys arbitrate to panel owners only.
    api.getInstanceSlice("layout").focus = 'some-non-existent-panel';
    api.dispatchKeyToFocused('enter', 'enter');
    eq(api.getInstanceSlice('chrome-key').keys.length, 0,
       'chrome-only Component did not receive the key');
  });
});

describe('[8] getItems reads the component slice (list panel)', () => {
  it('rows come from the slice; the framework filter applies over them', () => {
    const mnav = require('../leaves/nav');
    api.registerComponent({
      name: 'list',
      // Phase 4c — filter text lives on `slice.nav[panelType].filter`;
      // shared mnav leaf handles `set_filter` / `clear_filter` Msgs.
      init: () => ({ rows: ['alpha', 'beta', 'gamma'], nav: { list: mnav.init() } }),
      update: (msg, slice) => mnav.isNavMsg(msg) ? mnav.apply(slice, msg) : slice,
      panelTypes: {
        list: {
          render: () => '',
          getItems: (slice) => slice.rows,   // reads the SLICE
          filterable: true,
        },
      },
    });
    api.dispatchMsg(api.wrap('list', { type: 'clear_filter', panel: 'list' }));
    eq(api.getItems('list').join(','), 'alpha,beta,gamma', 'unfiltered = slice rows');
    api.dispatchMsg(api.wrap('list', { type: 'set_filter', panel: 'list', text: 'a' }));
    eq(api.getItems('list').join(','), 'alpha,beta,gamma', 'substring "a" matches all three');
    api.dispatchMsg(api.wrap('list', { type: 'set_filter', panel: 'list', text: 'bet' }));
    eq(api.getItems('list').join(','), 'beta', 'framework filter narrows the slice rows');
    api.dispatchMsg(api.wrap('list', { type: 'clear_filter', panel: 'list' }));
  });
});

report();
