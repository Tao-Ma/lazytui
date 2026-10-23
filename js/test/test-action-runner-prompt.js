/**
 * action-runner integration — the P2 invoke-time prompt wiring.
 *
 * test-shell-action-prompt.js covers the reducer layer (fabric_field_enter with
 * pendingAction, oneShot submit/consume_oneshot). This file covers the ACTION-
 * RUNNER wiring that bridges doRun to the fabric-field modal — the two helpers
 * `_promptMissing` and `_consumeOneShotInjects`. Without this guard, a refactor
 * of doRun could silently drop the prompt dispatch or the one-shot consumption
 * and no reducer-layer test would fail until a user ran an action in the TUI.
 *
 * Drives the helpers directly (exported with a leading underscore, same style
 * as _resolvePortsForAction) and observes model state via applyMsg's live reducer.
 *
 * Run: node js/test/test-action-runner-prompt.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getModel } = require('../model/store');
const runner = require('../dispatch/runtime/action-runner');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');

wireFabricHost();   // _resolvePortsForAction reads wires through the host (see test-shell-action-ports.js)

const ACTION_REQUIRED = {
  type: 'run', script: '$SUM -c "$file.sha256"',
  ports: { in: { file: { type: 'string', required: true } } },
};
const ACTION_OPTIONAL = {
  type: 'run', script: 'echo $v',
  ports: { in: { v: { type: 'string', required: false } } },
};
const ACTION_MIXED = {
  type: 'run', script: 'echo $file $v',
  ports: { in: {
    v: { type: 'string', required: false },
    file: { type: 'string', required: true },
  } },
};

function boot() {
  sm.bootFresh({
    groups: { g: {
      name: 'g', label: 'G', containers: [], children: [], parent: null, depth: 0, quick: false,
      actions: { verify: ACTION_REQUIRED, mixed: ACTION_MIXED, opt: ACTION_OPTIONAL },
    } },
  });
}

function setInject(group, addr, value, opts) {
  const m = getModel();
  m.fabric = m.fabric || {};
  m.fabric.injects = m.fabric.injects || {};
  m.fabric.injects[group] = m.fabric.injects[group] || {};
  const rec = { value, at: m.now };
  if (opts && opts.oneShot) rec.oneShot = true;
  m.fabric.injects[group][addr] = rec;
}

describe('[action-runner-prompt] _promptMissing opens fabric-field for the first required-missing port', () => {
  it('exports the two integration helpers (regression guard)', () => {
    assert(typeof runner._promptMissing === 'function', '_promptMissing exported');
    assert(typeof runner._consumeOneShotInjects === 'function', '_consumeOneShotInjects exported');
  });

  it('opens the modal with pendingAction + returns true when a required port is missing', () => {
    boot();
    const opened = runner._promptMissing('verify', ACTION_REQUIRED, [{ port: 'file', reason: 'x' }]);
    assert(opened === true, 'returns true to signal "modal opened; do not run"');
    assert(getModel().modes.fabricFieldMode === true, 'fabric-field modal opened');
    eq(getModel().modal.fabricField.addr, 'verify.file', 'addr is `actionKey.portName`');
    const pa = getModel().modal.fabricField.pendingAction;
    assert(pa != null, 'pendingAction stored on modal state');
    eq(pa.actionKey, 'verify', 'carries the action key for re-dispatch');
    assert(pa.action && pa.action.script === ACTION_REQUIRED.script, 'carries the full action object');
  });

  it('OPTIONAL missing ports are NOT promptable — returns false, no modal', () => {
    boot();
    const opened = runner._promptMissing('opt', ACTION_OPTIONAL, [{ port: 'v', reason: 'x' }]);
    assert(opened === false, 'returns false — nothing required to prompt');
    assert(!getModel().modes.fabricFieldMode, 'no modal was opened');
  });

  it('with mixed required/optional missing, opens over the first REQUIRED one (skips optionals)', () => {
    boot();
    const missing = [{ port: 'v', reason: 'x' }, { port: 'file', reason: 'y' }];
    const opened = runner._promptMissing('mixed', ACTION_MIXED, missing);
    assert(opened === true);
    eq(getModel().modal.fabricField.addr, 'mixed.file',
      'skipped optional `v`, opened over required `file`');
  });
});

describe('[action-runner-prompt] _consumeOneShotInjects clears consumed one-shots, leaves everything else alone', () => {
  it('clears a oneShot inject when the resolver reported source=`inject` for that port', () => {
    boot();
    setInject('g', 'verify.file', 'arc.tar.xz', { oneShot: true });
    runner._consumeOneShotInjects('verify', ACTION_REQUIRED, { file: 'inject' });
    assert(!getModel().fabric.injects.g['verify.file'],
      'the one-shot inject is cleared post-resolve (consumed by the next run)');
  });

  it('leaves a STICKY inject (no oneShot flag) intact, even when the source was `inject`', () => {
    boot();
    setInject('g', 'verify.file', 'arc.tar.xz');            // sticky — no oneShot flag
    runner._consumeOneShotInjects('verify', ACTION_REQUIRED, { file: 'inject' });
    assert(getModel().fabric.injects.g['verify.file'],
      'sticky injects (ports-pane manual edits) survive consume');
  });

  it('leaves oneShot entries alone when the source was `wire` or `default` (not `inject`)', () => {
    boot();
    setInject('g', 'verify.file', 'v', { oneShot: true });
    runner._consumeOneShotInjects('verify', ACTION_REQUIRED, { file: 'wire' });
    assert(getModel().fabric.injects.g['verify.file'], 'wire source does not consume the inject');
    runner._consumeOneShotInjects('verify', ACTION_REQUIRED, { file: 'default' });
    assert(getModel().fabric.injects.g['verify.file'], 'default source does not consume the inject');
  });

  it('is a safe no-op when sources is undefined / empty / unknown port', () => {
    boot();
    setInject('g', 'verify.file', 'v', { oneShot: true });
    runner._consumeOneShotInjects('verify', ACTION_REQUIRED, undefined);
    assert(getModel().fabric.injects.g['verify.file'], 'undefined sources → no-op');
    runner._consumeOneShotInjects('verify', ACTION_REQUIRED, {});
    assert(getModel().fabric.injects.g['verify.file'], 'empty sources → no-op');
    runner._consumeOneShotInjects('verify', ACTION_REQUIRED, { nonexistent: 'inject' });
    assert(getModel().fabric.injects.g['verify.file'], 'unknown port → no-op');
  });
});

report();
