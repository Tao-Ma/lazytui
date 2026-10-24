/**
 * Pin the fabricForm initial-state shape across the three sites that write
 * it: fabric-form.CLOSED (the authoritative one), model/store.js initial
 * model, and reducer.js config_swap reset.
 *
 * R3B-SMELL1 caught a slice-2 drift: `picking` + `requestSeq` were added to
 * CLOSED but the initial-state + config_swap sites still used the slice-1
 * shape. No runtime bug (arms read `f.requestSeq || 0` + `f.picking && …`),
 * but the next new field could introduce a real divergence.
 *
 * reducer.js now `{ ...CLOSED }`-spreads at config_swap (dispatch sits ABOVE
 * model in the layer DAG so the import is downward and legal). model/store.js
 * CAN'T import dispatch (upward), so it hand-copies the shape — this test is
 * what keeps the hand-copied shape honest.
 *
 * Run: node js/test/test-slice-initial-shape.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const { CLOSED } = require('../dispatch/update/modal/fabric-form');
const runtime = require('../app/runtime');

function sortedKeys(o) {
  return Object.keys(o).sort();
}

describe('[slice-initial-shape] fabricForm — the three write sites match CLOSED', () => {
  it('initial-model fabricForm has the same keys as CLOSED', () => {
    const m = runtime.init();
    eq(sortedKeys(m.modal.fabricForm), sortedKeys(CLOSED),
      'model/store.js initial fabricForm keys match CLOSED');
  });

  it('initial-model fabricForm key VALUES match CLOSED', () => {
    const m = runtime.init();
    for (const k of Object.keys(CLOSED)) {
      eq(m.modal.fabricForm[k], CLOSED[k], `initial fabricForm.${k} matches CLOSED.${k}`);
    }
  });

  it('config_swap reset writes a CLOSED-shaped fabricForm', () => {
    const m = runtime.init();
    const [next] = runtime.update(m, {
      type: 'config_swap',
      config: { groups: {}, project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {} },
      configPath: '',
    });
    eq(sortedKeys(next.modal.fabricForm), sortedKeys(CLOSED),
      'reducer.js config_swap fabricForm keys match CLOSED');
    for (const k of Object.keys(CLOSED)) {
      eq(next.modal.fabricForm[k], CLOSED[k], `config_swap fabricForm.${k} matches CLOSED.${k}`);
    }
  });
});

report();
