/**
 * E9 (v0.6.7) — `--keymap` headless dump (AI-facing introspection surface).
 * Run: node js/test/test-keymap-dump.js
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { describe, it, assert, report } = require('./test-runner');

const REPO = path.resolve(__dirname, '../..');
const TUI = path.join(REPO, 'js/app/tui.js');
const fixture = path.join(__dirname, 'fixtures/keymap-config.yml');
const run = (args) => {
  try { return { rc: 0, out: execFileSync('node', [TUI, ...args], { cwd: REPO, encoding: 'utf8' }) }; }
  catch (e) { return { rc: e.status || 1, out: (e.stdout || '') + (e.stderr || '') }; }
};

describe('[E9] --keymap dump', () => {
  it('defaults: verb catalog + reserved + effective bindings', () => {
    const { rc, out } = run(['--keymap']);
    assert(rc === 0, 'exit 0');
    assert(/format version 1/.test(out), 'version line');
    assert(/## verbs/.test(out) && /refresh\s+Re-run/.test(out), 'verb catalog with summaries');
    assert(/## reserved keys/.test(out) && /\[/.test(out) && /\bx\b/.test(out), 'reserved keys listed');
    assert(/^ {2}r\s+-> refresh/m.test(out), 'effective: r -> refresh');
    assert(/^ {2}:\s+-> cmdline/m.test(out), 'effective: : -> cmdline');
  });
  it('with a config: effective bindings reflect the overrides', () => {
    const { rc, out } = run(['--keymap', fixture]);
    assert(rc === 0, 'exit 0');
    assert(/^ {2}R\s+-> refresh/m.test(out), 'R rebound to refresh');
    assert(!/^ {2}r\s+-> /m.test(out), 'default r disabled via noop');
    assert(/^ {2}H\s+-> action:hello/m.test(out), 'H bound to an action');
    assert(!/no action with that short key/.test(out), 'no spurious action no-op warning in the dump');
  });
});

report();
