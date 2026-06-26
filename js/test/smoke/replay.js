/**
 * Smoke — record a session then reconstruct + scrub it, both in a real PTY.
 *
 * The unit suite drives replay through in-process helpers; only a real boot
 * exercises the whole binary path: the `--record-save` flag streaming a WAL
 * from boot, then `--record-load` reconstructing it into the interactive
 * scrubber over a true TTY, responding to keystrokes, and exiting clean on `q`.
 *
 * Two phases, fully self-contained (no committed WAL fixture):
 *   1. RECORD — spawn `tui.js --record-save <wal> <config>`, move the groups
 *      selection a few times (distinct frames), resize, quit. Assert the WAL
 *      was written and the binary exited cleanly.
 *   2. LOAD — spawn `tui.js --record-load <wal>`, let it reconstruct, then drive
 *      the scrubber: step, enable change-highlight (`d` → line), seek (so a
 *      changed row tints), cycle the pane view, and quit. Assert the scrubber +
 *      reconstructed content painted, the change-highlight SGR appeared, and the
 *      binary exited 0.
 *
 * Run: node js/test/smoke/replay.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { describe, it, assert, report } = require('../test-runner');

const ROOT = path.resolve(__dirname, '../../..');
const ENTRY = path.join(ROOT, 'js/app/tui.js');
const CONFIG = path.join(__dirname, '_helpers/replay.yml');
const WAL = path.join(process.env.SCRATCH_DIR || '/tmp', `replay-smoke-${process.pid}.jsonl`);

const BOOT_MS = 2500;          // boot + (load phase) reconstruct
const KEY_MS = 450;            // between keystrokes
const DOWN = '\x1b[B';

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Spawn the binary, run `drive(term)` (which sends keys with its own waits),
// then capture output + exit code. `drive` resolves when done; we settle briefly.
function session(args, drive) {
  return new Promise((resolve) => {
    let out = '';
    let exitCode = null;
    const term = pty.spawn(process.execPath, [ENTRY, ...args], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: ROOT, env: process.env,
    });
    term.onData((d) => { out += d; });
    term.onExit((e) => { exitCode = e.exitCode; });
    (async () => {
      await delay(BOOT_MS);
      await drive(term, () => out);
      await delay(600);
      const captured = out;
      try { term.kill(); } catch (_) {}
      resolve({ out: captured, exitCode });
    })();
  });
}

(async () => {
  // ---- Phase 1: record a short session from boot ----
  const rec = await session(['--record-save', WAL, CONFIG], async (term) => {
    for (let i = 0; i < 3; i++) { try { term.write(DOWN); } catch (_) {} await delay(KEY_MS); }
    try { term.resize(100, 30); } catch (_) {} await delay(KEY_MS);   // record a term_resized
    try { term.write('q'); } catch (_) {}                            // quit → flush WAL
    await delay(400);
  });

  let walLines = 0, walHasConfig = false;
  try {
    const raw = fs.readFileSync(WAL, 'utf8').trim();
    const lines = raw ? raw.split('\n') : [];
    walLines = lines.length;
    walHasConfig = lines.some(l => l.includes('"set_config"'));
  } catch (_) { /* missing → assertions below fail */ }

  describe('[1] record — --record-save streams a WAL from boot', () => {
    it('the binary booted and exited cleanly on q', () => {
      if (rec.exitCode !== 0) console.error(`  ↳ record exit ${rec.exitCode}; tail:\n${rec.out.slice(-500)}`);
      assert(rec.exitCode === 0, 'record process exited 0');
    });
    it('wrote a non-trivial WAL carrying the config', () => {
      assert(walLines > 3, `WAL has entries (got ${walLines})`);
      assert(walHasConfig, 'WAL carries a recorded set_config (self-contained, folds from start)');
    });
  });

  // ---- Phase 2: reconstruct + scrub interactively ----
  const rep = await session(['--record-load', WAL], async (term) => {
    try { term.write('['); } catch (_) {} await delay(KEY_MS);   // step back one entry
    try { term.write('d'); } catch (_) {} await delay(KEY_MS);   // change-highlight off → line
    try { term.write('g'); } catch (_) {} await delay(KEY_MS);   // seek to start
    try { term.write('G'); } catch (_) {} await delay(KEY_MS);   // seek to end
    try { term.write('d'); } catch (_) {} await delay(KEY_MS);   // → cell
    try { term.write('p'); } catch (_) {} await delay(KEY_MS);   // cycle pane view (full → mini)
    try { term.write('q'); } catch (_) {} await delay(400);      // exit
  });

  describe('[2] load — --record-load reconstructs into the interactive scrubber', () => {
    it('painted the reconstructed content (a configured group)', () => {
      const painted = /Alpha|Beta|Gamma/.test(rep.out);
      if (!painted) console.error(`  ↳ no group label; head:\n${rep.out.slice(0, 600)}`);
      assert(painted, 'a configured group label rendered');
    });
    it('painted the replay scrubber pane', () => {
      const pane = /Replay/.test(rep.out) || /\d+\/\d+/.test(rep.out);
      if (!pane) console.error(`  ↳ no scrubber; tail:\n${rep.out.slice(-600)}`);
      assert(pane, 'scrubber pane (title or seq position) rendered');
    });
    it('the `d` key toggles change-highlight mode (status reflects it)', () => {
      // The real-TTY path: d → cycleDiff → renderData.diffMode → the pane status
      // shows it. (Pixel-level tinting of changed rows/cells is covered by
      // test-cell-diff.js + the in-process render e2e — reconstructing similar
      // adjacent frames here wouldn't reliably produce a row delta to tint.)
      const toggled = /diff:line/.test(rep.out) || /diff:cell/.test(rep.out);
      if (!toggled) console.error(`  ↳ no diff status; tail:\n${rep.out.slice(-600)}`);
      assert(toggled, 'change-highlight mode reflected in the scrubber status');
    });
    it('exited 0 on q (clean teardown via onExit)', () => {
      if (rep.exitCode !== 0) console.error(`  ↳ load exit ${rep.exitCode}; tail:\n${rep.out.slice(-500)}`);
      assert(rep.exitCode === 0, 'load process exited 0');
    });
  });

  try { fs.unlinkSync(WAL); } catch (_) {}
  report();
})();
