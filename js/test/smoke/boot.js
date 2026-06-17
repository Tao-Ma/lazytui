/**
 * Smoke — real-binary boot in a PTY.
 *
 * Catches the bug class where a module move leaves a stale `require()`
 * reachable ONLY at runtime in the boot path — invisible to everything else:
 *
 *   - the unit suite never loads `js/app/tui.js#main()`;
 *   - the in-process smokes import `panel/api` directly and never boot;
 *   - `main()` gates its lazy requires behind a `process.stdin/out.isTTY`
 *     check, so even calling `main()` in a normal (non-TTY) test bails
 *     BEFORE reaching them.
 *
 * The F3 arc moved `cleanup` app/ → dispatch/, but the lazy
 * `require('./cleanup')` in `main()` slipped through all of the above and
 * crashed the first real boot with `Cannot find module './cleanup'`.
 *
 * The only way to exercise the TTY-gated boot path is a REAL TTY. We spawn
 * the actual entry point inside a node-pty (a true TTY → passes the gate →
 * every boot-path require resolves), let it reach the first paint, then
 * kill it. A stale require crashes the child with a non-zero exit, which
 * the assertions below detect.
 *
 * Run: node js/test/smoke/boot.js
 */
'use strict';

const path = require('path');
const pty = require('node-pty');
const { describe, it, assert, report } = require('../test-runner');

const ROOT = path.resolve(__dirname, '../../..');          // repo root
const ENTRY = path.join(ROOT, 'js/app/tui.js');
const CONFIG = path.join(__dirname, '_helpers/boot.yml');
const SETTLE_MS = 2000;  // boot + first paint lands well under this

// Boot the real binary in a PTY; collect output until it settles, then kill.
function boot() {
  return new Promise((resolve) => {
    let out = '';
    let exitCode = null;  // stays null while the process is alive
    const term = pty.spawn(process.execPath, [ENTRY, CONFIG], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: ROOT, env: process.env,
    });
    term.onData((d) => { out += d; });
    term.onExit((e) => { exitCode = e.exitCode; });
    setTimeout(() => {
      try { term.kill(); } catch (_) {}
      resolve({ out, exitCode });
    }, SETTLE_MS);
  });
}

(async () => {
  const { out, exitCode } = await boot();
  const moduleErr = /Cannot find module[^\n]*/.exec(out);

  describe('boot smoke — real binary in a PTY', () => {
    it('survives boot — no early non-zero exit', () => {
      // A clean TUI boot stays alive waiting for input → exitCode null.
      // A stale require / boot throw exits before SETTLE_MS.
      if (exitCode !== null) {
        console.error(`  ↳ boot exited with code ${exitCode}; last output:\n${out.slice(-600)}`);
      }
      assert(exitCode === null, 'process still alive after first paint');
    });

    it('resolves every boot-path require', () => {
      if (moduleErr) console.error(`  ↳ ${moduleErr[0]}`);
      assert(!moduleErr, 'no MODULE_NOT_FOUND (no moved module left a stale path)');
    });

    it('reaches the first paint past the TTY gate', () => {
      // ANSI escapes + the config's panel title prove main() got past the
      // lazy requires + component registration into the render.
      const painted = /\x1b\[/.test(out) && /Files/.test(out);
      if (!painted) console.error(`  ↳ no rendered chrome; output head:\n${out.slice(0, 600)}`);
      assert(painted, 'emitted rendered chrome (escapes + Files panel title)');
    });
  });

  report();
})();
