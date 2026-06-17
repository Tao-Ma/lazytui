/**
 * Smoke — embedded-terminal PTY spawns from the dispatch finalizer, not render.
 *
 * v0.6.5 §5 routed the embedded-terminal PTY spawn + resize OUT of the render
 * pass (paint.js's ensureSession/resizeSession) and INTO the dispatch finalizer
 * (dispatch/runtime/fanout.js), so render is a pure READ of the session buffer.
 * The unit suite never seeds layout geometry, so its finalizer early-returns and
 * never spawns a real PTY — only a real boot exercises the whole chain:
 * tab-activation → finalizer spawn → read-only render paints the buffer.
 *
 * This boots the real binary in a node-pty, cycles the viewer to its terminal
 * tab (two `]` = next_tab: Info(0) → Transcript(1) → terminal(2); next_tab
 * targets the viewer regardless of which pane is focused), then asserts the
 * terminal command's marker text appears in the painted output. Marker present
 * ⇒ the finalizer spawned the PTY AND render read + painted its buffer. It then
 * resizes the outer terminal — exercising the finalizer's resizeSession branch
 * (the other half of §5; `term_resized` runs the finalizer) — and confirms the
 * binary survives and the overlay still paints.
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

function run() {
  return new Promise((resolve) => {
    let out = '';
    let exitCode = null;  // stays null while the process is alive
    const term = pty.spawn(process.execPath, [ENTRY, CONFIG], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: ROOT, env: process.env,
    });
    term.onData((d) => { out += d; });
    term.onExit((e) => { exitCode = e.exitCode; });
    setTimeout(() => {
      // Cycle the viewer to its terminal tab. `]` is next_tab.
      try { term.write(']'); } catch (_) {}
      setTimeout(() => {
        try { term.write(']'); } catch (_) {}
        setTimeout(() => {
          // Resize the outer terminal → term_resized Msg → finalizer →
          // resizeSession on the active PTY. Must not crash.
          try { term.resize(100, 30); } catch (_) {}
          setTimeout(() => {
            const captured = out;
            try { term.kill(); } catch (_) {}
            resolve({ out: captured, exitCode });
          }, RESIZE_MS);
        }, AFTER_KEY_MS);
      }, 300);
    }, BOOT_MS);
  });
}

(async () => {
  const { out, exitCode } = await run();

  describe('PTY overlay — finalizer spawns, render reads (v0.6.5 §5)', () => {
    it('survives activating the terminal tab + a resize — no crash', () => {
      // A read-only-render regression (e.g. dereferencing a null session) or a
      // throw in the finalizer's spawn/resize branch would crash the child
      // before the kill; a clean run stays alive → exitCode null.
      if (exitCode !== null) {
        console.error(`  ↳ exited with code ${exitCode}; last output:\n${out.slice(-600)}`);
      }
      assert(exitCode === null, 'process still alive after activating the terminal tab + resize');
    });

    it('paints the PTY buffer (marker ⇒ finalizer spawned + render read it)', () => {
      const seen = out.includes(MARKER);
      if (!seen) console.error(`  ↳ marker '${MARKER}' not found; output tail:\n${out.slice(-800)}`);
      assert(seen, `terminal command output '${MARKER}' rendered in the overlay`);
    });
  });

  report();
})();
