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
 *   [4] the default-colour queries (OSC 10 / 11 — nvim's light/dark probe) are
 *       answered with the theme's screen colours, which default cells are
 *       painted with; unanswered while screen colours are off (unknown)
 *
 * Run: node js/test/test-terminal-replies.js
 */
'use strict';

const { section, assert, eq, report } = require('./test-runner');
const terminal = require('../io/terminal');
const ts = require('../io/term-screen');
const { enableScreenColors } = require('../leaves/text/ansi');
const { setTheme } = require('../leaves/infra/themes');

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

  section('[4] default-colour queries (OSC 10 / 11)');
  {
    // Screen colours off (the default here): the host's colours show, unknown.
    const off = ts.createScreen(20, 2);
    const got = [];
    ts.onScreenReply(off, (d) => got.push(d));
    await new Promise(res => ts.writeScreen(off, '\x1b]11;?\x07\x1b]10;?\x07', res));
    eq(got, [], 'screen colours off: no answer (the colours are the host\'s, unknown)');
  }
  enableScreenColors(true);
  setTheme('dracula');                                   // screen: #f8f8f2 on #282a36
  terminal.ensureSession('pane-osc11', ask('\\033]11;?\\007'), 80, 10, '.');
  const bg = await answerOf('pane-osc11');
  eq(bg, hex('\x1b]11;rgb:2828/2a2a/3636\x1b\\'), 'a real child gets the theme background');
  terminal.ensureSession('pane-osc10', ask('\\033]10;?\\007'), 80, 10, '.');
  const fg = await answerOf('pane-osc10');
  eq(fg, hex('\x1b]10;rgb:f8f8/f8f8/f2f2\x1b\\'), '… and the theme foreground');
  {
    const s2 = ts.createScreen(20, 2);
    const got = [];
    ts.onScreenReply(s2, (d) => got.push(d));
    await new Promise(res => ts.writeScreen(s2, '\x1b]11;#000000\x07', res));
    eq(got, [], 'setting a colour (not a query) gets no answer');
  }
  {
    // One OSC, several slots — each the next dynamic colour (xterm): `10;?;?`
    // asks for the foreground AND the background; a slot past 11 (the cursor
    // colour) has no theme colour. It went unanswered (pre-release review
    // 2026-11-14: only a bare `?` was a query).
    const s3 = ts.createScreen(20, 2);
    const got = [];
    ts.onScreenReply(s3, (d) => got.push(d));
    await new Promise(res => ts.writeScreen(s3, '\x1b]10;?;?;?\x07', res));
    eq(got, ['\x1b]10;rgb:f8f8/f8f8/f2f2\x1b\\', '\x1b]11;rgb:2828/2a2a/3636\x1b\\'],
      'fg then bg answered; the cursor-colour slot is not');
  }
  enableScreenColors(false);

  terminal.destroyAll();
  report();
})();
