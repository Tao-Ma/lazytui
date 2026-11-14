/**
 * Keys reach a terminal pane's program the way the terminal it was promised
 * (xterm-256color) would send them.
 *
 * Field report 2026-11-14 (nvim in a `type: terminal` pane, lazytui inside
 * tmux): terminal mode forwarded the host's bytes unchanged. tmux sends Home /
 * End as `CSI 1 ~` / `CSI 4 ~`; nvim, told TERM=xterm-256color, ignores them —
 * Home and End did nothing (vim 9.1 happens to accept them). The host's focus
 * reports and paste markers (lazytui turns both on at the host) also reached
 * programs that never asked for them: `cat -v` showed `^[[I^[[200~hi^[[201~`.
 *
 *   [1] special keys are re-encoded as xterm sends them, for the program's
 *       cursor mode; everything else passes byte-for-byte
 *   [2] focus reports reach the program only if it asked (and lazytui still
 *       sees them)
 *   [3] a paste reaches the program verbatim, wrapped in markers only if it
 *       asked; across chunks; Ctrl+\ inside a paste is text
 *   [4] Shift+Page/Home/End scroll lazytui's scrollback at a prompt, and are
 *       the program's keys on the alternate screen
 *
 * Driven through the real stdin handler (input._makeDataHandler) with raw
 * host bytes; the PTY's writes are captured.
 *
 * Run: node js/test/test-terminal-keys.js
 */
'use strict';

const { EventEmitter } = require('events');
const { section, assert, eq, report } = require('./test-runner');
const tl = require('./_helpers/terminal-layout');
const terminal = require('../io/terminal');
const route = require('../panel/route');
const { getModel } = require('../model/store');
const { dispatchMsg, applyMsg } = require('../dispatch/runtime/loop');
const { _makeDataHandler } = require('../dispatch/control/input');

const flush = (t, bytes) => new Promise((res) => t.write(bytes, res));

// Frames the app paints (the Ctrl+\ exit repaints) are not report lines.
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => (String(chunk).includes('\x1b') ? true : _origWrite(chunk, ...rest));

(async () => {
  if (!terminal.ptyAvailable()) {
    console.log('  (skipped: the optional node-pty dependency is not installed)');
    report();
    return;
  }
  const fx = tl.boot({ cmd: 'sleep 60' });
  const id = fx.id;
  dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: fx.pane().paneId }));
  applyMsg({ type: 'terminal_enter' });
  const s = terminal.getSession(id);
  let writes = [];
  s.pty.write = (d) => { writes.push(d); };
  const stdin = new EventEmitter();
  stdin.on('data', _makeDataHandler(stdin));
  // Host bytes in, what the program's PTY got out.
  const send = (...chunks) => { writes = []; for (const c of chunks) stdin.emit('data', c); return writes; };

  section('[1] special keys are re-encoded as xterm sends them');
  assert(getModel().modes.terminalMode, 'precondition: terminal mode');
  eq(send('\x1b[1~'), ['\x1b[H'], 'tmux Home → xterm Home');
  eq(send('\x1b[4~'), ['\x1b[F'], 'tmux End → xterm End');
  eq(send('\x1b[7~'), ['\x1b[H'], 'rxvt Home → xterm Home');
  eq(send('\x1b[A'), ['\x1b[A'], 'an arrow in normal cursor mode is unchanged');
  eq(send('\x1b[11~'), ['\x1bOP'], 'VT220 F1 → xterm F1');
  await flush(s.screen, '\x1b[?1h');                          // the program sets application cursor keys
  eq(terminal.sessionInputModes(id).appCursor, true, 'precondition: application cursor keys on');
  eq(send('\x1b[A'), ['\x1bOA'], 'an arrow follows the program\'s mode: SS3');
  eq(send('\x1b[1~'), ['\x1bOH'], 'tmux Home → SS3 Home');
  eq(send('\x1b[1;5C'), ['\x1b[1;5C'], 'a modified arrow stays CSI 1;m');
  eq(send('ab\x1b[1~c\x1bx\x03'), ['ab\x1bOHc\x1bx\x03'], 'text, Alt+x and Ctrl+C pass through, in order, in one write');
  await flush(s.screen, '\x1b[?1l');
  eq(send('\x1b[4~'), ['\x1b[F'], 'back in normal cursor mode');

  section('[2] focus reports reach the program only if it asked');
  eq(send('\x1b[O'), [], 'focus-out: not forwarded to a program that didn\'t ask');
  eq(getModel().focused, false, 'lazytui itself saw the focus-out');
  eq(send('\x1b[I'), [], 'focus-in: not forwarded');
  eq(getModel().focused, true, 'lazytui saw the focus-in');
  await flush(s.screen, '\x1b[?1004h');                       // the program asks for focus reports
  eq(send('\x1b[O'), ['\x1b[O'], 'forwarded once the program asked');
  eq(send('\x1b[I'), ['\x1b[I'], '…both ways');
  await flush(s.screen, '\x1b[?1004l');

  section('[3] a paste reaches the program verbatim');
  eq(send('\x1b[200~hi\x1b[201~').join(''), 'hi', 'no markers for a program that didn\'t turn bracketed paste on');
  eq(send('\x1b[200~a\x1cb\x1b[1~c\x1b[5;2~\x1b[201~').join(''), 'a\x1cb\x1b[1~c\x1b[5;2~',
    'pasted Ctrl+\\, key sequences and scrollback keys are text: unchanged, not acted on');
  assert(getModel().modes.terminalMode, '…and the pasted Ctrl+\\ did not leave terminal mode');
  await flush(s.screen, '\x1b[?2004h');                       // the program turns bracketed paste on
  eq(send('\x1b[200~hi\x1b[201~').join(''), '\x1b[200~hi\x1b[201~', 'markers kept once the program asked');
  eq(send('x\x1b[200~one ', 'two', ' three\x1b[201~\x1b[1~').join(''), 'x\x1b[200~one two three\x1b[201~\x1b[H',
    'a paste across chunks, with keys before and after it (the key after is translated again)');
  await flush(s.screen, '\x1b[?2004l');

  section('[4] Shift+Page/Home/End: scrollback at a prompt, the program\'s on the alternate screen');
  eq(send('\x1b[5;2~'), [], 'main screen: Shift+PageUp is lazytui\'s scrollback, not sent');
  await flush(s.screen, '\x1b[?1049h');                       // a full-screen program
  eq(terminal.sessionInputModes(id).altScreen, true, 'precondition: alternate screen');
  eq(send('\x1b[5;2~'), ['\x1b[5;2~'], 'alternate screen: Shift+PageUp goes to the program');
  eq(send('\x1b[1;2H'), ['\x1b[1;2H'], '…and Shift+Home');
  await flush(s.screen, '\x1b[?1049l');

  section('[5] Ctrl+\\ still leaves terminal mode; keys then go to lazytui');
  eq(send('\x1c'), [], 'Ctrl+\\ is not sent');
  assert(!getModel().modes.terminalMode, 'terminal mode left');
  eq(send('\x1b[1~'), [], 'outside terminal mode nothing reaches the program');

  terminal.destroyAll();
  fx.cleanup();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
