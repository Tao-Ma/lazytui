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

// Helper: wrap a missing-array in the resolved shape _promptMissing now takes.
// Tests that pre-dated slice 1 only cared about `missing`; slice 1 added values/
// sources for the form path's pre-fill. For the 1-port fabric-field lane the
// pre-fill is unused; for the form lane the test opts into values/sources.
const resolved = (missing, values = {}, sources = {}) => ({ ready: false, missing, values, sources });

describe('[action-runner-prompt] _promptMissing: 1-port lane opens fabric-field', () => {
  it('exports the two integration helpers (regression guard)', () => {
    assert(typeof runner._promptMissing === 'function', '_promptMissing exported');
    assert(typeof runner._consumeOneShotInjects === 'function', '_consumeOneShotInjects exported');
  });

  it('a 1-port action with a required missing opens fabric-field (not the form)', () => {
    boot();
    const opened = runner._promptMissing('verify', ACTION_REQUIRED, resolved([{ port: 'file', reason: 'x' }]));
    assert(opened === true, 'returns true to signal "modal opened; do not run"');
    assert(getModel().modes.fabricFieldMode === true, 'fabric-field modal opened');
    assert(!getModel().modes.fabricFormMode, 'FORM did NOT open — 1-port stays on the lean single-line popup');
    eq(getModel().modal.fabricField.addr, 'verify.file', 'addr is `actionKey.portName`');
    const pa = getModel().modal.fabricField.pendingAction;
    assert(pa != null, 'pendingAction stored on modal state');
    eq(pa.actionKey, 'verify', 'carries the action key for re-dispatch');
    assert(pa.action && pa.action.script === ACTION_REQUIRED.script, 'carries the full action object');
  });

  it('OPTIONAL missing ports are NOT promptable — returns false, no modal', () => {
    boot();
    const opened = runner._promptMissing('opt', ACTION_OPTIONAL, resolved([{ port: 'v', reason: 'x' }]));
    assert(opened === false, 'returns false — nothing required to prompt');
    assert(!getModel().modes.fabricFieldMode, 'no modal was opened');
    assert(!getModel().modes.fabricFormMode, 'no form opened either');
  });
});

describe('[action-runner-prompt] _promptMissing: 2+-port lane opens fabric-form', () => {
  it('opens the FORM with ALL declared ports materialized (not just the missing one)', () => {
    boot();
    // mixed has `v` (optional) + `file` (required); only `file` is missing.
    const missing = [{ port: 'file', reason: 'y' }];
    const opened = runner._promptMissing('mixed', ACTION_MIXED, resolved(missing));
    assert(opened === true);
    assert(getModel().modes.fabricFormMode === true, 'fabric-FORM modal opened (not fabric-field)');
    assert(!getModel().modes.fabricFieldMode, 'fabric-field did NOT open');
    const form = getModel().modal.fabricForm;
    const ports = form.fields.map((x) => x.port).sort();
    eq(ports.join(','), 'file,v', 'both declared ports materialized');
    // Required-first order (reducer re-sorts): file (required) ahead of v (optional).
    eq(form.fields[0].port, 'file', 'required field is focused first');
    eq(form.focusIdx, 0);
    assert(form.pendingAction && form.pendingAction.actionKey === 'mixed', 'pendingAction carries key');
  });

  it('pre-fills a resolved port from `values[]` (inject/wire/default already settled)', () => {
    boot();
    // Pretend `v` resolved to 'hello' (via wire), `file` still missing.
    const opened = runner._promptMissing('mixed', ACTION_MIXED,
      resolved([{ port: 'file', reason: 'y' }], { v: 'hello' }, { v: 'wire' }));
    assert(opened === true);
    const form = getModel().modal.fabricForm;
    const map = Object.fromEntries(form.fields.map((x) => [x.port, x]));
    eq(map.v.text, 'hello', 'resolved value pre-fills the field');
    assert(map.v.isModified && !map.v.isDefault, 'wire-sourced value differs from (nonexistent) default → modified');
    eq(map.file.text, '', 'missing port starts empty');
    assert(!map.file.isDefault && !map.file.isModified, 'file: empty + no default → neither chip');
  });

  it('pre-fills a port with a declared default when nothing upstream resolved it', () => {
    boot();
    // A 2-port action with a defaulted optional. Required `host` missing, optional `role` unresolved.
    const ACTION_WITH_DEFAULT = {
      type: 'run', script: 'echo $host $role',
      ports: { in: {
        host: { type: 'string', required: true, desc: 'hostname' },
        role: { type: 'string', required: false, default: 'worker', desc: 'node role' },
      } },
    };
    const opened = runner._promptMissing('prov', ACTION_WITH_DEFAULT,
      resolved([{ port: 'host', reason: 'x' }, { port: 'role', reason: 'default' }]));
    assert(opened === true);
    const form = getModel().modal.fabricForm;
    const map = Object.fromEntries(form.fields.map((x) => [x.port, x]));
    eq(map.role.text, 'worker', 'default pre-filled when nothing in values[]');
    assert(map.role.isDefault && !map.role.isModified, 'role chip: [default]');
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

describe('[action-runner-prompt] _envWithShadowGuard refuses to let a port VALUE override dangerous env vars', () => {
  it('a safe port value spreads normally into the env', () => {
    const env = runner._envWithShadowGuard('an-action', { HOST: 'node-7.lan', PORT: '22' });
    eq(env.HOST, 'node-7.lan', 'HOST passed through');
    eq(env.PORT, '22', 'PORT passed through');
    eq(env.PATH, process.env.PATH, "parent's PATH preserved");
  });

  it('rejects BASH_ENV / ENV / BASH_FUNC_* — shellshock-class injection paths (round 2 Fork 1 Finding 1)', () => {
    const env = runner._envWithShadowGuard('bad', {
      BASH_ENV: '/tmp/evil.sh',
      ENV: '/tmp/evil-env.sh',
      BASH_FUNC_f: '() { :;}; /bin/evil',           // shellshock-class exported fn
      'BASH_FUNC_x%%': '() { :;}; echo evil',       // the GNU bash-5+ encoded form
      HOST: 'node-7.lan',
    });
    assert(!('BASH_ENV' in env) || env.BASH_ENV === process.env.BASH_ENV, 'BASH_ENV refused');
    assert(!('ENV' in env) || env.ENV === process.env.ENV, 'ENV refused');
    assert(!('BASH_FUNC_f' in env), 'BASH_FUNC_<name> refused by prefix match');
    assert(!('BASH_FUNC_x%%' in env), 'BASH_FUNC_<name>%% refused by prefix match (bash-5 encoding)');
    eq(env.HOST, 'node-7.lan', 'non-shadowing values still passed');
  });

  it('a port named PATH / LD_PRELOAD / etc is DROPPED unconditionally', () => {
    const origPath = process.env.PATH;
    const origSh = process.env.SHELL;
    const origLD = process.env.LD_PRELOAD;      // probably undefined — the point.
    const env = runner._envWithShadowGuard('bad', {
      PATH: '/attacker/bin:/tmp',
      LD_PRELOAD: '/tmp/evil.so',
      LD_LIBRARY_PATH: '/tmp',
      DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
      SHELL: '/tmp/evil-shell',
      HOST: 'node-7.lan',
    });
    eq(env.PATH, origPath, 'malicious PATH was NOT applied');
    eq(env.LD_PRELOAD, origLD, 'LD_PRELOAD was NOT injected (even when parent lacks it)');
    eq(env.LD_LIBRARY_PATH, process.env.LD_LIBRARY_PATH, 'LD_LIBRARY_PATH refused');
    eq(env.DYLD_INSERT_LIBRARIES, process.env.DYLD_INSERT_LIBRARIES, 'DYLD_INSERT_LIBRARIES refused');
    eq(env.SHELL, origSh, 'SHELL preserved from parent');
    eq(env.HOST, 'node-7.lan', 'non-shadowing values still passed');
  });

  it('null / undefined values map works gracefully', () => {
    const env = runner._envWithShadowGuard('a', null);
    eq(typeof env.PATH, 'string', 'parent env still inherited');
    const env2 = runner._envWithShadowGuard('a', undefined);
    eq(typeof env2.PATH, 'string', 'parent env still inherited');
  });
});

report();
