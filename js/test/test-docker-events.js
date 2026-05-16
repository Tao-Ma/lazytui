/**
 * Docker events stream smoke test — exercises handleEventLine in
 * isolation: parse, filter to tracked containers, debounce coalescing,
 * malformed-line handling. Doesn't spawn `docker events` (no real docker
 * required); tests the pure parser/filter/debounce contract.
 *
 * The debounce-driven steps run via chained setTimeout, so the file uses
 * `section()` for section headers instead of describe/it for the async
 * portions — describe is sync-only. Sync steps still use describe/it.
 *
 * Run: node js/test/test-docker-events.js
 */
'use strict';

const docker = require('../plugins/docker');
const { _handleEventLine, _isTrackedContainer, _stopEventsStream } = docker;
const { describe, section, it, assert, eq, report } = require('./test-runner');

const config = {
  groups: {
    g1: { name: 'g1', containers: ['dev9-env', 'dev9-gitea'] },
    g2: { name: 'g2', containers: ['workvpn'] },
  },
};

function evt(name, action = 'die') {
  return JSON.stringify({
    Type: 'container',
    Action: action,
    Actor: { ID: 'abc', Attributes: { name } },
  });
}

describe('[1] isTrackedContainer', () => {
  it('membership across all groups; null/empty configs return false', () => {
    assert(_isTrackedContainer('dev9-env', config), 'tracked: dev9-env');
    assert(_isTrackedContainer('workvpn', config), 'tracked across groups: workvpn');
    assert(!_isTrackedContainer('random-container', config), 'untracked container');
    assert(!_isTrackedContainer('dev9-env', null), 'null config → false');
    assert(!_isTrackedContainer('dev9-env', { groups: {} }), 'empty groups → false');
  });
});

// Async chain — each step waits past the 200ms debounce window. Using
// section() instead of describe() because describe's body is sync and we
// can't await inside it without restructuring the harness.
let refreshCalls = 0, renderCalls = 0;
const refreshFn = async () => { refreshCalls++; return true; };
const renderFn = () => { renderCalls++; };

section('[2] tracked event triggers debounced refresh');
{
  const tracked = _handleEventLine(evt('dev9-env'), config, refreshFn, renderFn);
  eq(tracked, true, 'returns true (tracked)');
  eq(refreshCalls, 0, 'refresh NOT called yet (debounced)');
}

setTimeout(() => {
  eq(refreshCalls, 1, 'refresh called once after debounce');
  eq(renderCalls, 1, 'render called once');
  runStep3();
}, 300);

function runStep3() {
  section('[3] untracked event returns false');
  refreshCalls = 0; renderCalls = 0;
  const tracked = _handleEventLine(evt('random-container'), config, refreshFn, renderFn);
  eq(tracked, false, 'returns false (untracked)');
  setTimeout(() => {
    eq(refreshCalls, 0, 'refresh NOT called for untracked');
    runStep4();
  }, 300);
}

function runStep4() {
  section('[4] burst coalesces — debounce works');
  refreshCalls = 0; renderCalls = 0;
  for (let i = 0; i < 10; i++) _handleEventLine(evt('dev9-env'), config, refreshFn, renderFn);
  for (let i = 0; i < 5;  i++) _handleEventLine(evt('dev9-gitea'), config, refreshFn, renderFn);
  setTimeout(() => {
    eq(refreshCalls, 1, '15 burst events → exactly 1 refresh');
    eq(renderCalls, 1, '15 burst events → exactly 1 render');
    runStep5();
  }, 300);
}

function runStep5() {
  section('[5] malformed lines do not crash');
  refreshCalls = 0; renderCalls = 0;
  eq(_handleEventLine('not-json',          config, refreshFn, renderFn), false, 'invalid JSON → false');
  eq(_handleEventLine('{}',                config, refreshFn, renderFn), false, 'no Actor → false');
  eq(_handleEventLine('{"Actor":{}}',      config, refreshFn, renderFn), false, 'no Attributes → false');
  eq(_handleEventLine('{"Actor":{"Attributes":{}}}', config, refreshFn, renderFn), false, 'no name → false');
  setTimeout(() => {
    eq(refreshCalls, 0, 'no refresh from malformed lines');
    runStep6();
  }, 300);
}

function runStep6() {
  section('[6] refreshFn returning false → render skipped');
  refreshCalls = 0; renderCalls = 0;
  const noChange = async () => { refreshCalls++; return false; };
  _handleEventLine(evt('dev9-env'), config, noChange, renderFn);
  setTimeout(() => {
    eq(refreshCalls, 1, 'refresh called');
    eq(renderCalls, 0, 'render skipped (no change)');
    finish();
  }, 300);
}

function finish() {
  // Don't leave a refresh timer dangling for any outstanding event.
  _stopEventsStream();
  report();
}
