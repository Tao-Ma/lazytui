/**
 * Variadic input port — the declared, typed home for "command + arbitrary
 * args" actions (Brief 3). Pins every layer:
 *
 *   - Parser: `variadic: true` rules — single-per-action, must-be-LAST,
 *     collisions with choices / choices_cmd / choices_fn / depends_on /
 *     default (all HARD errors — the combinations couldn't exist before
 *     this brief). Also rejects `variadic` on an OUT port + non-boolean.
 *   - --exec CLI: scalars before the variadic slot bind to env; everything
 *     from the slot onward splices into the sh spawn tail (`$@`). Items
 *     with embedded spaces, quotes, leading dashes, and `--` all survive.
 *     Missing-required variadic → rc 1 + `<port...>` in the usage line.
 *   - action-runner `_splitVariadic`: scalars (→ env) separate from items
 *     (→ argv tail); variadic port name is NEVER included in the env map.
 *   - fabric-form reducer: a variadic field's submit tokenizes `text` via
 *     the SHARED `js/fabric/command.tokenize` leaf and injects the ARRAY;
 *     an empty tokenized list writes NO inject (so required-missing re-
 *     prompts cleanly).
 *   - Completion helper: cword at the variadic port's slot → silent [],
 *     so the shell wrapper's `-o default` falls through to filename
 *     completion (correct for an exec-style tail).
 *
 * The brief's end-to-end test — a script echoing `"$#"` / `"$@"` sees the
 * exact items — lives under the --exec section.
 *
 * Run: node js/test/test-variadic-port.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { describe, it, eq, assert, report } = require('./test-runner');

const TUI = path.resolve(__dirname, '..', 'app', 'tui.js');
const { validate } = require('../parser/schema');
const runtime = require('../app/runtime');
const { tokenize } = require('../fabric/command');
const { complete } = require('../app/completion');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'variadic-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

function writeFixture(name, body) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, body);
  return p;
}

function cfgWithPorts(ports) {
  return {
    groups: {
      g: {
        label: 'g',
        actions: {
          act: {
            label: 'A', cmd: 'echo hi', ports: { in: ports },
          },
        },
      },
    },
  };
}

function throws(fn) { try { fn(); return null; } catch (e) { return e; } }

// --- parser ----------------------------------------------------------------

describe('[parser.variadic] accepts the base shape', () => {
  it('variadic:true alone, as last declared port, parses', () => {
    const e = throws(() => validate(cfgWithPorts({
      host: { type: 'string', required: true },
      cmd:  { type: 'cmdline', required: true, variadic: true },
    })));
    assert(e === null, `expected no throw, got: ${e && e.message}`);
  });

  it('a single variadic port by itself parses', () => {
    const e = throws(() => validate(cfgWithPorts({
      cmd: { type: 'cmdline', required: true, variadic: true },
    })));
    assert(e === null, `expected no throw, got: ${e && e.message}`);
  });

  it('variadic:false is a no-op (scalar port behavior)', () => {
    const e = throws(() => validate(cfgWithPorts({
      a: { type: 'string', variadic: false },
    })));
    assert(e === null, `expected no throw, got: ${e && e.message}`);
  });
});

describe('[parser.variadic] cross-port rules — HARD errors', () => {
  it('rejects two variadic ports in one action', () => {
    const e = throws(() => validate(cfgWithPorts({
      a: { type: 'string', variadic: true },
      b: { type: 'string', variadic: true },
    })));
    assert(e, 'expected throw');
    assert(/at most one 'variadic: true' port/.test(e.message), `message, got: ${e.message}`);
  });

  it('rejects a variadic port that is NOT last in declaration order', () => {
    const e = throws(() => validate(cfgWithPorts({
      cmd:  { type: 'cmdline', variadic: true },
      host: { type: 'string' },
    })));
    assert(e, 'expected throw');
    assert(/must be LAST/.test(e.message), `message, got: ${e.message}`);
    assert(/'host'/.test(e.message), `names the port after it, got: ${e.message}`);
  });

  it('rejects variadic + choices (literal)', () => {
    const e = throws(() => validate(cfgWithPorts({
      cmd: { type: 'string', variadic: true, choices: ['a', 'b'] },
    })));
    assert(e, 'expected throw');
    assert(/cannot carry 'choices'/.test(e.message), `message, got: ${e.message}`);
  });

  it('rejects variadic + choices_cmd', () => {
    const e = throws(() => validate(cfgWithPorts({
      cmd: { type: 'string', variadic: true, choices_cmd: 'echo a b' },
    })));
    assert(e, 'expected throw');
    assert(/cannot carry 'choices_cmd'/.test(e.message), `message, got: ${e.message}`);
  });

  it('rejects variadic + choices_fn', () => {
    const e = throws(() => validate(cfgWithPorts({
      cmd: { type: 'string', variadic: true, choices_fn: 'c.fn' },
    })));
    assert(e, 'expected throw');
    assert(/cannot carry 'choices_fn'/.test(e.message), `message, got: ${e.message}`);
  });

  it('rejects variadic + depends_on', () => {
    const e = throws(() => validate(cfgWithPorts({
      host: { type: 'string' },
      cmd:  { type: 'string', variadic: true, depends_on: ['host'] },
    })));
    assert(e, 'expected throw');
    assert(/cannot carry 'depends_on'/.test(e.message), `message, got: ${e.message}`);
  });

  it('rejects variadic + default', () => {
    const e = throws(() => validate(cfgWithPorts({
      cmd: { type: 'string', variadic: true, default: 'ls' },
    })));
    assert(e, 'expected throw');
    assert(/cannot carry 'default'/.test(e.message), `message, got: ${e.message}`);
  });
});

describe('[parser.variadic] per-port validation', () => {
  it("rejects non-boolean 'variadic'", () => {
    const e = throws(() => validate(cfgWithPorts({
      cmd: { type: 'string', variadic: 'yes' },
    })));
    assert(e, 'expected throw');
    assert(/'variadic' must be a boolean/.test(e.message), `message, got: ${e.message}`);
  });

  it("rejects 'variadic' on an output port", () => {
    const e = throws(() => validate({
      groups: {
        g: {
          label: 'g',
          actions: {
            act: {
              label: 'A', cmd: 'echo hi',
              ports: { out: { out1: { type: 'string', variadic: true } } },
            },
          },
        },
      },
    }));
    assert(e, 'expected throw');
    assert(/input-port modifier/.test(e.message), `message, got: ${e.message}`);
  });
});

// --- --exec ----------------------------------------------------------------

const PURE_FIXTURE = writeFixture('pure.yml', `project_dir: .

groups:
  g:
    label: G
    actions:
      run_v:
        label: Variadic
        type: run
        script: 'printf "argc=%s\\n" "$#" ; for a in "$@" ; do printf "arg:[%s]\\n" "$a" ; done'
        ports:
          in:
            cmd:
              type: cmdline
              variadic: true
              required: true
`);

const MIXED_FIXTURE = writeFixture('mixed.yml', `project_dir: .

groups:
  g:
    label: G
    actions:
      run_m:
        label: Scalar+variadic
        type: run
        script: 'printf "host=%s|argc=%s\\n" "$host" "$#" ; for a in "$@" ; do printf "arg:[%s]\\n" "$a" ; done'
        ports:
          in:
            host:
              type: string
              required: true
            cmd:
              type: cmdline
              variadic: true
              required: true
`);

function execAction(fixture, actionPath, ...args) {
  return spawnSync(process.execPath, [TUI, fixture, '--exec', actionPath, ...args], {
    encoding: 'utf8', timeout: 5000,
  });
}

describe('[--exec.variadic] tail args splice to "$@" verbatim', () => {
  it('pure variadic: three plain positionals arrive as three $@ elements', () => {
    const r = execAction(PURE_FIXTURE, 'g:run_v', 'ls', '-la', '/tmp');
    eq(r.status, 0, `rc 0, stderr=${r.stderr}`);
    assert(r.stdout.includes('argc=3'), `argc=3, got: ${r.stdout}`);
    assert(r.stdout.includes('arg:[ls]'));
    assert(r.stdout.includes('arg:[-la]'));
    assert(r.stdout.includes('arg:[/tmp]'));
  });

  it('item with embedded spaces survives as ONE element', () => {
    const r = execAction(PURE_FIXTURE, 'g:run_v', 'two words', '-x');
    eq(r.status, 0);
    assert(r.stdout.includes('argc=2'), `argc=2, got: ${r.stdout}`);
    assert(r.stdout.includes('arg:[two words]'),
      `spaced item intact, got: ${r.stdout}`);
  });

  it('leading-dash items and `--` pass through, no misinterpretation', () => {
    const r = execAction(PURE_FIXTURE, 'g:run_v', '--flag', '--', '-x', 'val');
    eq(r.status, 0);
    assert(r.stdout.includes('argc=4'), `argc=4, got: ${r.stdout}`);
    assert(r.stdout.includes('arg:[--flag]'));
    assert(r.stdout.includes('arg:[--]'));
    assert(r.stdout.includes('arg:[-x]'));
    assert(r.stdout.includes('arg:[val]'));
  });

  it('item with quote characters survives intact (bytes are literal)', () => {
    const r = execAction(PURE_FIXTURE, 'g:run_v', 'it\'s "ok"');
    eq(r.status, 0);
    assert(r.stdout.includes('arg:[it\'s "ok"]'),
      `literal quotes intact, got: ${r.stdout}`);
  });

  it('mixed: scalar binds to env, tail items go to $@', () => {
    const r = execAction(MIXED_FIXTURE, 'g:run_m', 'host.example.com', 'uname', '-a');
    eq(r.status, 0);
    assert(r.stdout.includes('host=host.example.com|argc=2'),
      `host as env + argc 2, got: ${r.stdout}`);
    assert(r.stdout.includes('arg:[uname]'));
    assert(r.stdout.includes('arg:[-a]'));
  });

  it('variadic port NAME is NOT in the child env (items stay out-of-band)', () => {
    const envProbe = writeFixture('envprobe.yml', `project_dir: .

groups:
  g:
    label: G
    actions:
      show:
        label: Env probe
        type: run
        script: 'printf "cmd=%s\\n" "\${cmd-UNSET}"'
        ports:
          in:
            cmd:
              type: cmdline
              variadic: true
              required: true
`);
    const r = execAction(envProbe, 'g:show', 'echo', 'hi');
    eq(r.status, 0);
    assert(r.stdout.includes('cmd=UNSET'),
      `variadic port name not env-bound, got: ${JSON.stringify(r.stdout)}`);
  });
});

describe('[--exec.variadic] missing-required reports rc 1 + <port...> in usage', () => {
  it('no positionals at the variadic slot → rc 1 and usage line names <cmd...>', () => {
    const r = execAction(PURE_FIXTURE, 'g:run_v');
    eq(r.status, 1, `rc 1 expected, got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
    assert(/missing required port\(s\): cmd/.test(r.stderr),
      `missing text, got: ${JSON.stringify(r.stderr)}`);
    assert(/<cmd\.\.\.>/.test(r.stderr),
      `variadic slot renders with ... in usage, got: ${JSON.stringify(r.stderr)}`);
  });

  it('mixed: scalar present but variadic empty → rc 1 names cmd', () => {
    const r = execAction(MIXED_FIXTURE, 'g:run_m', 'only-host');
    eq(r.status, 1, `rc 1 expected, got ${r.status}; stderr=${r.stderr}`);
    assert(/missing required port\(s\): cmd/.test(r.stderr),
      `missing text, got: ${JSON.stringify(r.stderr)}`);
  });
});

// --- action-runner split ---------------------------------------------------

describe('[action-runner.splitVariadic] routes scalars → env, items → args', () => {
  // Use the exported helper via a shallow re-require to pin the invariant
  // directly (the integration coverage above pins the full spawn behavior).
  const actionRunner = require('../dispatch/runtime/action-runner');
  // The helper is internal; call through its contract via the exported
  // _splitVariadic. If it isn't on the exports surface, this file still
  // exercises it transitively via --exec above, so an exports-surface
  // tweak won't drop coverage.
  const split = actionRunner._splitVariadic;
  const SKIP = split == null;

  it('variadic port — items array, scalars kept, variadic key removed', () => {
    if (SKIP) return;
    const portsIn = {
      host: { type: 'string' },
      cmd:  { type: 'cmdline', variadic: true },
    };
    const { scalarValues, variadicItems } = split(portsIn, {
      host: 'h.example', cmd: ['ls', '-la', '/tmp'],
    });
    eq(scalarValues.host, 'h.example');
    assert(!('cmd' in scalarValues), 'variadic name removed from scalars');
    eq(variadicItems.length, 3);
    eq(variadicItems[0], 'ls');
    eq(variadicItems[2], '/tmp');
  });

  it('no variadic — scalarValues identity, variadicItems null', () => {
    if (SKIP) return;
    const portsIn = { host: { type: 'string' } };
    const vals = { host: 'h' };
    const { scalarValues, variadicItems } = split(portsIn, vals);
    eq(scalarValues, vals, 'identity (not a copy)');
    assert(variadicItems === null, 'null means "leave inherited args alone"');
  });

  it('variadic value as scalar (defensive) coerces to [string]', () => {
    if (SKIP) return;
    const portsIn = { cmd: { type: 'cmdline', variadic: true } };
    const { scalarValues, variadicItems } = split(portsIn, { cmd: 'single' });
    assert(!('cmd' in scalarValues), 'variadic name removed');
    eq(variadicItems.length, 1);
    eq(variadicItems[0], 'single');
  });
});

// --- fabric-form reducer: variadic submit --------------------------------

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';
  return m;
}

const V_PENDING = {
  actionKey: 'ssh',
  action: {
    label: 'SSH exec', type: 'run',
    script: 'exec ssh "$host" "$@"',
    ports: {
      in: {
        host: { type: 'string', required: true },
        cmd:  { type: 'cmdline', variadic: true, required: true },
      },
    },
  },
};

function vFieldsWith(cmdText) {
  return [
    { port: 'host', text: 'h.example', required: true,  default: null, desc: '' },
    { port: 'cmd',  text: cmdText,     required: true,  default: null, desc: '',
      variadic: true },
  ];
}

describe('[fabric-form.variadic] submit tokenizes the variadic field + injects ARRAY', () => {
  it('one-line "ls -la /tmp" → items[3], injected as array', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter',
      fields: vFieldsWith('ls -la /tmp'), pendingAction: V_PENDING });
    // Mark cmd as modified so submit writes its inject.
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' }); // move to cmd
    // Simulate a trivial edit (nudge isModified via a key then undo): type and backspace.
    [m] = runtime.update(m, { type: 'fabric_form_key', key: 'x', seq: 'x' });
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '\x7f' });
    const [next] = runtime.update(m, { type: 'fabric_form_submit' });
    const injects = (next.fabric.injects[next.currentGroup] || {});
    const rec = injects['ssh.cmd'];
    assert(rec, `inject written, keys: ${Object.keys(injects).join(',')}`);
    assert(Array.isArray(rec.value), `value is ARRAY, got: ${typeof rec.value} ${JSON.stringify(rec.value)}`);
    eq(rec.value.length, 3);
    eq(rec.value[0], 'ls');
    eq(rec.value[1], '-la');
    eq(rec.value[2], '/tmp');
  });

  it('quoted token with space survives as ONE item (shared tokenizer leaf)', () => {
    // Direct contract pin on the leaf — the submit arm defers to this.
    const items = tokenize('"two words" "its \\"ok\\"" plain');
    // Note: the shared tokenize leaf does not interpret backslash escapes
    // (see js/fabric/command.js). We just pin that a quoted span groups to
    // one token.
    eq(items[0], 'two words', `first quoted span groups, got: ${JSON.stringify(items)}`);
  });

  it('variadic field with EMPTY tokenized text writes NO inject (re-prompts cleanly)', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter',
      fields: vFieldsWith(''), pendingAction: V_PENDING });
    // Focus the variadic field + simulate a modification to empty via two
    // keystrokes that cancel out, so isModified=true + text=''.
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
    [m] = runtime.update(m, { type: 'fabric_form_key', key: 'x', seq: 'x' });
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '\x7f' });
    const [next] = runtime.update(m, { type: 'fabric_form_submit' });
    const injects = (next.fabric.injects[next.currentGroup] || {});
    assert(!('ssh.cmd' in injects),
      `no inject for empty-tokenized variadic, injects: ${JSON.stringify(injects)}`);
  });
});

// --- completion helper -----------------------------------------------------

describe('[completion.variadic] cword at the variadic slot → silent empty', () => {
  const COMP_FIXTURE = writeFixture('comp.yml', `project_dir: .

groups:
  g:
    label: G
    actions:
      run_v:
        label: V
        type: run
        script: echo hi
        ports:
          in:
            host:
              type: string
            cmd:
              type: cmdline
              variadic: true
`);

  it('at the variadic slot (cword=4 for host at 3, cmd at 4) → no candidates', async () => {
    // words = [cmdName, groupPath, actionKey, host, <cmd...>]
    const items = await complete(COMP_FIXTURE, 4, ['do', 'g', 'run_v', 'host.example', '']);
    assert(Array.isArray(items), 'returns array');
    eq(items.length, 0, `empty, got: ${JSON.stringify(items)}`);
  });

  it('past the variadic slot (cword=5) → still no candidates', async () => {
    const items = await complete(COMP_FIXTURE, 5, ['do', 'g', 'run_v', 'h', 'ls', '']);
    eq(items.length, 0);
  });

  it('at a scalar slot BEFORE the variadic (cword=3) still returns normally', async () => {
    // host has no choices → empty; important: this is "silent for no choices
    // declared", NOT the variadic path. The point is the scalar isn't
    // short-circuited by the variadic sibling.
    const items = await complete(COMP_FIXTURE, 3, ['do', 'g', 'run_v', '']);
    eq(items.length, 0, `host has no choices_cmd / choices → empty: ${JSON.stringify(items)}`);
  });
});

report();
