/**
 * CLI surfaces for literal `choices:` (Brief 2).
 *
 * - `--complete 3 -- do g act ""` emits literal values directly (no spawn).
 * - `--complete N` for labeled maps emits values ONLY (labels are TUI UX).
 * - `--exec` missing-required `valid <port>:` line serves literal choices too.
 * - `--list` is unaffected.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { describe, it, eq, assert, report } = require('./test-runner');

const TUI = path.resolve(__dirname, '..', 'app', 'tui.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-choices-literal-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const CFG = path.join(TMP, 'c.yml');
fs.writeFileSync(CFG, `project_dir: .

groups:
  svc:
    label: Services
    actions:
      restart:
        label: Restart
        type: run
        script: echo restart "$name"
        ports:
          in:
            name:
              type: string
              required: true
              choices:
                - nginx
                - sshd
                - postgres
      labeled:
        label: Labeled
        type: run
        script: echo tunnel "$mode"
        ports:
          in:
            mode:
              type: string
              required: true
              choices:
                - { value: --full-tunnel,    label: all traffic via VPN }
                - { value: --no-full-tunnel, label: split tunnel }
`);

function run(...args) {
  return spawnSync(process.execPath, [TUI, CFG, ...args], {
    encoding: 'utf8', timeout: 5000,
  });
}
function lines(s) { return s.split('\n').map(l => l.trim()).filter(Boolean); }

describe('[cli.literal] --complete emits literal values directly, no spawn', () => {
  it('scalar literal: 3 items offered', () => {
    const r = run('--complete', '3', '--', 'do', 'svc', 'restart', '');
    eq(r.status, 0, `expected 0, got ${r.status}; stderr=${r.stderr.trim()}`);
    const got = new Set(lines(r.stdout));
    for (const v of ['nginx', 'sshd', 'postgres']) {
      assert(got.has(v), `missing literal value "${v}" — got: ${JSON.stringify([...got])}`);
    }
  });

  it('labeled literal: VALUES only (not labels — matches choices_cmd+labeled contract)', () => {
    const r = run('--complete', '3', '--', 'do', 'svc', 'labeled', '');
    eq(r.status, 0, `expected 0, got ${r.status}; stderr=${r.stderr.trim()}`);
    const got = new Set(lines(r.stdout));
    assert(got.has('--full-tunnel'), `missing value --full-tunnel — got: ${JSON.stringify([...got])}`);
    assert(got.has('--no-full-tunnel'), `missing value --no-full-tunnel — got: ${JSON.stringify([...got])}`);
    assert(!got.has('all traffic via VPN'),
      `label leaked into completion candidates — got: ${JSON.stringify([...got])}`);
    assert(!got.has('split tunnel'),
      `label leaked into completion candidates — got: ${JSON.stringify([...got])}`);
  });

  it('runs instantly — no 2.5s timeout window to burn through (vs choices_cmd)', () => {
    const t0 = Date.now();
    run('--complete', '3', '--', 'do', 'svc', 'restart', '');
    const elapsed = Date.now() - t0;
    // choices_cmd lookups spin up a sh subprocess with a 2.5s cap;
    // literal is a pure in-process read + print. Pin "obviously fast"
    // without being paranoid about CI noise.
    assert(elapsed < 1500, `literal completion should be fast (<1.5s wall), took ${elapsed}ms`);
  });
});

describe('[cli.literal] --exec missing-required surfaces literal choices on `valid <port>:` line', () => {
  it('`valid name: nginx, sshd, postgres` printed when name is missing', () => {
    const r = run('--exec', 'svc:restart');
    assert(r.status !== 0, `--exec with missing port should fail, got rc=${r.status}`);
    assert(/missing required port\(s\): name/.test(r.stderr),
      `stderr should name the missing port — got: ${r.stderr.trim()}`);
    assert(/valid name:.*nginx.*sshd.*postgres/.test(r.stderr),
      `stderr should list literal values — got: ${r.stderr.trim()}`);
  });

  it('labeled literal: `valid mode:` line also lists VALUES only', () => {
    const r = run('--exec', 'svc:labeled');
    assert(r.status !== 0);
    assert(/valid mode:.*--full-tunnel.*--no-full-tunnel/.test(r.stderr),
      `labeled port's valid line should show values — got: ${r.stderr.trim()}`);
    assert(!/all traffic via VPN/.test(r.stderr),
      `label should NOT leak into usage-error line — got: ${r.stderr.trim()}`);
  });
});

describe('[cli.literal] --list unaffected by literal choices', () => {
  it('--list shows the actions normally', () => {
    const r = run('--list');
    eq(r.status, 0);
    assert(/svc:restart/.test(r.stdout), `svc:restart missing from --list — got: ${r.stdout.trim()}`);
    assert(/svc:labeled/.test(r.stdout), `svc:labeled missing from --list — got: ${r.stdout.trim()}`);
  });
});

report();
