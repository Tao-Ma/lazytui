/**
 * Smoke — terminating-signal terminal restoration (the SIGTERM/SIGHUP/SIGINT
 * mode-leak fix; docs/kitty-keyboard.md "leak" note).
 *
 * Node's default disposition for these signals terminates the process WITHOUT
 * running its `process.on('exit')` handlers, so every enabled terminal mode
 * (raw / mouse / bracketed paste / focus / hidden cursor / kitty keyboard)
 * would leak into the shell. `installTerminationHandlers` traps them →
 * cleanup() → exit(128+signum). This drives the REAL handler in-process with a
 * spy exit (a real process.exit would skip report()) and asserts, per signal:
 *   - the kitty-keyboard flags are popped (the visible leak — Escape would
 *     otherwise arrive as \x1b[27u at the prompt),
 *   - the cursor is shown + mouse tracking disabled (the teardown ran),
 *   - exit was called with the conventional 128+signum code.
 *
 * SIGKILL is deliberately absent — it can't be trapped; only a shell-side
 * `reset` recovers that leak.
 *
 * Run: node js/scripts/run-smoke.js signal-teardown   (or directly)
 */
'use strict';

const sm = require('./_helpers/smoke');
const input = require('../../dispatch/control/input');
const term = require('../../io/term');
const { installTerminationHandlers, _FATAL_SIGNALS } = require('../../dispatch/runtime/cleanup');
const { describe, it, assert, eq, report } = require('../test-runner');

sm.bootFresh();
sm.resize(100, 24);

// 128 + signum: SIGHUP=1 → 129, SIGINT=2 → 130, SIGTERM=15 → 143.
const CASES = [
  { sig: 'SIGHUP',  code: 129 },
  { sig: 'SIGINT',  code: 130 },
  { sig: 'SIGTERM', code: 143 },
];

// Drive exactly the handlers under test — clear anything inherited, install
// with a spy exit that records the code instead of tearing the test down.
for (const s of _FATAL_SIGNALS) process.removeAllListeners(s);
let lastExit = null;
installTerminationHandlers((code) => { lastExit = code; });

for (const { sig, code } of CASES) {
  describe(`[${sig}] restores the terminal, then exits ${code}`, () => {
    it('pops KKP, shows the cursor, disables mouse, exits 128+signum', () => {
      // Put the terminal into a mode that would otherwise leak to the shell.
      sm.capture(() => input.applyKeyboardMode('kitty'));
      assert(term.kkpActive(), 'KKP pushed before the signal');
      lastExit = null;

      const { raw } = sm.capture(() => process.emit(sig));

      assert(!term.kkpActive(), 'KKP popped by the handler — never leaks to the shell');
      assert(raw.includes('\x1b[?25h'), 'cursor shown');
      assert(raw.includes('\x1b[?1000l'), 'mouse tracking disabled');
      eq(lastExit, code, 'exited with 128+signum');
    });
  });
}

// Don't leave the handlers registered past this scenario.
for (const s of _FATAL_SIGNALS) process.removeAllListeners(s);

report();
