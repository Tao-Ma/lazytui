/**
 * Smoke — kitty keyboard protocol end-to-end (docs/kitty-keyboard.md).
 *
 * Drives the REAL stdin data handler + dispatch pipeline:
 *   [1] handshake NEGATIVE — a DA1 reply with no flags report leaves the
 *       terminal on the legacy path (caps.keyboard stays 'legacy', no push).
 *   [2] handshake POSITIVE — a flags report BEFORE the DA1 fence flips
 *       caps.keyboard to 'kitty' and pushes our flags (kkpActive), and the
 *       decision waits for the fence.
 *   [3] decode — a CSI-u Escape / Ctrl+R normalizes back to the legacy key
 *       through the ladder (a key filter captures 'escape' / 'ctrl-r'); an
 *       Alt-chord with no legacy binding is dropped.
 *   [4] lifecycle — suspend pops the flags, resume re-pushes, exit cleanup
 *       pops (never leak the protocol to a spawned shell).
 *
 * Ctrl+C (\x1b[99;5u) is deliberately NOT fed — it decodes to \x03, which the
 * ladder turns into cleanup()+process.exit; the decoder unit test pins that.
 *
 * Run: node js/scripts/run-smoke.js kkp   (or directly)
 */
'use strict';

const EventEmitter = require('events');
const sm = require('./_helpers/smoke');
const api = sm.api;
const input = require('../../dispatch/control/input');
const dispatch = require('../../dispatch/control/dispatch');
const term = require('../../io/term');
const suspend = require('../../app/suspend');
const { getModel } = require('../../model/store');
const diag = require('../../io/diag-log');
const { describe, it, assert, eq, report } = require('../test-runner');

// Newest 'keyboard' diagnostic (the leader-e hint recorded at detection).
const lastKbdDiag = () => diag.snapshot().find((e) => e.code === 'keyboard');

if (!api.getComponent('actions')) api.registerComponent(require('../../panel/navigator/actions'));

sm.bootFresh({
  groups: {
    g1: { name: 'g1', label: 'G1', containers: [],
          actions: { a1: { key: 'a1', label: 'A1', type: 'run', script: 'true', tab: false } },
          children: [], parent: null, depth: 0, quick: false },
  },
});
sm.resize(100, 24);

const stdin = new EventEmitter();
stdin.on('data', input._makeDataHandler(stdin));
const feed = (chunk) => sm.capture(() => stdin.emit('data', chunk));

describe('[1] handshake: DA1 without a flags report → legacy', () => {
  it('caps.keyboard stays legacy and the protocol is not enabled', () => {
    assert(!term.kkpActive(), 'not active at start');
    sm.capture(() => input.beginKeyboardDetection());
    feed('\x1b[?62;1;6c');   // Primary DA fence only — no kitty flags report
    eq(getModel().caps.keyboard, 'legacy', 'no support recorded');
    assert(!term.kkpActive(), 'no flags pushed');
    const d = lastKbdDiag();
    assert(d && d.level === 'info' && /not supported/.test(d.message),
      `leader-e hint records the legacy outcome (got ${JSON.stringify(d)})`);
  });
});

describe('[2] handshake: flags report before the DA1 fence → kitty + enabled', () => {
  it('the decision waits for the fence, then enables', () => {
    sm.capture(() => input.beginKeyboardDetection());
    feed('\x1b[?1u');                         // kitty flags report
    eq(getModel().caps.keyboard, 'legacy', 'undecided until the fence');
    assert(!term.kkpActive(), 'not enabled until the fence');
    feed('\x1b[?62;1;6c');                    // DA1 fence
    eq(getModel().caps.keyboard, 'kitty', 'support recorded');
    assert(term.kkpActive(), 'flags pushed on confirmed support');
    const d = lastKbdDiag();
    assert(d && d.level === 'info' && /kitty/.test(d.message),
      `leader-e hint records the kitty outcome (got ${JSON.stringify(d)})`);
  });
});

describe('[3] CSI-u key decode → legacy ladder', () => {
  it('Escape and Ctrl+R decode; an Alt-chord drops', () => {
    assert(term.kkpActive(), 'protocol enabled from [2]');
    const seen = [];
    dispatch.registerKeyFilter((evt) => { seen.push(evt.key); return null; });
    feed('\x1b[27u');      // Escape
    feed('\x1b[114;5u');   // Ctrl+R (r=114, mods 5)
    feed('\x1b[106;3u');   // Alt+j (j=106, mods 3) → no legacy binding → drop
    dispatch.clearKeyFilters();
    assert(seen.includes('escape'), `escape decoded (saw ${JSON.stringify(seen)})`);
    assert(seen.includes('ctrl-r'), 'ctrl-r decoded');
    eq(seen.length, 2, 'the Alt-chord produced no key');
  });
});

describe('[4] lifecycle: suspend pops, resume re-pushes, cleanup pops', () => {
  it('suspend/resume toggle the pushed flags', () => {
    assert(term.kkpActive(), 'enabled');
    sm.capture(() => suspend.suspendTerminal());
    assert(!term.kkpActive(), 'popped on suspend (clean keyboard for the child)');
    sm.capture(() => suspend.resumeTerminal());
    assert(term.kkpActive(), 're-pushed on resume');
  });
  it('exit cleanup pops the flags', () => {
    sm.capture(() => require('../../dispatch/runtime/cleanup').cleanup());
    assert(!term.kkpActive(), 'popped on cleanup — never leaks to the shell');
  });
});

report();
