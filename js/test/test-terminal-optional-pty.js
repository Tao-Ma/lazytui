/**
 * node-pty is an OPTIONAL dependency (its native addon has no prebuild on some
 * platforms, e.g. linux-arm64, and its source build needs a toolchain, so
 * `npm install` may skip it). The dispatch runtime top-level-requires io/terminal
 * at boot (cleanup / finalize / actions), so a bare `require('node-pty')` would
 * crash the WHOLE TUI on a node-pty-less install. This pins the graceful path:
 * terminal.js loads, terminal SESSIONS no-op, and the terminal PANE shows a notice
 * instead of a blank box or a crash.
 *
 * Mock node-pty's require to THROW before loading terminal.js (run-tests gives each
 * file its own process, so this override is isolated).
 *
 * Run: node js/test/test-terminal-optional-pty.js
 */
'use strict';

const Module = require('module');
const _load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-pty') throw new Error('test: node-pty not installed');
  return _load.call(this, request, ...rest);
};

const { describe, it, assert, eq, report } = require('./test-runner');
const term = require('../io/terminal');            // guarded require must not throw
const panel = require('../panel/terminal/terminal');
const { stripMarkup } = require('../leaves/text/ansi');

describe('[terminal] degrades gracefully when the optional node-pty is absent', () => {
  it('io/terminal loads without node-pty (the dispatch runtime can boot)', () => {
    assert(term && typeof term.ensureSession === 'function', 'module loaded, exports intact');
  });

  it('ptyAvailable() reports false', () => eq(term.ptyAvailable(), false));

  it('ensureSession no-ops to null — no spawn, no throw', () => {
    eq(term.ensureSession('t1', 'echo hi', 80, 24, '.'), null);
  });

  it('session accessors stay null-safe (what the frame finalizer reads)', () => {
    eq(term.sessionSize('t1'), null);
    eq(term.restartSession('t1', 80, 24), null);
    term.destroyAll();   // must not throw
  });

  it('the terminal panel renders a notice instead of a blank box or crash', () => {
    const out = panel.panelTypes.terminal.render({ title: 'T', hotkey: '' }, 44, 9, {}, { chrome: null });
    const plain = stripMarkup(out);
    assert(plain.includes('unavailable') && plain.includes('node-pty'),
      `expected a node-pty notice, got: ${JSON.stringify(plain)}`);
    eq(out.split('\n').length, 9, 'exactly h rows (no crash)');
  });
});

Module._load = _load;   // restore (belt-and-suspenders; process exits after report)
report();
