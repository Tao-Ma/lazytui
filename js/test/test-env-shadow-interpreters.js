/**
 * Env-shadow denylist — interpreter-injection class (Brief 1, post-slice-1).
 *
 * The shared leaf `js/leaves/security/env-shadow.js` grew a batch of
 * interpreter / git-exec names (NODE_OPTIONS, PYTHONPATH, PERL5OPT, …) on
 * top of the slice-1 OS-loader + shell-startup set. This file pins the new
 * names across all four callers the leaf feeds: `isShadowedEnvName` itself,
 * `filterShadowedPortValues` (action-runner), the parser `port.env_shadow`
 * warning, and the end-to-end --exec path (child env + viewer line).
 *
 * The leaf is a Set, so one layer passes implies all layers pass — this
 * file deliberately exercises each layer with the FULL new list so a future
 * removal or rename breaks the layer whose contract it belongs to, not just
 * the leaf.
 *
 * Run: node js/test/test-env-shadow-interpreters.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { describe, it, eq, assert, report } = require('./test-runner');

const { ENV_SHADOW_DENY, isShadowedEnvName } = require('../leaves/security/env-shadow');
const { filterShadowedPortValues } = require('../dispatch/runtime/action-runner');
const { validate } = require('../parser/schema');

// Full list of names Brief 1 added — kept here as the test's independent
// source of truth so a future deletion from the leaf (regression) fails this
// file rather than silently narrowing the defense.
const INTERPRETER_NAMES = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
  'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME',
  'PERL5LIB', 'PERL5OPT', 'PERL5DB',
  'RUBYOPT', 'RUBYLIB',
  'LUA_PATH', 'LUA_CPATH', 'LUA_INIT',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF',
];

describe('[env-shadow leaf] interpreter + git-exec names match isShadowedEnvName', () => {
  it('every Brief 1 name is in ENV_SHADOW_DENY', () => {
    for (const n of INTERPRETER_NAMES) {
      assert(ENV_SHADOW_DENY.has(n), `expected ${n} in ENV_SHADOW_DENY`);
      assert(isShadowedEnvName(n), `expected isShadowedEnvName(${n}) === true`);
    }
  });

  it('lowercase homographs are NOT matched (port names are case-sensitive)', () => {
    for (const n of INTERPRETER_NAMES) {
      const low = n.toLowerCase();
      // _JAVA_OPTIONS → _java_options; still different literal, still legal.
      assert(!isShadowedEnvName(low), `lowercase ${low} must stay legal`);
    }
  });

  it('existing slice-1 members still match (regression guard — same Set)', () => {
    for (const n of ['PATH', 'SHELL', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV']) {
      assert(isShadowedEnvName(n), `${n} must still match`);
    }
  });

  it('BASH_FUNC_* prefix still fires (shellshock class)', () => {
    assert(isShadowedEnvName('BASH_FUNC_x'));
    assert(isShadowedEnvName('BASH_FUNC_whatever%%'));
    assert(!isShadowedEnvName('bash_func_x'), 'prefix match is case-sensitive');
  });
});

describe('[env-shadow] filterShadowedPortValues drops interpreter names from the spawn env map', () => {
  it('each new name is removed from safe and listed in shadowed', () => {
    for (const n of INTERPRETER_NAMES) {
      const { safe, shadowed } = filterShadowedPortValues({ [n]: 'attacker', other: 'ok' });
      assert(!(n in safe), `${n} must be removed from safe`);
      eq(safe.other, 'ok', 'unrelated keys pass through');
      assert(shadowed.includes(n), `${n} must appear in shadowed[]`);
    }
  });

  it('lowercase homograph is NOT removed', () => {
    const { safe, shadowed } = filterShadowedPortValues({ pythonpath: '/some/path' });
    eq(safe.pythonpath, '/some/path');
    eq(shadowed.length, 0);
  });
});

describe('[env-shadow] parser warns on uppercase port NAMES (port.env_shadow) for Brief 1 names', () => {
  function cfgWithPort(name) {
    return {
      groups: {
        g: {
          label: 'g',
          actions: {
            act: {
              label: 'A', cmd: 'echo hi',
              ports: { in: { [name]: { type: 'string', required: true } } },
            },
          },
        },
      },
    };
  }

  it('every Brief 1 name triggers port.env_shadow', () => {
    for (const n of INTERPRETER_NAMES) {
      const w = [];
      validate(cfgWithPort(n), undefined, w);
      const hit = w.find((x) => x.code === 'port.env_shadow' && x.message.includes(`'${n}'`));
      assert(hit, `expected port.env_shadow for ${n}, got: ${JSON.stringify(w)}`);
    }
  });

  it('lowercase homograph port name does NOT warn (case-sensitive policy)', () => {
    for (const n of INTERPRETER_NAMES) {
      const low = n.toLowerCase();
      const w = [];
      validate(cfgWithPort(low), undefined, w);
      assert(!w.some((x) => x.code === 'port.env_shadow'),
        `lowercase ${low} must not warn, got: ${JSON.stringify(w)}`);
    }
  });
});

// End-to-end: PYTHONPATH chosen as the concrete consumer example from Brief 1
// — a dev9 choices_cmd running `python3 -c '...'` would import attacker code
// if the var reached the child. Pin: the port value does NOT reach the child.
describe('[env-shadow] --exec: PYTHONPATH port value does not reach child env; viewer line names it', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'env-shadow-interp-'));
  process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
  const TUI = path.resolve(__dirname, '..', 'app', 'tui.js');
  const FIXTURE = path.join(TMP, 'pythonpath.yml');
  fs.writeFileSync(FIXTURE, `project_dir: .

groups:
  g:
    label: G
    actions:
      show:
        script: 'printf "PYTHONPATH=%s\\n" "\${PYTHONPATH-UNSET}"'
        type: run
        label: Show PYTHONPATH
        ports:
          in:
            PYTHONPATH:
              type: string
              required: true
`);

  it('rc 0, child env lacks PYTHONPATH, viewer stderr names it', () => {
    const env = { ...process.env };
    delete env.PYTHONPATH; // parent must not already have it; otherwise this test is vacuous
    const r = spawnSync(process.execPath, [TUI, FIXTURE, '--exec', 'g:show', '/attacker/pymod'], {
      encoding: 'utf8', timeout: 5000, env,
    });
    eq(r.status, 0, `rc 0 — action still runs, got ${r.status}, stderr=${r.stderr}`);
    assert(r.stdout.includes('PYTHONPATH=UNSET'),
      `child env must NOT carry PYTHONPATH; got stdout=${JSON.stringify(r.stdout)}`);
    assert(!r.stdout.includes('/attacker/pymod'),
      `attacker value must not reach child env; got stdout=${JSON.stringify(r.stdout)}`);
    assert(r.stderr.includes('shadowing env') && r.stderr.includes('PYTHONPATH'),
      `viewer warning must name PYTHONPATH, got stderr=${JSON.stringify(r.stderr)}`);
  });
});

report();
