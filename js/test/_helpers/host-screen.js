/**
 * The HOST terminal as a test sees it: every stdout write that carries an
 * escape sequence (frames, terminal-surface rows, the cursor) is captured and
 * fed into a headless xterm the size of the screen, so a test reads the screen
 * a user would see — not the frame buffer, which the terminal surfaces paint
 * around. Writes with no escape pass through (the test runner's own output).
 *
 *   const hs = require('./_helpers/host-screen').install({ cols: 160, rows: 40 });
 *   await hs.paint();          // render(getModel()), then feed the bytes
 *   await hs.sync();           // feed what was written since (PTY fast path…)
 *   hs.line(y)                 // screen row y as text (trailing blanks trimmed)
 *   hs.find('needle')          // { x, y } of its first occurrence, or null
 *   hs.vt                      // the @xterm/headless Terminal
 *   hs.write(text)             // to the REAL stdout (skip notes, debugging)
 *   hs.restore();              // put stdout back (before report())
 *
 * Require `../test-runner` (or the smoke helper) BEFORE this — component
 * registration order matters, and `paint()` loads the renderer lazily.
 */
'use strict';

const { Terminal } = require('@xterm/headless');

function install({ cols = 160, rows = 40 } = {}) {
  const vt = new Terminal({ cols, rows, allowProposedApi: true });
  let frames = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const str = String(chunk);
    if (str.includes('\x1b')) { frames += str; return true; }
    return origWrite(chunk, ...rest);
  };
  const feed = (t, bytes) => new Promise((res) => t.write(bytes, res));
  async function sync() {
    await new Promise((res) => setImmediate(res));
    const bytes = frames; frames = '';
    await feed(vt, bytes);
  }
  async function paint() {
    const { render } = require('../../render/paint');
    const { getModel } = require('../../model/store');
    render(getModel());
    await sync();
  }
  const line = (y) => vt.buffer.active.getLine(y).translateToString(true);
  function find(needle) {
    for (let y = 0; y < vt.rows; y++) { const x = line(y).indexOf(needle); if (x >= 0) return { x, y }; }
    return null;
  }
  return {
    vt, sync, paint, line, find, feed,
    write: (text) => origWrite(text),
    restore: () => { process.stdout.write = origWrite; },
  };
}

module.exports = { install };
