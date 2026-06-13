/**
 * Smoke — paneId / panel-type routing invariants.
 *
 * The v0.6.3 audit + user-found bugs centered on one structural mistake:
 * a `getFocus()` value (paneId post-Phase-B1) was compared against a
 * panel-type literal (`=== 'docker'`, `=== 'files'`, …). The kind-name
 * fallback in `route.componentForPanel` masked many of these from
 * crashing — they instead silently mis-routed Msgs and reads. The
 * canonical comparator established post-arc is
 * `instanceKind(focus) === '<panel-type>'`; see auto-memory
 * `[[paneid-lookup-pattern]]`.
 *
 * This smoke pins the invariant: for every placed pane, the three
 * route accessors (`componentForPanel`, `paneTypeOf`, `instanceKind`)
 * agree across the paneId AND panel-type forms. A future refactor
 * that re-shapes one accessor without updating the other two trips
 * this gate immediately, rather than at user-visible click time.
 *
 * Run: node js/test/smoke/routing.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('../test-runner');
const sm = require('./_helpers/smoke');
const route = sm.route;
const api = sm.api;

// --- Boot: register every production Component, then seed a config
//     whose default-arrange fallback places containers + files alongside
//     the always-placed groups/actions/detail.

function bootAllComponents() {
  // test-runner.js auto-registered layout/detail/groups on require.
  // Register the remaining production Components in tui.js order.
  // Skip ones already attached to be idempotent across multiple
  // bootFresh() calls within the same process.
  const toRegister = [
    ['../../panel/navigator/docker',        'docker'],
    ['../../panel/navigator/config-status', 'config-status'],
    ['../../panel/navigator/files',         'files'],
    ['../../panel/navigator/actions',       'actions'],
    ['../../panel/monitor/stats',           'stats'],
    ['../../panel/navigator/history',       'history'],
  ];
  for (const [modPath, name] of toRegister) {
    if (api.getComponent(name)) continue;   // spec registry — survives seed disposal
    api.registerComponent(require(modPath));
  }
}

bootAllComponents();

// A config that exercises the default-arrange placement gates:
//   - hasContainers (any group with a non-empty containers array)
//   - hasConfigFiles (top-level files: [...])
// Combined with groups + actions + detail (always placed), the
// resulting arrange has 5 distinct panel-types. Both knobs pass
// through bootFresh into initState's arrange build + B1 mint pass.
sm.bootFresh({
  groups: {
    g1: {
      name: 'g1', label: 'Group 1',
      containers: [{ name: 'c1', image: 'alpine' }],
      actions: { a1: { key: 'a1', label: 'A1', type: 'run', script: 'true', tab: false } },
      children: [], parent: null, depth: 0, quick: false,
    },
  },
  files: [{ path: 'README.md', label: 'README' }],
});

// Walk the placed panes once — every test below iterates this list.
function placedPanes() {
  const out = [];
  const layout = api.getInstanceSlice('layout');
  for (const col of (layout.arrange.columns || [])) {
    for (const p of (col.panels || [])) {
      if (p && p.paneId && p.type) out.push({ paneId: p.paneId, type: p.type });
    }
  }
  return out;
}

const PANES = placedPanes();

// --- [1] Sanity: arrange placed the expected variety ---------------------

describe('[1] arrange placed the panel-types the smoke needs', () => {
  it('placed set covers groups + actions + detail + containers + files', () => {
    const types = new Set(PANES.map(p => p.type));
    for (const need of ['groups', 'actions', 'detail', 'containers', 'files']) {
      assert(types.has(need), `panel-type '${need}' placed (saw ${[...types].sort().join(',')})`);
    }
  });
});

// --- [2] componentForPanel: paneId form and panel-type form agree -------
//
// The v0.6.3 fix was to make `componentForPanel` accept BOTH paneId and
// panel-type. The invariant: same answer for either input.

describe('[2] componentForPanel is symmetric across paneId and panel-type', () => {
  for (const { paneId, type } of PANES) {
    it(`${type}: paneId='${paneId}' ↔ type='${type}' resolve to same owner`, () => {
      const fromPaneId = route.componentForPanel(paneId);
      const fromType = route.componentForPanel(type);
      assert(fromPaneId !== undefined, `paneId '${paneId}' has an owner`);
      eq(fromPaneId, fromType, 'paneId-keyed and type-keyed lookups agree');
    });
  }
});

// --- [3] paneTypeOf: both forms map to the same panel-type --------------
//
// `paneTypeOf` is the helper that turns "whatever the caller has" into
// the panel-type literal (e.g. for indexing comp.panelTypes). For a
// paneId input, the result MUST equal the placed pane's type. For a
// panel-type input, it's the identity.

describe('[3] paneTypeOf returns the panel-type for both input forms', () => {
  for (const { paneId, type } of PANES) {
    it(`${type}: paneTypeOf('${paneId}') === paneTypeOf('${type}') === '${type}'`, () => {
      eq(route.paneTypeOf(paneId), type, 'paneId → type');
      eq(route.paneTypeOf(type), type, 'type → type (identity)');
    });
  }
});

// --- [4] instanceKind: the canonical focus comparator -------------------
//
// Per [[paneid-lookup-pattern]], `instanceKind(focus) === '<panel-type>'`
// is the discipline. This was the comparator that silently failed for
// the 6 paneId/type mismatches the v0.6.3 audit fixed. Pin both arms
// (paneId + type) returning the panel-type literal.

describe('[4] instanceKind canonicalizes both forms to the panel-type literal', () => {
  for (const { paneId, type } of PANES) {
    it(`${type}: instanceKind('${paneId}') === instanceKind('${type}') === '${type}'`, () => {
      eq(route.instanceKind(paneId), type, 'paneId → type');
      eq(route.instanceKind(type), type, 'type → type (identity)');
    });
  }
});

// --- [5] Simulated focus: paneId comparator works at the call site ------
//
// Production code reads `getFocus()` (a paneId) and compares it to a
// panel-type. The audit replaced bare `=== '<type>'` with
// `instanceKind(...) === '<type>'`. Mimic the call site here: set
// `layoutSlice.focus = paneId`, then verify the comparator agrees.

describe('[5] focus=paneId still answers `is the focused panel of type T?` correctly', () => {
  const layout = api.getInstanceSlice('layout');
  const origFocus = layout.focus;
  for (const { paneId, type } of PANES) {
    it(`focus='${paneId}' (paneId form) → instanceKind(focus) === '${type}'`, () => {
      layout.focus = paneId;
      eq(route.instanceKind(route.getFocus()), type,
        `focused paneId comparator returns the panel-type (was the v0.6.3 bug class)`);
    });
  }
  // Also exercise the panel-type-literal arm of instanceKind. The dual-
  // input convention says it must work for either form; legacy producers
  // that still write the kind-name to focus (or pre-_withFocus boot)
  // surface here. Without this arm, a future regression of route.js arm 2
  // (`if (_panelOwner[id]) return id`) would not be caught by the
  // paneId-only loop above.
  for (const { type } of PANES) {
    it(`focus='${type}' (panel-type literal form) → instanceKind(focus) === '${type}'`, () => {
      layout.focus = type;
      eq(route.instanceKind(route.getFocus()), type,
        `panel-type-literal focus must resolve to itself via the _panelOwner arm`);
    });
  }
  // Restore
  layout.focus = origFocus;
});

// --- [6] Slice retrieval: strict ids + explicit kind-level reads ---------
//
// Split-arc P2: `getInstanceSlice(id)` takes INSTANCE ids only — the
// kind-name fallback is deleted. Kind-level intent is explicit:
// `primarySliceOf(kind)` (the kind's canonical pane instance) and
// `serviceSlice(kind)` (the kind-global service slot).

describe('[6] slice retrieval — strict ids, primarySliceOf, serviceSlice', () => {
  // Two structural shapes exist post-Phase-B1:
  //
  //  A) Symmetric: Component name === panel-type (groups, files, actions,
  //     detail). state.js B1 disposed the kind-keyed seed and minted
  //     `pane-<type>` keyed by paneId; the kind primary follows. A
  //     kind-name ID read therefore MISSES (strict), while
  //     primarySliceOf(type) resolves the same object the paneId read
  //     returns.
  //
  //  B) Docker-style: Component name ('docker') ≠ panel-type
  //     ('containers'). TWO distinct slices:
  //       - the per-pane NAV instance, minted at the paneId,
  //         self-identifying (`.paneId === paneId`); also the kind
  //         primary for 'containers' → primarySliceOf resolves it.
  //       - the CONTENT-OWNER service slot, keyed by the Component name
  //         ('docker'), `.paneId == null`, undisposable (split-arc P0);
  //         read via serviceSlice. Distinct object from the pane slice.
  //
  // Pin both shapes so a future refactor that flattens one onto the
  // other doesn't silently break docker-style reads or symmetric reads.
  for (const { paneId, type } of PANES) {
    const owner = route.componentForPanel(paneId);
    const symmetric = (owner === type);
    if (symmetric) {
      it(`${type} (symmetric): kind-name id misses; primarySliceOf resolves the pane slice`, () => {
        const viaPaneId = api.getInstanceSlice(paneId);
        assert(viaPaneId !== undefined, 'paneId-keyed slice exists');
        assert(api.getInstanceSlice(type) === undefined,
          'kind-name ID read misses (strict — fallback deleted)');
        assert(api.primarySliceOf(type) === viaPaneId,
          'primarySliceOf resolves the same object ref (not a copy)');
      });
    } else {
      it(`${type} (docker-style, owner='${owner}'): per-pane nav + content-owner service`, () => {
        const viaPaneId = api.getInstanceSlice(paneId);
        assert(viaPaneId !== undefined, 'paneId-keyed nav instance exists (Arc 2 mint)');
        eq(viaPaneId.paneId, paneId, 'pane slice self-identifies');
        assert(api.getInstanceSlice(type) === undefined,
          'panel-type ID read misses (strict — fallback deleted)');
        assert(api.primarySliceOf(type) === viaPaneId,
          'primarySliceOf(panel-type) resolves the pane slice');
        const ownerSlice = api.serviceSlice(owner);
        assert(ownerSlice !== undefined, `content-owner service ('${owner}') exists`);
        assert(route.isService(owner), 'owner is a service slot (undisposable, P0)');
        assert(ownerSlice !== viaPaneId, 'content owner is a DISTINCT slice from the pane nav');
        // The owner gate (docker.js: `slice.paneId != null`) is loose —
        // the singleton stamps paneId: undefined. Assert the same nullish
        // contract, not a strict null.
        assert(ownerSlice.paneId == null, 'content owner is the unplaced service (paneId == null)');
      });
    }
  }
});

report();
