/**
 * Terminal differential matrix — render corpus under multiple TERM/COLORTERM envs.
 *
 * [[reference_ci_color_depth_test_fragility]]: color-asserting tests pass
 * local (truecolor by default) but FAILED on CI (16-color only). v0.6.18's
 * first tag broke on exactly that. test-color-depth.js probes the pure
 * `downgradeAnsi` + `detectColorDepth` functions but doesn't matrix the end-
 * to-end render path under REAL env values the way CI/tmux/raw-xterm/dumb-
 * terminal would present them.
 *
 * This file closes that gap by `env -i TERM=... node -e '<render probe>'`
 * for each terminal class, asserting the emitted bytes and (for dumb) that
 * nothing crashes. Each case strips ALL env so the probe sees only what we
 * inject — mirrors the CI shape test-cmdline-args.js and the memory note
 * cite (reproduce with `env -i … node run-tests.js`).
 *
 * Matrix:
 *   TERM=xterm-direct      → truecolor (38;2 bytes preserved)
 *   COLORTERM=truecolor    → truecolor (even with TERM=xterm)
 *   TERM=xterm-256color    → 256 (38;5 bytes)
 *   TERM=screen            → 16 (tmux-style minimal)
 *   TERM=xterm             → 16 (plain xterm, no 256 suffix)
 *   TERM=dumb              → 16 fallback, no crash
 *   (no TERM at all)       → 16 fallback, no crash
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { describe, it, eq, assert, report } = require('./test-runner');

const ANSI_LIB = path.resolve(__dirname, '..', 'leaves', 'text', 'ansi.js');
const COLOR_DEPTH_LIB = path.resolve(__dirname, '..', 'leaves', 'render', 'color-depth.js');

/**
 * Spawn a stripped-env node with just the TERM/COLORTERM we want to pin,
 * run `src` as the body, return `{stdout, stderr, status}`. `env -i` style:
 * we build the child env from scratch (no PATH inheritance would break
 * node's own loader, so we keep PATH + HOME; everything else is dropped).
 */
function runUnderEnv({ TERM, COLORTERM, LAZYTUI_COLOR }, src) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  if (TERM !== undefined) env.TERM = TERM;
  if (COLORTERM !== undefined) env.COLORTERM = COLORTERM;
  if (LAZYTUI_COLOR !== undefined) env.LAZYTUI_COLOR = LAZYTUI_COLOR;
  return spawnSync(process.execPath, ['-e', src], { env, encoding: 'utf8', timeout: 5000 });
}

/**
 * Standard render probe: use the public `richToAnsi` + `downgradeAnsi` surface
 * with a representative hex color (#ff8800 — the one test-color-depth.js
 * [4] pins) and the detected depth from env. Writes the raw ANSI bytes to
 * stdout so the parent can inspect them.
 */
function probe(expr) {
  return `
    const ansi = require('${ANSI_LIB}');
    const { detectColorDepth, downgradeAnsi } = require('${COLOR_DEPTH_LIB}');
    const depth = detectColorDepth(process.env);
    const raw = ansi.richToAnsi('${expr}');
    process.stdout.write(JSON.stringify({ depth, bytes: downgradeAnsi(raw, depth) }));
  `;
}

function assertOkJson(r, hint) {
  eq(r.status, 0, `${hint}: expected exit 0, got ${r.status}; stderr=${r.stderr.trim()}`);
  try { return JSON.parse(r.stdout); }
  catch (e) { throw new Error(`${hint}: non-JSON stdout: ${r.stdout}`); }
}

describe('[term-matrix] detectColorDepth under representative TERM values', () => {
  it('TERM=xterm-direct → truecolor; bytes keep 38;2;r;g;b', () => {
    const r = runUnderEnv({ TERM: 'xterm-direct' }, probe('[#ff8800]x[/]'));
    const got = assertOkJson(r, 'xterm-direct');
    eq(got.depth, 'truecolor');
    assert(got.bytes.includes('38;2;255;136;0'),
      `truecolor should keep 38;2 bytes, got: ${JSON.stringify(got.bytes)}`);
  });

  it('COLORTERM=truecolor + TERM=xterm (bare) → still truecolor', () => {
    const r = runUnderEnv({ TERM: 'xterm', COLORTERM: 'truecolor' }, probe('[#ff8800]x[/]'));
    const got = assertOkJson(r, 'xterm+COLORTERM');
    eq(got.depth, 'truecolor');
    assert(got.bytes.includes('38;2;255;136;0'),
      `COLORTERM should override bare TERM, got: ${JSON.stringify(got.bytes)}`);
  });

  it('TERM=xterm-256color → 256; bytes become 38;5;Nmm', () => {
    const r = runUnderEnv({ TERM: 'xterm-256color' }, probe('[#ff8800]x[/]'));
    const got = assertOkJson(r, 'xterm-256color');
    eq(got.depth, '256');
    assert(/38;5;\d{1,3}/.test(got.bytes),
      `256 should emit 38;5;N bytes, got: ${JSON.stringify(got.bytes)}`);
    assert(!got.bytes.includes('38;2;'),
      `256 must NOT keep 38;2 bytes, got: ${JSON.stringify(got.bytes)}`);
  });

  it('TERM=screen → 16; bytes become bare 90-97 / 30-37', () => {
    const r = runUnderEnv({ TERM: 'screen' }, probe('[#ff8800]x[/]'));
    const got = assertOkJson(r, 'screen');
    eq(got.depth, '16');
    assert(/\x1b\[(?:[0-9;]*;)?(?:9[0-7]|3[0-7])m/.test(got.bytes),
      `16-color should emit bare 90-97 / 30-37, got: ${JSON.stringify(got.bytes)}`);
    assert(!/38;[25];/.test(got.bytes),
      `16 must NOT keep 38;2 or 38;5 bytes, got: ${JSON.stringify(got.bytes)}`);
  });

  it('TERM=xterm (plain) → 16', () => {
    const r = runUnderEnv({ TERM: 'xterm' }, probe('[#ff8800]x[/]'));
    const got = assertOkJson(r, 'xterm plain');
    eq(got.depth, '16');
  });

  it('TERM=dumb → 16 fallback, probe does NOT crash', () => {
    const r = runUnderEnv({ TERM: 'dumb' }, probe('[#ff8800]x[/]'));
    const got = assertOkJson(r, 'TERM=dumb');
    eq(got.depth, '16');
    assert(!got.bytes.includes('38;2;'), `dumb must NOT emit truecolor bytes`);
  });

  it('TERM absent entirely → 16 fallback, probe does NOT crash', () => {
    const r = runUnderEnv({}, probe('[#ff8800]x[/]'));
    const got = assertOkJson(r, 'no TERM');
    eq(got.depth, '16');
  });
});

describe('[term-matrix] LAZYTUI_COLOR override wins over all TERM/COLORTERM', () => {
  it('LAZYTUI_COLOR=16 with TERM=xterm-direct still downgrades to 16', () => {
    const r = runUnderEnv({ TERM: 'xterm-direct', LAZYTUI_COLOR: '16' },
      probe('[#ff8800]x[/]'));
    const got = assertOkJson(r, 'override 16');
    eq(got.depth, '16');
    assert(!got.bytes.includes('38;2;'), `override to 16 should strip truecolor`);
  });

  it('LAZYTUI_COLOR=truecolor with TERM=dumb lifts to truecolor', () => {
    const r = runUnderEnv({ TERM: 'dumb', LAZYTUI_COLOR: 'truecolor' },
      probe('[#ff8800]x[/]'));
    const got = assertOkJson(r, 'override truecolor');
    eq(got.depth, 'truecolor');
    assert(got.bytes.includes('38;2;255;136;0'),
      `override to truecolor should emit 38;2 bytes, got: ${JSON.stringify(got.bytes)}`);
  });
});

describe('[term-matrix] frame-level invariant — richToAnsi output is DEPTH-INDEPENDENT', () => {
  it('the same markup produces IDENTICAL richToAnsi bytes under every TERM (quantization happens later)', () => {
    // test-color-depth.js [4] pins this with LAZYTUI_COLOR; here we pin it
    // across the TERM detection path too — a stronger statement because
    // real-env detection has more branches than the LAZYTUI_COLOR override.
    const bareProbe = `
      const ansi = require('${ANSI_LIB}');
      process.stdout.write(ansi.richToAnsi('[#ff8800]x[/] [bold cyan]y[/]'));
    `;
    const envs = [
      { TERM: 'xterm-direct' },
      { TERM: 'xterm-256color' },
      { TERM: 'xterm' },
      { TERM: 'screen' },
      { TERM: 'dumb' },
      {},                                  // no TERM at all
    ];
    const outs = envs.map((e) => runUnderEnv(e, bareProbe).stdout);
    for (let i = 1; i < outs.length; i++) {
      eq(outs[i], outs[0],
        `richToAnsi output drifted between env[0]=${JSON.stringify(envs[0])} and env[${i}]=${JSON.stringify(envs[i])}`);
    }
    assert(outs[0].includes('38;2;255;136;0'),
      `canonical truecolor bytes should appear in richToAnsi output (quantization is a later step)`);
  });
});

describe('[term-matrix] production boot survives TERM=dumb (end-to-end smoke)', () => {
  // Beyond pure ansi/color-depth: boot the real CLI entry under TERM=dumb
  // and verify --list exits 0. CI's old 16-color env was less harsh than
  // dumb; if --list breaks here, --list on a hypothetical dumb-CI breaks.
  it('`--list` under TERM=dumb exits 0 and emits group:action rows', () => {
    const fs = require('fs');
    const os = require('os');
    const TUI = path.resolve(__dirname, '..', 'app', 'tui.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'term-diff-'));
    try {
      const cfg = path.join(tmp, 'c.yml');
      fs.writeFileSync(cfg, `groups:
  g:
    label: G
    actions:
      a:
        type: run
        script: echo ok
        label: A
`);
      const r = spawnSync(process.execPath, [TUI, cfg, '--list'], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'dumb' },
        encoding: 'utf8',
        timeout: 5000,
      });
      eq(r.status, 0, `--list under TERM=dumb should succeed; stderr=${r.stderr.trim()}`);
      assert(/g:a/.test(r.stdout), `--list output should include "g:a" row, got: ${r.stdout.trim()}`);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ok */ }
    }
  });
});

report();
