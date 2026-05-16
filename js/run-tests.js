#!/usr/bin/env node
/**
 * Discover and run every `js/test/test-*.js` smoke test in a separate
 * Node process. Per-file isolation prevents one file's module mutations
 * (hub state, plugin registrations, fake timers) from polluting
 * another file. The harness in test/test-runner.js handles per-file
 * aggregation; this file just sequences the runs.
 *
 * Usage:
 *   node js/run-tests.js               # run all
 *   node js/run-tests.js hub           # run only matching file(s)
 *   node js/run-tests.js -q            # quiet — only show failing files
 *
 * Exits 0 if every file passes, 1 if any file fails.
 *
 * Zero npm deps. Pure Node.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_DIR = path.join(__dirname, 'test');

function discover() {
  return fs.readdirSync(TEST_DIR)
    .filter(f => f.startsWith('test-') && f.endsWith('.js') && f !== 'test-runner.js')
    .sort();
}

function runOne(file, quiet) {
  const start = Date.now();
  const res = spawnSync(process.execPath, [path.join(TEST_DIR, file)], {
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  const ms = Date.now() - start;
  const ok = res.status === 0;
  if (quiet) {
    process.stdout.write(`${ok ? '✓' : '✗'} ${file} (${ms}ms)\n`);
    if (!ok) {
      // Re-emit the file's output so failures are debuggable in -q mode.
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
    }
  } else {
    console.log(`\n=== ${file} (${ms}ms, ${ok ? 'ok' : 'FAIL'}) ===`);
  }
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  let quiet = false;
  const filters = [];
  for (const a of args) {
    if (a === '-q' || a === '--quiet') quiet = true;
    else if (a.startsWith('-')) {
      console.error(`Unknown flag: ${a}`);
      console.error('Usage: node js/run-tests.js [-q] [name-filter ...]');
      process.exit(2);
    } else {
      filters.push(a);
    }
  }

  let files = discover();
  if (filters.length) {
    files = files.filter(f => filters.some(s => f.includes(s)));
    if (!files.length) {
      console.error(`No tests match filter(s): ${filters.join(', ')}`);
      process.exit(2);
    }
  }
  if (!files.length) {
    console.error('No test-*.js files found.');
    process.exit(2);
  }

  const t0 = Date.now();
  let failed = 0;
  for (const f of files) {
    if (!runOne(f, quiet)) failed++;
  }
  const total = Date.now() - t0;

  console.log();
  if (failed === 0) {
    console.log(`✓ ${files.length} file(s) passed in ${total}ms`);
    process.exit(0);
  }
  console.error(`✗ ${failed}/${files.length} file(s) failed in ${total}ms`);
  process.exit(1);
}

main();
