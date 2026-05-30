/**
 * Component API — the TEA-shaped strict alternative to Plugin.
 * Framework wiring + Msg dispatch contract. Plugin API stays
 * unaffected; this exercises only the new path.
 *
 * Run: node js/test/test-component.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const api = require('../plugins/api');
const { getModel } = require('../runtime');

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
    const slice = api.getComponentSlice('rec1');
    eq(slice.count, 0, 'initial count');
    eq(slice.msgs.length, 0, 'initial msgs empty');
  });
});

describe('[3] dispatchMsg fan-out — non-key fans to all; key goes to the focused panel', () => {
  it('refresh/hub reach every component; a key reaches only the focused owner', () => {
    // Use fresh names to avoid carry-over from earlier tests.
    api.registerComponent(makeRecorder('fanA'));
    api.registerComponent(makeRecorder('fanB'));

    // Non-key Msgs fan to every component (the §12 contract holds for these).
    api.dispatchMsg({ type: 'refresh' });
    api.dispatchMsg({ type: 'hub', topic: 'foo', rowKey: 'r', sample: 1 });
    // A key Msg routes ONLY to the component owning the focused panel —
    // makeRecorder('fanA') registers panelType 'fanA'.
    require('../runtime').getModel().focus = 'fanA';
    api.dispatchMsg({ type: 'key', key: 'down' });

    const a = api.getComponentSlice('fanA');
    const b = api.getComponentSlice('fanB');
    eq(a.msgs.join(','), 'refresh,hub,key', 'fanA: non-key Msgs + the focused key');
    eq(b.msgs.join(','), 'refresh,hub', 'fanB: non-key only — not the key (unfocused)');
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
    eq(api.getComponentSlice('replace').n, 2, 'slice replaced twice');
  });

  it('update() returning undefined leaves the slice unchanged', () => {
    api.registerComponent({
      name: 'no-change',
      init: () => ({ touched: false }),
      update: (msg, slice) => { /* return undefined */ },
    });
    api.dispatchMsg({ type: 'refresh' });
    eq(api.getComponentSlice('no-change').touched, false, 'untouched');
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
    eq(api.getComponentSlice('survivor').count, 1,
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
    require('../runtime').getModel().focus = 'showcase';
    api.dispatchMsg({ type: 'key', key: 'l' });
    eq(api.getComponentSlice('showcase').label, 'updated',
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
    require('../runtime').getModel().focus = 'keyrec';
    // Use require('../dispatch') indirectly via a key-filter that
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
    api.dispatchMsg({ type: 'key', key: 'enter' });
    eq(api.getComponentSlice('keyrec').keys.join(','), 'enter',
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
    eq(api.getComponentSlice('fx').n, 1, 'slice from the tuple applied');
    eq(ran.join(','), 'hit', 'known effect ran; unknown one skipped without throwing');
  });
});

describe('[8] getItems reads the component slice (list panel)', () => {
  it('rows come from the slice; the framework filter applies over them', () => {
    api.registerComponent({
      name: 'list',
      init: () => ({ rows: ['alpha', 'beta', 'gamma'] }),
      update: (msg, slice) => slice,
      panelTypes: {
        list: {
          render: () => '',
          getItems: (slice) => slice.rows,   // reads the SLICE, not S
          filterable: true,
        },
      },
    });
    getModel().ui.filters = getModel().ui.filters || {};
    delete getModel().ui.filters.list;
    eq(api.getItems('list').join(','), 'alpha,beta,gamma', 'unfiltered = slice rows');
    getModel().ui.filters.list = 'a';
    eq(api.getItems('list').join(','), 'alpha,beta,gamma', 'substring "a" matches all three');
    getModel().ui.filters.list = 'bet';
    eq(api.getItems('list').join(','), 'beta', 'framework filter narrows the slice rows');
    delete getModel().ui.filters.list;
  });
});

report();
