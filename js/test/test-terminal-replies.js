/**
 * The embedded terminal answers the program's terminal queries.
 *
 * Field report 2026-11-14 (nvim in a `type: terminal` pane): a program asks its
 * terminal questions on stdout — device attributes (`ESC [ c`, `ESC [ > c`),
 * the cursor position (`ESC [ 6 n`), mode reports — and reads the answer on
 * stdin. vim picks its mouse encoding from the `ESC [ > c` answer, nvim waits on
 * `ESC [ c`, fzf --height reads the cursor position. The emulator behind a
 * terminal pane (@xterm/headless, io/term-screen) computes every answer, but
 * nothing carried its replies back to the PTY, so every query went unanswered.
 *
 *   [1] a real PTY child gets the device-attributes answer
 *   [2] … and the cursor-position answer
 *   [3] the reply wiring dies with the session (no write after destroy)
 *
 * Run: node js/test/test-terminal-replies.js
 */
'use strict';

const { section, assert, eq, report } = require('./test-runner');
const terminal = require('../io/terminal');

// The child asks one question, reads the answer raw, prints it as hex and
// idles. `stty min 0 time 20` = read returns what arrived within 2 s.
const ask = (q) => `stty -echo -icanon min 0 time 20; printf '${q}'; ` +
  `r=$(dd bs=64 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); echo "ANSWER:[$r]"; sleep 30`;

function screenText(id) {
  return terminal.sessionViewportRows(id, 10, 80).rows.join('\n');
}
// Poll the screen until the child printed its answer line (or 6 s).
async function answerOf(id) {
  for (let i = 0; i < 120; i++) {
    const m = /ANSWER:\[([0-9a-f]*)\]/.exec(screenText(id));
    if (m) return m[1];
    await new Promise(res => setTimeout(res, 50));
  }
  return null;
}
const hex = (s) => Buffer.from(s, 'latin1').toString('hex');

(async () => {
  if (!terminal.ptyAvailable()) {
    console.log('  (skipped: the optional node-pty dependency is not installed)');
    report();
    return;
  }

  section('[1] device attributes');
  terminal.ensureSession('pane-da1', ask('\\033[c'), 80, 10, '.');
  const da1 = await answerOf('pane-da1');
  assert(da1 !== null, 'the child finished its read');
  assert(da1 && da1.startsWith(hex('\x1b[?')), `ESC [ c is answered with ESC [ ? … c (got ${JSON.stringify(da1)})`);
  assert(da1 && da1.endsWith(hex('c')), 'terminated by c');

  section('[2] cursor position');
  terminal.ensureSession('pane-dsr', ask('\\033[6n'), 80, 10, '.');
  const dsr = await answerOf('pane-dsr');
  assert(dsr && dsr.startsWith(hex('\x1b[')) && dsr.endsWith(hex('R')),
    `ESC [ 6 n is answered with ESC [ row ; col R (got ${JSON.stringify(dsr)})`);

  section('[3] the reply wiring dies with the session');
  const s = terminal.getSession('pane-dsr');
  const writes = [];
  s.pty.write = (d) => writes.push(d);
  const screen = s.screen;
  terminal.destroySession('pane-dsr');
  let threw = null;
  try { screen.write('\x1b[c'); } catch (e) { threw = e; }
  await new Promise(res => setTimeout(res, 50));
  eq(writes, [], 'a query reaching a destroyed session writes nothing to its PTY');
  eq(threw && threw.message, null, 'and does not throw');

  terminal.destroyAll();
  report();
})();
