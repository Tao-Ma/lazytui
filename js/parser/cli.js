#!/usr/bin/env node
/**
 * CLI entry — parses a YAML config and prints resolved JSON to stdout.
 * The runtime (js/state.js) calls parse() directly; this CLI exists
 * for external scripts and parity / sanity testing.
 *
 * Exit codes:
 *   0 — success, JSON to stdout
 *   1 — parse error (file missing, schema violation, resolution failure)
 *   2 — bad usage
 */
'use strict';

const { parse } = require('./index');
const { ParseError } = require('./errors');

function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write('Usage: node js/parser/cli.js <config.yml>\n');
    return 2;
  }
  try {
    const config = parse(argv[0]);
    process.stdout.write(JSON.stringify(config));
    return 0;
  } catch (e) {
    if (e instanceof ParseError) {
      process.stderr.write(`parser: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

process.exit(main(process.argv.slice(2)));
