/**
 * `--lint` CLI mode (Brief 2) — contract test.
 *
 * Pins the rc contract (0 clean / 1 warnings-only / 2 ≥1 hard error), the
 * stdout line format (`<severity> <code> <context>: <message>` with context
 * dropped when empty), the stderr summary (`N errors, M warnings`), the
 * --json shape (array of {severity, code, context, message}; no summary),
 * and that `--list` output is unchanged by the new flag (the parser
 * warnings that --lint surfaces must NOT leak onto --list's stdout).
 *
 * Parser warning codes are a stable API as of this flag's debut — this
 * file is the regression trip for a rename/removal.
 *
 * Run: node js/test/test-cli-lint.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { describe, it, eq, assert, report } = require('./test-runner');

const TUI = path.resolve(__dirname, '..', 'app', 'tui.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

function writeFixture(name, body) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, body);
  return p;
}

function tui(fixture, ...args) {
  return spawnSync(process.execPath, [TUI, fixture, ...args], {
    encoding: 'utf8', timeout: 5000,
  });
}

// ---- fixtures --------------------------------------------------------------

const CLEAN = writeFixture('clean.yml', `project_dir: .

groups:
  g:
    label: G
    actions:
      hello:
        label: Hello
        type: run
        script: echo hi
`);

// Shadowed port NAME → parser emits a port.env_shadow warning (warn-and-keep
// per round 5 — the runtime guard is the actual defense; the warning is UX).
const WARN = writeFixture('warn.yml', `project_dir: .

groups:
  g:
    label: G
    actions:
      shadow_path:
        label: Shadow PATH
        type: run
        script: 'echo "$PATH"'
        ports:
          in:
            PATH:
              type: string
              required: true
`);

// Empty YAML file → parse() throws ParseError('config file is empty') — the
// shape we rely on for the error branch.
const EMPTY = writeFixture('empty.yml', '');

// ---- rc contract -----------------------------------------------------------

describe('[--lint] rc contract — 0 clean / 1 warnings-only / 2 any error', () => {
  it('clean fixture → rc 0, stdout empty, stderr summary names 0/0', () => {
    const r = tui(CLEAN, '--lint');
    eq(r.status, 0, `rc 0 expected, got ${r.status}; stderr=${r.stderr}`);
    eq(r.stdout, '', `stdout empty, got: ${JSON.stringify(r.stdout)}`);
    assert(/^0 errors, 0 warnings$/m.test(r.stderr),
      `stderr summary line, got: ${JSON.stringify(r.stderr)}`);
  });

  it('warning-only fixture → rc 1, one stdout line, port.env_shadow code', () => {
    const r = tui(WARN, '--lint');
    eq(r.status, 1, `rc 1 expected, got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
    const lines = r.stdout.split('\n').filter(Boolean);
    eq(lines.length, 1, `one finding line expected, got ${lines.length}: ${JSON.stringify(lines)}`);
    const line = lines[0];
    assert(line.startsWith('warning port.env_shadow '),
      `line must start with 'warning <code>', got: ${JSON.stringify(line)}`);
    assert(line.includes(": port name 'PATH'"),
      `reason text preserved, got: ${JSON.stringify(line)}`);
    assert(/^0 errors, 1 warnings$/m.test(r.stderr),
      `stderr summary names 0/1, got: ${JSON.stringify(r.stderr)}`);
  });

  it('hard-error fixture (empty YAML) → rc 2, error line, parse_error code', () => {
    const r = tui(EMPTY, '--lint');
    eq(r.status, 2, `rc 2 expected, got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
    const lines = r.stdout.split('\n').filter(Boolean);
    eq(lines.length, 1, `one finding line expected, got: ${JSON.stringify(lines)}`);
    assert(lines[0].startsWith('error parse_error'),
      `error line prefix, got: ${JSON.stringify(lines[0])}`);
    assert(/config file is empty/.test(lines[0]),
      `error reason preserved, got: ${JSON.stringify(lines[0])}`);
    assert(/^1 errors, 0 warnings$/m.test(r.stderr),
      `stderr summary names 1/0, got: ${JSON.stringify(r.stderr)}`);
  });
});

// ---- line format -----------------------------------------------------------

describe('[--lint] text line format — context dropped when empty, kept otherwise', () => {
  it('warning line format: `<severity> <code> <context>: <message>`', () => {
    const r = tui(WARN, '--lint');
    const line = r.stdout.split('\n').filter(Boolean)[0];
    // Shape: "warning port.env_shadow <ctx>: <msg>" — split on the FIRST ": "
    // AFTER the "warning <code> " prefix so the port label's own ' can live
    // in context.
    const m = /^warning (\S+) ([^:]+(?:: [^:]+)*?): (.+)$/.exec(line);
    assert(m, `line must match "warning <code> <context>: <message>", got: ${JSON.stringify(line)}`);
    eq(m[1], 'port.env_shadow');
    assert(m[2].startsWith("group 'g'"), `context carries pctx, got: ${JSON.stringify(m[2])}`);
    assert(m[3].startsWith("port name 'PATH'"), `reason body, got: ${JSON.stringify(m[3])}`);
  });
});

// ---- --json round-trip -----------------------------------------------------

describe('[--lint --json] shape and summary suppression', () => {
  it('clean fixture → `[]` on stdout, NO summary on stderr', () => {
    const r = tui(CLEAN, '--lint', '--json');
    eq(r.status, 0);
    eq(r.stdout.trim(), '[]', `empty array, got: ${JSON.stringify(r.stdout)}`);
    assert(!/errors.*warnings/.test(r.stderr),
      `summary must be suppressed in --json mode, got stderr=${JSON.stringify(r.stderr)}`);
  });

  it('warning fixture → one entry with severity/code/context/message keys', () => {
    const r = tui(WARN, '--lint', '--json');
    eq(r.status, 1);
    const arr = JSON.parse(r.stdout);
    assert(Array.isArray(arr), 'JSON output must be an array');
    eq(arr.length, 1);
    const f = arr[0];
    eq(f.severity, 'warning');
    eq(f.code, 'port.env_shadow');
    assert(f.context && f.context.includes("port 'in.PATH'"),
      `context carries pctx, got: ${JSON.stringify(f.context)}`);
    assert(f.message && f.message.startsWith("port name 'PATH'"),
      `message is the reason body, got: ${JSON.stringify(f.message)}`);
  });

  it('error fixture → one entry severity=error, parse_error code', () => {
    const r = tui(EMPTY, '--lint', '--json');
    eq(r.status, 2);
    const arr = JSON.parse(r.stdout);
    eq(arr.length, 1);
    eq(arr[0].severity, 'error');
    eq(arr[0].code, 'parse_error');
    assert(/empty/.test(arr[0].message), `reason body, got: ${JSON.stringify(arr[0].message)}`);
  });
});

// ---- parity with --list ----------------------------------------------------

describe('[--lint] does NOT leak into --list behavior', () => {
  it('--list on a WARN fixture carries the actions and NO parser-warning line', () => {
    const r = tui(WARN, '--list');
    eq(r.status, 0);
    assert(r.stdout.includes('g:shadow_path'),
      `--list stdout carries action rows, got: ${JSON.stringify(r.stdout)}`);
    // The new --lint flag MUST NOT change --list's stdout — warnings never
    // belonged on --list's stdout (they could go to stderr, but that is
    // out of scope here).
    assert(!/port\.env_shadow/.test(r.stdout),
      `--list stdout must not carry lint warning codes, got: ${JSON.stringify(r.stdout)}`);
    assert(!/^warning /m.test(r.stdout),
      `--list stdout must not emit lint-style lines, got: ${JSON.stringify(r.stdout)}`);
  });
});

// ---- missing config path ---------------------------------------------------

describe('[--lint] missing config path falls through to USAGE (same as --list)', () => {
  it('no positional path → USAGE + non-zero rc; no lint finding emitted', () => {
    const r = spawnSync(process.execPath, [TUI, '--lint'], {
      encoding: 'utf8', timeout: 5000,
    });
    assert(r.status !== 0, `non-zero rc expected, got ${r.status}`);
    // USAGE lives on stderr; nothing lint-style on stdout.
    assert(!/^(warning|error) /m.test(r.stdout),
      `no lint-style line on stdout, got: ${JSON.stringify(r.stdout)}`);
  });
});

report();
