/**
 * Smoke — embedded-terminal PTY spawns from the dispatch finalizer, not render.
 *
 * v0.6.5 §5 routed the embedded-terminal PTY spawn + resize OUT of the render
 * pass (paint.js's ensureSession/resizeSession) and INTO the dispatch finalizer
 * (dispatch/runtime/finalize.js), so render is a pure READ of the session buffer.
 * The unit suite never seeds layout geometry, so its finalizer early-returns and
 * never spawns a real PTY — only a real boot exercises the whole chain:
 * tab-activation → finalizer spawn → read-only render paints the buffer.
 *
 * This boots the real binary in a node-pty, opens a `terminal` PANE via the
 * `:terminal <cmd>` cmdline verb (U2d), then asserts the terminal command's marker
 * text appears in the painted output. Marker present ⇒ the finalizer spawned the
 * PTY AND render read + painted its buffer. It then resizes the outer terminal —
 * exercising the finalizer's resizeSession branch (the other half of §5;
 * `term_resized` runs the finalizer) — and confirms the binary survives and the
 * overlay still paints.
 *
 * The marker is split by adjacent quotes in the typed command (`PTYMARK''ER_…`) so
 * the cmdline's own echo of what we TYPE never contains the literal marker — only
 * the shell's output does (the shell drops the empty '' between the halves). So the
 * assertion can only pass if the PTY actually ran and its buffer was painted.
 *
 * Run: node js/test/smoke/pty-overlay.js
 */
'use strict';

const path = require('path');
const pty = require('node-pty');
const { describe, it, assert, report } = require('../test-runner');

const ROOT = path.resolve(__dirname, '../../..');
const ENTRY = path.join(ROOT, 'js/app/tui.js');
const CONFIG = path.join(__dirname, '_helpers/pty-overlay.yml');
const MARKER = 'PTYMARKER_4F2A';
const BOOT_MS = 2000;       // boot + first paint (matches boot.js settle)
const AFTER_KEY_MS = 2000;  // PTY spawn + echo + overlay paint
const RESIZE_MS = 1200;     // resize → term_resized → finalizer resizeSession
const TERM_MODE_MS = 1000;  // Enter → terminal_enter → terminalMode render (cursor path)
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function run() {
  return new Promise((resolve) => {
    let out = '';
    let exitCode = null;  // stays null while the process is alive
    const term = pty.spawn(process.execPath, [ENTRY, CONFIG], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: ROOT, env: process.env,
    });
    term.onData((d) => { out += d; });
    term.onExit((e) => { exitCode = e.exitCode; });
    (async () => {
      await delay(BOOT_MS);
      try { term.write('\x1b[C'); } catch (_) {}   // focus the detail pane (right column)
      await delay(300);
      // Open a `terminal` pane via `:terminal <cmd>` (mints into the focused slot,
      // finalizer spawns the PTY). Split marker (PTYMARK''ER_…) so the typed cmdline
      // never contains the literal marker — only the shell's echo output does.
      try { term.write(':'); } catch (_) {}
      await delay(300);
      try { term.write("terminal echo PTYMARK''ER_4F2A; sleep 30\r"); } catch (_) {}
      await delay(AFTER_KEY_MS);
      // Resize the outer terminal → term_resized Msg → finalizer →
      // resizeSession on the active PTY. Must not crash.
      try { term.resize(100, 30); } catch (_) {}
      await delay(RESIZE_MS);
      // Enter on the focused terminal pane → run_selected → activateTerminal →
      // terminal_enter → terminalMode, whose render positions the screen cursor at
      // the PTY cursor (via the io/term-screen port). The v0.6.6 port refactor
      // regressed this into a `buffer is not defined` ReferenceError → fatal exit;
      // this step is the regression guard.
      try { term.write('\r'); } catch (_) {}
      await delay(TERM_MODE_MS);
      const captured = out;
      try { term.kill(); } catch (_) {}
      resolve({ out: captured, exitCode });
    })();
  });
}

(async () => {
  const { out, exitCode } = await run();

  describe('PTY overlay — finalizer spawns, render reads (v0.6.5 §5)', () => {
    it('survives opening a terminal pane + a resize — no crash', () => {
      // A read-only-render regression (e.g. dereferencing a null session) or a
      // throw in the finalizer's spawn/resize branch would crash the child
      // before the kill; a clean run stays alive → exitCode null.
      if (exitCode !== null) {
        console.error(`  ↳ exited with code ${exitCode}; last output:\n${out.slice(-600)}`);
      }
      assert(exitCode === null, 'process still alive after opening a terminal pane + resize');
    });

    it('paints the PTY buffer (marker ⇒ finalizer spawned + render read it)', () => {
      const seen = out.includes(MARKER);
      if (!seen) console.error(`  ↳ marker '${MARKER}' not found; output tail:\n${out.slice(-800)}`);
      assert(seen, `terminal command output '${MARKER}' rendered in the overlay`);
    });

    it('survives entering terminal mode — renders the PTY cursor, no undefined-buffer crash', () => {
      // The terminalMode render reads the cursor via the io/term-screen port; the
      // v0.6.6 port refactor left a dangling `buffer` reference there → fatal
      // ReferenceError on focus-in. A crash exits 1 + logs to stderr (captured).
      const crashed = /uncaughtException|ReferenceError|is not defined/.test(out);
      if (crashed) console.error(`  ↳ crash entering terminal mode:\n${out.slice(-800)}`);
      assert(exitCode === null && !crashed, 'no crash on terminal_enter (cursor render path)');
    });
  });

  report();
})();
