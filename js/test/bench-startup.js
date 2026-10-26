/**
 * Startup bench — cold-ish process-spawn time for the CLI boot path.
 *
 * What this measures: the end-to-end wall time of
 *   node js/app/tui.js <demo-config> --list
 * so the number includes everything the user pays before the first paint
 * on a normal TUI launch, MINUS the TUI render loop itself:
 *   - Node interpreter startup + v8 warm-up
 *   - `require` tree walk (every module tui.js pulls in)
 *   - YAML parse + `plugin:` resolution
 *   - schema validation of every action / group / port
 *
 * `--list` is the shortest fast-exit mode that still exercises the full
 * config pipeline (`--lint` and `--help` both work too; `--help` skips
 * config loading entirely and is the pure Node + require-tree baseline).
 *
 * What a regression here would look like: a new boot-time code path
 * (e.g. a schema check that walks every port, a sync FS probe on every
 * action) that adds milliseconds across the board. Microbenchmarks on
 * individual leaves miss this — only a spawn-time measurement catches
 * require-tree bloat and whole-config parse cost.
 *
 * Variance note: process-spawn benches are noisier than in-process ones
 * (FS cache + scheduler + thermal). Interpret a <5ms delta as noise. For
 * a real A/B of a boot-path change, interleave branches (one iter from
 * each per round) rather than running one branch to completion first.
 *
 * Usage:
 *   node js/test/bench-startup.js                 # defaults: 20 iters, all demo configs
 *   node js/test/bench-startup.js --iters 50
 *   node js/test/bench-startup.js --config demo/fabric/tui.yml
 *   node js/test/bench-startup.js --mode help     # pure Node+require baseline
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const out = { iters: 20, warmup: 3, config: null, mode: 'list' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--iters') out.iters = Number(argv[++i]);
    else if (a === '--warmup') out.warmup = Number(argv[++i]);
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: node js/test/bench-startup.js [--iters N] [--warmup N] [--config path] [--mode list|lint|help]\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(`bench-startup: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.iters) || out.iters < 1) {
    process.stderr.write('bench-startup: --iters must be a positive integer\n');
    process.exit(2);
  }
  if (!['list', 'lint', 'help'].includes(out.mode)) {
    process.stderr.write(`bench-startup: --mode must be list|lint|help, got "${out.mode}"\n`);
    process.exit(2);
  }
  return out;
}

const REPO_ROOT = path.resolve(__dirname, '../..');
const TUI = path.join(REPO_ROOT, 'js/app/tui.js');

function defaultConfigs() {
  const demoDir = path.join(REPO_ROOT, 'demo');
  return fs
    .readdirSync(demoDir)
    .map((d) => path.join(demoDir, d, 'tui.yml'))
    .filter((p) => fs.existsSync(p))
    .sort();
}

function argvFor(mode, cfg) {
  if (mode === 'help') return [TUI, '--help'];
  if (mode === 'lint') return [TUI, '--lint', cfg];
  return [TUI, cfg, '--list'];
}

function timeOnce(mode, cfg) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, argvFor(mode, cfg), { stdio: 'ignore' });
  const t1 = process.hrtime.bigint();
  if (r.status !== 0) {
    throw new Error(`spawn failed (rc=${r.status}) for ${path.relative(REPO_ROOT, cfg || '')}`);
  }
  return Number(t1 - t0) / 1e6;
}

function stats(samples) {
  const s = samples.slice().sort((a, b) => a - b);
  const n = s.length;
  const pick = (q) => s[Math.min(n - 1, Math.floor((n - 1) * q))];
  const mean = s.reduce((a, b) => a + b, 0) / n;
  return {
    n,
    min: s[0],
    p50: pick(0.5),
    p90: pick(0.9),
    max: s[n - 1],
    mean,
  };
}

function fmt(ms) {
  return ms.toFixed(2).padStart(7);
}

function row(label, st) {
  process.stdout.write(
    `  ${label.padEnd(32)}  n=${String(st.n).padStart(3)}  min ${fmt(st.min)}  p50 ${fmt(
      st.p50
    )}  p90 ${fmt(st.p90)}  max ${fmt(st.max)}  mean ${fmt(st.mean)}  ms\n`
  );
}

function benchOne(mode, cfg, iters, warmup) {
  for (let i = 0; i < warmup; i++) timeOnce(mode, cfg);
  const samples = [];
  for (let i = 0; i < iters; i++) samples.push(timeOnce(mode, cfg));
  return stats(samples);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let targets;
  if (opts.mode === 'help') {
    targets = [{ label: '--help (require-tree baseline)', cfg: null }];
  } else if (opts.config) {
    const abs = path.isAbsolute(opts.config) ? opts.config : path.join(REPO_ROOT, opts.config);
    if (!fs.existsSync(abs)) {
      process.stderr.write(`bench-startup: config not found: ${abs}\n`);
      process.exit(2);
    }
    targets = [{ label: path.relative(REPO_ROOT, abs), cfg: abs }];
  } else {
    targets = defaultConfigs().map((cfg) => ({ label: path.relative(REPO_ROOT, cfg), cfg }));
  }

  process.stdout.write(
    `bench-startup — mode=${opts.mode}  iters=${opts.iters}  warmup=${opts.warmup}  node=${process.version}\n`
  );
  const cmdShape =
    opts.mode === 'help' ? '--help' : opts.mode === 'lint' ? '--lint <cfg>' : '<cfg> --list';
  process.stdout.write(
    `  (each sample spawns: node ${path.relative(REPO_ROOT, TUI)} ${cmdShape}; wall time to exit)\n\n`
  );

  for (const t of targets) {
    const st = benchOne(opts.mode, t.cfg, opts.iters, opts.warmup);
    row(t.label, st);
  }

  process.stdout.write('\n--- Interpretation ---\n');
  process.stdout.write(
    'Dominant cost on every row: Node interpreter startup + require tree + YAML parse.\n'
  );
  process.stdout.write(
    'Config-to-config variance is small; run-to-run variance is ~5–10ms (FS cache / scheduler).\n'
  );
  process.stdout.write(
    'For an A/B against a baseline branch, prefer interleaved runs — a one-shot per-branch\n'
  );
  process.stdout.write(
    'comparison can show a false ~5ms "regression" that disappears under interleaving.\n'
  );
  process.stdout.write(
    '--mode help skips config loading; the delta vs --list isolates YAML + schema cost.\n'
  );
}

main();
