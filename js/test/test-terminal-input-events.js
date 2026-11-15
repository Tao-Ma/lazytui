/**
 * Terminal mode handles input event by event, however the host (or the network)
 * batched or split it.
 *
 * Pre-release review 2026-11-14: in terminal mode a chunk was matched whole —
 *  - a paste whose CLOSE marker split across two chunks was never seen to end,
 *    so every later key (Ctrl+\ included) went to the program as pasted text:
 *    terminal mode wedged;
 *  - a split OPEN marker sent both markers to a program that never asked for
 *    them, and key-translated the pasted text;
 *  - keys in a chunk that also carried a mouse event went out raw: a focus-in
 *    batched with a click never reached lazytui (focus-gated polls stayed
 *    paused), leaked to a program that hadn't asked for focus reports, and
 *    tmux's Home (`CSI 1 ~`) went untranslated.
 * Now the chunk is tokenized like normal mode — sharing its carry, so a
 * sequence split across chunks rejoins — and each event is classified alone
 * (input.js §Terminal-mode input).
 *
 *   [1] a paste close marker split across chunks ends the paste
 *   [2] a paste open marker split across chunks starts one
 *   [3] a focus report batched with a click is lazytui's
 *   [4] keys beside a mouse report are re-encoded
 *   [5] a mouse report or a key split across chunks rejoins
 *   [6] a sequence that never completes reaches the program after the window;
 *       inside a paste, a piece of the close marker waits however long
 *   [7] a paste that outlives terminal mode finishes as a paste, not as keys
 *   [8] a paste over the size cap is dropped whole — never typed as keys
 *   [9] a paste open marker split more than 50 ms apart still opens a paste
 *   [10] a paste opening in a chunk for a gone session is still a paste
 *
 * Run: node js/test/test-terminal-input-events.js
 */
'use strict';

const { EventEmitter } = require('events');
const { section, assert, eq, report } = require('./test-runner');
const tl = require('./_helpers/terminal-layout');
const terminal = require('../io/terminal');
const route = require('../panel/route');
const { visibleTerminalSurfaces } = require('../panel/terminal-surfaces');
const { getModel } = require('../model/store');
const { dispatchMsg, applyMsg } = require('../dispatch/runtime/loop');
const { _makeDataHandler } = require('../dispatch/control/input');

// Frames the app paints are not this test's subject.
const _out = require('./_helpers/host-screen').muteFrames();

const feedScreen = (screen, bytes) => new Promise((res) => screen.write(bytes, res));
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {
  if (!terminal.ptyAvailable()) {
    _out.write('  (skipped: the optional node-pty dependency is not installed)\n');
    _out.restore();
    report();
    return;
  }
  const fx = tl.boot({ cmd: 'sleep 60' });
  const id = fx.id;
  dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: fx.pane().paneId }));
  const s = terminal.getSession(id);
  let writes = [];
  s.pty.write = (d) => { writes.push(Buffer.isBuffer(d) ? d.toString('latin1') : d); };
  // The real stdin handler — the carry across chunks lives there.
  const stdin = new EventEmitter();
  stdin.on('data', _makeDataHandler(stdin));
  const send = (...chunks) => { writes = []; for (const c of chunks) stdin.emit('data', c); return writes; };
  const inTerminal = () => getModel().modes.terminalMode;
  const enter = () => { if (!inTerminal()) applyMsg({ type: 'terminal_enter' }); };
  enter();
  assert(inTerminal(), 'precondition: terminal mode');

  section('[1] a paste close marker split across chunks ends the paste');
  const CLOSE = '\x1b[201~';
  for (let cut = 1; cut < CLOSE.length; cut++) {
    const w = send(`\x1b[200~hello${CLOSE.slice(0, cut)}`, `${CLOSE.slice(cut)}ok`);
    eq(w.join(''), 'hellook', `cut after ${cut} byte(s): the text, then the key after the paste`);
  }
  send('\x1c');
  assert(!inTerminal(), 'Ctrl+\\ after the paste leaves terminal mode (it was pasted text before)');
  enter();
  await feedScreen(s.screen, '\x1b[?2004h');                 // the program asks for bracketed paste
  eq(send('\x1b[200~ab\x1b[20', '1~').join(''), '\x1b[200~ab\x1b[201~',
    'a program that asked gets the markers, paired, around the text');
  await feedScreen(s.screen, '\x1b[?2004l');
  eq(send('\x1b[200~\x1b[1~\x1c').join(''), '\x1b[1~\x1c', 'inside a paste nothing is a key: no translation, no exit');
  assert(inTerminal(), '…so Ctrl+\\ inside a paste is pasted, not an exit');
  eq(send(CLOSE).join(''), '', 'the close marker ends it');

  section('[2] a paste open marker split across chunks starts one');
  eq(send('\x1b[20', `0~hi\x1b[1~${CLOSE}`).join(''), 'hi\x1b[1~',
    'no markers to a program that didn\'t ask; the text verbatim (not re-encoded)');
  eq(send('\x1b[1~').join(''), '\x1b[H', 'after it, keys are keys again (tmux Home → xterm Home)');

  section('[3] a focus report batched with a click is lazytui\'s');
  await feedScreen(s.screen, '\x1b[?1000h\x1b[?1006h');      // mouse reporting, SGR; no 1004
  const surf = visibleTerminalSurfaces(getModel()).find(x => x.id === id);
  const hx = surf.bounds.x + 2 + 3, hy = surf.bounds.y + 2 + 2;   // grid cell (3,2), host 1-based
  send('\x1b[O');
  eq(getModel().focused, false, 'precondition: a lone focus-out unfocuses lazytui');
  eq(send(`\x1b[I\x1b[<0;${hx};${hy}M`), ['\x1b[<0;4;3M'], 'the click reaches the program, pane-relative; the focus report does not');
  eq(getModel().focused, true, 'lazytui saw the focus-in');
  send(`\x1b[<0;${hx};${hy}m`);
  await feedScreen(s.screen, '\x1b[?1004h');                 // now the program asks for focus reports
  eq(send(`\x1b[O\x1b[<0;${hx};${hy}M`), ['\x1b[O', '\x1b[<0;4;3M'], 'a program that asked gets it, in order before the click');
  eq(getModel().focused, false, 'and lazytui still sees it');
  send(`\x1b[I\x1b[<0;${hx};${hy}m`);
  await feedScreen(s.screen, '\x1b[?1004l');

  section('[4] keys beside a mouse report are re-encoded');
  eq(send(`\x1b[1~\x1b[<0;${hx};${hy}M\x1b[4~`), ['\x1b[H', '\x1b[<0;4;3M', '\x1b[F'],
    'tmux Home, click, tmux End — in order, Home/End as xterm sends them');
  eq(send(`\x1b[<0;${hx};${hy}m\x1c`), ['\x1b[<0;4;3m'], 'Ctrl+\\ beside a mouse report exits');
  assert(!inTerminal(), '…terminal mode is off');
  enter();

  section('[5] a mouse report or a key split across chunks rejoins');
  eq(send(`\x1b[<0;${hx}`, `;${hy}M`), ['\x1b[<0;4;3M'], 'a split click arrives once, pane-relative (not the host\'s bytes)');
  send(`\x1b[<0;${hx};${hy}m`);
  await feedScreen(s.screen, '\x1b[?1000l\x1b[?1006l');
  eq(send('\x1b[1', '~').join(''), '\x1b[H', 'a split tmux Home is re-encoded');
  eq(send('a\x1b[', 'Bb').join(''), 'a\x1b[Bb', 'keys around a split arrow keep their order');

  section('[6] a sequence that never completes reaches the program after the window');
  eq(send('\x1b[').join(''), '', 'held for a continuation');
  await wait(120);
  eq(writes.join(''), '\x1b[', 'then flushed to the program as it was (Alt+[)');
  eq(send('\x1b[200~x\x1b[20').join(''), 'x', 'inside a paste, a piece of the close marker is held…');
  await wait(200);
  eq(writes.join(''), 'x', '…with no flush timer: the host always sends the rest (it flushed after 50 ms and the paste never ended)');
  eq(send('1~z').join(''), 'z', 'the close completes however late; keys after it are keys');
  eq(send('\x1b[200~y\x1b', 'q').join(''), 'y\x1bq', 'a piece that the paste continues past is pasted');
  eq(send(CLOSE).join(''), '', 'and the paste still ends at its close marker');

  section('[7] a paste that outlives terminal mode finishes as a paste, not as keys');
  // Its program exited mid-paste (pty-lifecycle leaves terminal mode): the rest
  // of the pasted text reached the normal-mode key ladder — a pasted
  // `:theme nord\r` ran the command (round-2 review 2026-11-14).
  send('\x1b[200~ab');
  applyMsg({ type: 'terminal_exit' });
  send(':theme nord\r', `${CLOSE}`);
  eq([getModel().modes.cmdMode, getModel().theme], [false, 'monokai'], 'no cmdline opened, nothing ran');
  enter();

  section('[8] a paste over the size cap is dropped whole — never typed as keys');
  // The accumulator dropped its buffer at the 256 KB cap and forgot a paste was
  // in progress: the rest of it was typed as keys (round-3 review).
  const BIG = 'y'.repeat(300 * 1024);
  const nothingRan = () => [getModel().modes.cmdMode, getModel().theme];
  send('\x1c');
  assert(!inTerminal(), 'precondition: normal mode');
  send('\x1b[200~' + BIG, ':theme nord\r', `tail${CLOSE.slice(0, 3)}`, `${CLOSE.slice(3)}`);
  eq(nothingRan(), [false, 'monokai'], 'the rest of an oversized paste (its close split) ran nothing');
  send(':');
  eq(getModel().modes.cmdMode, true, 'a key after the close is a key');
  applyMsg({ type: 'cmdline_cancel' });
  send(`\x1b[200~${BIG}:theme nord\r${CLOSE}:`);
  eq(getModel().modes.cmdMode, true, 'one chunk: the paste dropped, the key after its close typed');
  applyMsg({ type: 'cmdline_cancel' });
  eq(getModel().theme, 'monokai', '…and nothing inside it ran');
  enter();
  send('\x1b[200~ab');
  applyMsg({ type: 'terminal_exit' });                      // its program exited mid-paste
  send(BIG, ':theme nord\r', CLOSE);
  eq(nothingRan(), [false, 'monokai'], 'a paste that outlived terminal mode, over the cap: nothing ran');
  enter();

  section('[9] a paste open marker split more than 50 ms apart still opens a paste');
  // The head was flushed after the 50 ms window — dropped in normal mode, sent
  // to the program in terminal mode — and the rest (`0~` and the text) typed as
  // keys: a pasted `:theme nord\r` ran, a pasted Ctrl+\ left terminal mode
  // (round-3 review).
  eq(send('\x1b[20').join(''), '', 'terminal mode: the head is held…');
  await wait(120);
  eq(send(`0~hi\x1c\x1b[1~${CLOSE}`).join(''), 'hi\x1c\x1b[1~', '…past the window: the text pasted verbatim');
  assert(inTerminal(), 'the pasted Ctrl+\\ was text, not an exit');
  send('\x1b[200');
  await wait(120);
  eq(send(`~ok${CLOSE}`).join(''), 'ok', 'a cut after `ESC [ 2 0 0` too');
  send('\x1b[20');
  await wait(120);
  eq(send('~').join(''), '\x1b[20~', 'F9 split the same way still arrives as F9');
  send('\x1c');
  assert(!inTerminal(), 'precondition: normal mode');
  send('\x1b[20');
  await wait(120);
  send(`0~:theme nord\r${CLOSE}`);
  eq(nothingRan(), [false, 'monokai'], 'normal mode: the text was pasted, nothing ran');
  enter();

  section('[10] a paste opening in a chunk for a gone session is still a paste');
  // Terminal mode over a session that is gone exits, dropping the keys typed for
  // it — a paste OPEN marker among them was dropped too, untracked, and the
  // paste's later chunks were typed as keys (round-3 review). Driven through the
  // mechanism: no real path is known to leave terminal mode on over a gone
  // session.
  terminal.destroySession(id);
  assert(inTerminal() && !terminal.getSession(id), 'precondition: terminal mode over a gone session');
  send(`typed\x1b[200~first line\n`, `:theme nord\r${CLOSE}`);
  assert(!inTerminal(), 'terminal mode exited');
  eq(nothingRan(), [false, 'monokai'], 'the paste\'s rest ran nothing');
  send(':');
  eq(getModel().modes.cmdMode, true, 'a key after its close is a key');
  applyMsg({ type: 'cmdline_cancel' });
  applyMsg({ type: 'terminal_enter' });                    // (the finalizer spawns it again…)
  terminal.destroySession(id);                              // (…so it goes again)
  assert(inTerminal() && !terminal.getSession(id), 'precondition: terminal mode over the gone session again');
  send('typed\x1b[20');
  await wait(120);
  send(`0~:theme nord\r${CLOSE}`);
  eq(nothingRan(), [false, 'monokai'], 'a split open head in that chunk rides along: nothing ran');

  terminal.destroyAll();
  fx.cleanup();
  _out.restore();
  report();
})().catch((e) => { _out.restore(); console.error(e); process.exit(1); });
