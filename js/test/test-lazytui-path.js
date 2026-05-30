/**
 * LAZYTUI_PATH trampoline — verifies the bin/lazytui wrapper honors
 * the env var: fails loud on invalid, skips on self-pointer, redirects
 * on valid target.
 *
 * Spawns bin/lazytui as a subprocess with controlled env. The "target"
 * for the trampoline-active case is a tmp directory with a stub
 * js/tui.js that just prints its location and exits.
 *
 * Run: node js/test/test-lazytui-path.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { describe, it, eq, assert, report } = require('./test-runner');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'lazytui');

function run(env, args = []) {
  // Inherit PATH so node is findable; drop any pre-existing LAZYTUI_PATH
  // so the test env is the only source of truth.
  const baseEnv = { ...process.env };
  delete baseEnv.LAZYTUI_PATH;
  return spawnSync(BIN, args, {
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
    timeout: 3000,
  });
}

function mkTmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-path-'));
}

describe('[1] invalid LAZYTUI_PATH fails loud', () => {
  it('non-existent path → exit 1, error on stderr', () => {
    const r = run({ LAZYTUI_PATH: '/definitely/does/not/exist/nope' });
    eq(r.status, 1, 'exit code');
    assert(/not a directory/.test(r.stderr), `expected "not a directory" in stderr: ${r.stderr}`);
  });
  it('valid dir without js/app/tui.js → exit 1, descriptive error', () => {
    const tmp = mkTmpdir();
    try {
      const r = run({ LAZYTUI_PATH: tmp });
      eq(r.status, 1);
      assert(/no js\/app\/tui\.js/.test(r.stderr), `expected "no js/app/tui.js" in stderr: ${r.stderr}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('[2] valid LAZYTUI_PATH redirects to that lazytui', () => {
  it('stub target runs instead of the local install', () => {
    const tmp = mkTmpdir();
    try {
      fs.mkdirSync(path.join(tmp, 'js', 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'js', 'app', 'tui.js'),
        "console.log('STUB_RAN_FROM=' + __dirname); process.exit(0);\n",
      );
      const r = run({ LAZYTUI_PATH: tmp });
      eq(r.status, 0);
      assert(r.stdout.includes(`STUB_RAN_FROM=${path.join(tmp, 'js', 'app')}`),
        `expected stub output, got: ${JSON.stringify(r.stdout)}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('[3] same-dir guard: LAZYTUI_PATH == local root → no trampoline', () => {
  it('runs the real tui.js with usage output', () => {
    // `--help` makes the real tui.js print usage then exit non-zero
    // (no config arg). What matters: we see the REAL tui.js's output,
    // not a redirect to anywhere else. The trampoline would have
    // exec'd the same file anyway in this case, so the test is mostly
    // that we didn't crash or recurse.
    const r = run({ LAZYTUI_PATH: REPO_ROOT }, ['--help']);
    assert(r.stdout.includes('Usage:') || r.stderr.includes('Usage:'),
      `expected Usage: in output, got stdout=${r.stdout || ''} stderr=${r.stderr || ''}`);
  });
});

report();
