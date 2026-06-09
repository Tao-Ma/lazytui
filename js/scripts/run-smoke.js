#!/usr/bin/env node
/**
 * Discover and run every `js/test/smoke/<name>.js` scenario in a
 * separate Node process. Mirrors `run-tests.js` but targets the
 * pre-release smoke suite — end-to-end scenarios that drive the real
 * input/dispatch/render path to catch the bug class the unit suite
 * misses (paneId/type mismatches, stale viewer body on close, etc).
 *
 * Run before tagging a release. Slower than the unit suite (boots the
 * full app per scenario); the goal is to never ship a release without
 * a green smoke pass.
 *
 * Usage:
 *   node js/scripts/run-smoke.js               # run all
 *   node js/scripts/run-smoke.js routing       # filter by name
 *   node js/scripts/run-smoke.js -q            # quiet
 *
 * Exits 0 if every scenario passes, 1 if any fails.
 *
 * Zero npm deps. Pure Node.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SMOKE_DIR = path.join(__dirname, '..', 'test', 'smoke');

function discover() {
  if (!fs.existsSync(SMOKE_DIR)) return [];
  return fs.readdirSync(SMOKE_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();
}

function runOne(file, quiet) {
  const start = Date.now();
  const res = spawnSync(process.execPath, [path.join(SMOKE_DIR, file)], {
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  const ms = Date.now() - start;
  const ok = res.status === 0;
  if (quiet) {
    process.stdout.write(`${ok ? '✓' : '✗'} ${file} (${ms}ms)\n`);
    if (!ok) {
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
    }
  } else {
    console.log(`\n=== smoke/${file} (${ms}ms, ${ok ? 'ok' : 'FAIL'}) ===`);
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
      console.error('Usage: node js/scripts/run-smoke.js [-q] [name-filter ...]');
      process.exit(2);
    } else {
      filters.push(a);
    }
  }

  let files = discover();
  if (filters.length) {
    files = files.filter(f => filters.some(s => f.includes(s)));
    if (!files.length) {
      console.error(`No smoke scenarios match filter(s): ${filters.join(', ')}`);
      process.exit(2);
    }
  }
  if (!files.length) {
    console.error('No smoke scenarios found in js/test/smoke/.');
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
    console.log(`✓ ${files.length} smoke scenario(s) passed in ${total}ms`);
    process.exit(0);
  }
  console.error(`✗ ${failed}/${files.length} smoke scenario(s) failed in ${total}ms`);
  process.exit(1);
}

main();
