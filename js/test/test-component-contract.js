/**
 * Component contract tripwire — the generic select_* fallback seam
 * (dispatch/runtime/loop.js `_selectFallback`) detects "the Component didn't
 * claim this Msg" by SLICE IDENTITY. That makes identity-preservation on
 * unowned Msgs a load-bearing contract: a Component whose update rebuilds the
 * slice unconditionally (a stamp preamble, a defensive spread) without
 * handling select_* would silently swallow selection on its pane — no error,
 * no fallback, no tripwire. This file IS the tripwire (review 2026-08-01,
 * MED). Over every registered Component and every minted instance of the
 * shipped fabric demo it enforces:
 *
 *   (a) IDENTITY — update(<foreign probe Msg>, slice) returns undefined, the
 *       same slice reference, or [same-or-undefined, cmds]; never a new slice.
 *   (b) END-TO-END — a seeded active selection on ANY instance is cleared by
 *       a wrapped select_cancel through the real dispatch. Claim or fallback,
 *       either path must land; a Component that breaks (a) surfaces here as a
 *       selection its pane can never cancel.
 *
 * Run: node js/test/test-component-contract.js
 */
'use strict';

const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');   // auto-registers layout/detail/groups
const api = require('../panel/api');
const route = require('../panel/route');
const { parse } = require('../parser/index');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');
const { dispatchMsg } = require('../dispatch/runtime/loop');

// Register the panels the fabric demo places (mirrors smoke/pane-select) plus
// the content Components, so the minted-instance sweep covers the full
// in-tree spread: navigators, fabric panes, content slot (info / text-view).
for (const p of ['navigator/actions', 'fabric/ports-pane', 'fabric/wire-list',
                 'info/info', 'text-view/text-view']) {
  const c = require('../panel/' + p);
  if (!api.getComponent(c.name)) api.registerComponent(c);
}
const cfg = parse(path.join(__dirname, '..', '..', 'demo', 'fabric', 'tui.yml'));
getModel().config = cfg;
getModel().projectDir = cfg.project_dir;
initState();
wireFabricHost();

const components = api._components();

// The Component an instance's update rides through — same two-step resolution
// as the dispatch fan-out (kind is a Component name, or a panel-type alias).
function compOf(inst) {
  return components[inst.kind] || components[route.componentForPanel(inst.kind)];
}

function instances() {
  const out = [];
  route.eachInstance((inst) => { if (compOf(inst)) out.push(inst); });
  return out;
}

describe('(a) identity — a foreign Msg must not mint a new slice', () => {
  const probe = { type: '__contract_probe__' };
  for (const inst of instances()) {
    it(`${inst.id} (${inst.kind})`, () => {
      const before = inst.slice;
      const result = compOf(inst).update(probe, before);
      const next = Array.isArray(result) ? result[0] : result;
      assert(next === undefined || next === before,
        `update must be identity-preserving on unowned Msgs (got a new slice)`);
    });
  }
});

describe('(b) end-to-end — every instance\'s selection is cancellable', () => {
  for (const inst of instances()) {
    it(`${inst.id} (${inst.kind})`, () => {
      route.setInstanceSlice(inst.id, {
        ...inst.slice,
        select: { active: true, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 1 } },
      });
      dispatchMsg(route.wrap(inst.id, { type: 'select_cancel' }));
      const sel = route.getInstance(inst.id).slice.select;
      assert(!sel || !sel.active,
        'wrapped select_cancel must clear the selection (Component claim or loop fallback)');
    });
  }
});

report();
