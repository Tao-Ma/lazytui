/**
 * Plugin/Component registration validation (T3a) — panel-def contract
 * checks and panel-type namespace collision warnings. Previously a
 * plugin reusing a built-in type name silently last-wins-shadowed the
 * original, and bad-typed hooks (idOf/customFilter/…) became silent
 * no-ops at scattered call sites.
 *
 * Run: node js/test/test-plugin-registration.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const api = require('../plugins/api');

// Capture console.error around a thunk.
function captureErr(fn) {
  const orig = console.error;
  const out = [];
  console.error = (...a) => out.push(a.join(' '));
  try { fn(); } finally { console.error = orig; }
  return out.join('\n');
}

describe('[1] panel-def contract validation', () => {
  it('missing render() skips the type (not registered)', () => {
    const log = captureErr(() => api.registerPlugin({
      name: 'reg-norender', panelTypes: { nr: { getItems: () => [] } },
    }));
    assert(/missing render\(\)/.test(log), 'warned about missing render');
    assert(!api.getPanelDef('nr'), 'type not registered');
  });
  it('warns on a non-function hook (idOf) and non-boolean customFilter', () => {
    const log = captureErr(() => api.registerPlugin({
      name: 'reg-badhooks',
      panelTypes: { bh: { render: () => '', idOf: 'nope', customFilter: 'yes' } },
    }));
    assert(/'idOf' that is not a function/.test(log), `idOf warned: ${log}`);
    assert(/non-boolean 'customFilter'/.test(log), `customFilter warned: ${log}`);
  });
  it('a clean def registers with no warnings', () => {
    const log = captureErr(() => api.registerPlugin({
      name: 'reg-clean',
      panelTypes: { cleanpanel: { mode: 'list', render: () => '', getItems: () => [], idOf: x => x } },
    }));
    eq(log, '', 'no warnings for a well-formed def');
    assert(api.getPanelDef('cleanpanel'), 'registered');
  });
});

describe('[2] panel-type collisions', () => {
  it('Plugin↔Plugin collision warns (last-wins shadow)', () => {
    api.registerPlugin({ name: 'reg-first', panelTypes: { dup: { render: () => 'a' } } });
    const log = captureErr(() => api.registerPlugin({
      name: 'reg-second', panelTypes: { dup: { render: () => 'b' } },
    }));
    assert(/already registered by plugin 'reg-first'/.test(log), `collision warned: ${log}`);
  });
  it('re-registering the SAME plugin/type does not warn', () => {
    // Fresh type owned by reg-self; re-registering reg-self for it must
    // not warn (it's the same owner, not a real collision).
    api.registerPlugin({ name: 'reg-self', panelTypes: { selftype: { render: () => '' } } });
    const log = captureErr(() => api.registerPlugin({
      name: 'reg-self', panelTypes: { selftype: { render: () => '' } },
    }));
    assert(!/already registered/.test(log), 'no self-collision warning');
  });
  it('Component↔Plugin collision warns split-brain', () => {
    api.registerPlugin({ name: 'reg-plug', panelTypes: { both: { render: () => 'p' } } });
    const log = captureErr(() => api.registerComponent({
      name: 'reg-comp', init: () => ({}), update: (m, s) => s,
      panelTypes: { both: { render: () => 'c' } },
    }));
    assert(/collides with plugin 'reg-plug'/.test(log) && /split-brain/.test(log), `split-brain warned: ${log}`);
  });
});

report();
