/**
 * Terminal mode forwards the mouse to the program in ITS terminal's terms.
 *
 * Field report 2026-11-14 (nvim in a `type: terminal` pane): a click in the
 * pane moved nvim's cursor ~35 columns off. In terminal mode, a child that had
 * turned mouse reporting on got the host terminal's SGR bytes RAW — coordinates
 * of the whole screen, not of the pane; events outside the pane too; and always
 * in SGR, though a child may ask for another encoding (vim picks the legacy X10
 * encoding from the `ESC [ > c` answer the emulator now gives it).
 *
 * Now each host event is decoded, made pane-relative, and encoded by the pane's
 * own emulator (io/term-screen screenMouseReport) for the protocol + encoding
 * the child asked for; the bytes reach the PTY through the reply wiring.
 *
 *   [1] SGR child: a click / release arrive pane-relative (1-based)
 *   [2] presses / hover outside the terminal are not the child's; a drag
 *       release outside clamps to the edge (no stuck button in the child)
 *   [3] keys and mouse in one chunk keep their order
 *   [4] modifiers + wheel
 *   [5] the child's protocol filters: no hover motion for a button-event child,
 *       motion for an any-event child
 *   [6] legacy encoding (no 1006): X10 bytes, as raw bytes
 *   [7] mouse reporting off: unchanged (wheel = scrollback, clicks dropped)
 *
 * Run: node js/test/test-terminal-mouse-forward.js
 */
'use strict';

const { section, assert, eq, report } = require('./test-runner');
const tl = require('./_helpers/terminal-layout');
const terminal = require('../io/terminal');
const route = require('../panel/route');
const { visibleTerminalSurfaces } = require('../panel/terminal-surfaces');
const { getModel } = require('../model/store');
const { dispatchMsg, applyMsg } = require('../dispatch/runtime/loop');
const { _handleTerminalChunk } = require('../dispatch/control/input');

// Frames the app paints (escape sequences) are not this test's subject; the
// runner's plain report lines pass through.
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => (String(chunk).includes('\x1b') ? true : _origWrite(chunk, ...rest));

const flush = (screen, bytes) => new Promise((res) => screen.write(bytes, res));
const show = (w) => JSON.stringify(Buffer.isBuffer(w) ? [...w] : w);

(async () => {
  if (!terminal.ptyAvailable()) {
    console.log('  (skipped: the optional node-pty dependency is not installed)');
    process.stdout.write = _origWrite;
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
  const surf = visibleTerminalSurfaces(getModel()).find(x => x.id === id);
  // Host (1-based, whole screen) coordinates of the terminal's grid cell
  // (col, row) — 0-based inside the pane; the overlay paints cell (0,0) at
  // screen column bounds.x + 2, row bounds.y + 2.
  const X = (col) => surf.bounds.x + 2 + col;
  const Y = (row) => surf.bounds.y + 2 + row;
  const sgr = (btn, col, row, fin = 'M') => `\x1b[<${btn};${X(col)};${Y(row)}${fin}`;
  const send = (data) => { writes = []; _handleTerminalChunk(data, () => {}); return writes; };

  section('[1] SGR child: click + release arrive pane-relative');
  // io/term-screen encodes through xterm's internal mouse service (the public
  // headless API has no encoder) — pin it, so an upgrade that moves it fails here.
  assert(s.screen._core && typeof s.screen._core.coreMouseService.triggerMouseEvent === 'function',
    'precondition: the emulator\'s mouse encoder is where term-screen reaches for it');
  assert(getModel().modes.terminalMode, 'precondition: terminal mode');
  await flush(s.screen, '\x1b[?1002h\x1b[?1006h');   // button-event tracking, SGR
  eq(terminal.sessionMouseMode(id), 'drag', 'precondition: the child enabled button-event tracking');
  eq(send(sgr(0, 4, 2)), ['\x1b[<0;5;3M'], 'press at grid (4,2) → the child sees column 5, row 3');
  eq(send(sgr(0, 4, 2, 'm')), ['\x1b[<0;5;3m'], 'release likewise');
  eq(send(sgr(0, 0, 0)), ['\x1b[<0;1;1M'], 'the grid origin is (1,1)');
  send(sgr(0, 0, 0, 'm'));

  section('[2] outside the terminal');
  eq(send(`\x1b[<0;${X(-1)};${Y(3)}M`), [], 'a press on the left border is not the child\'s');
  eq(send(`\x1b[<0;${X(3)};${Y(-1)}M`), [], 'nor on the title row');
  eq(send(`\x1b[<0;${X(surf.cols + 20)};${Y(3)}M`), [], 'nor in another pane');
  eq(send(`\x1b[<64;${X(surf.cols + 20)};${Y(3)}M`), [], 'nor a wheel over another pane');
  send(sgr(0, 5, 5));                                       // drag starts inside…
  eq(send(`\x1b[<32;${X(surf.cols + 20)};${Y(5)}M`), [`\x1b[<32;${surf.cols};6M`],
    '…a drag motion past the right edge clamps to the last column');
  eq(send(`\x1b[<0;${X(surf.cols + 20)};${Y(5)}m`), [`\x1b[<0;${surf.cols};6m`],
    '…and its release too: the child never keeps a stuck button');

  section('[3] keys and mouse in one chunk keep their order');
  eq(send(`a${sgr(0, 1, 1)}b`), ['a', '\x1b[<0;2;2M', 'b'], 'a, click, b');
  send(sgr(0, 1, 1, 'm'));

  section('[4] modifiers + wheel');
  eq(send(sgr(16, 2, 2)), ['\x1b[<16;3;3M'], 'Ctrl+click keeps Ctrl');
  send(sgr(16, 2, 2, 'm'));
  eq(send(sgr(8, 2, 2)), ['\x1b[<8;3;3M'], 'Alt+click keeps Alt');
  send(sgr(8, 2, 2, 'm'));
  eq(send(sgr(64, 3, 3)), ['\x1b[<64;4;4M'], 'wheel up');
  eq(send(sgr(65, 3, 3)), ['\x1b[<65;4;4M'], 'wheel down');
  eq(send(sgr(2, 3, 3)), ['\x1b[<2;4;4M'], 'right button');
  send(sgr(2, 3, 3, 'm'));

  section('[5] the child\'s protocol filters');
  eq(send(sgr(35, 6, 6)), [], 'hover motion (no button) is not sent to a button-event child');
  await flush(s.screen, '\x1b[?1003h');                    // any-event tracking
  eq(send(sgr(35, 6, 6)), ['\x1b[<35;7;7M'], 'an any-event child gets it');
  eq(send(sgr(35, 7, 6)), ['\x1b[<35;8;7M'], 'and the next cell');
  await flush(s.screen, '\x1b[?1003l\x1b[?1002l\x1b[?1000h');   // back to press/release only

  section('[6] legacy encoding (no 1006): X10 bytes');
  await flush(s.screen, '\x1b[?1006l');
  const w = send(sgr(0, 4, 2));
  eq(w.length, 1, 'one report');
  assert(Buffer.isBuffer(w[0]), `written as raw bytes, not a UTF-8 string (${show(w[0])})`);
  eq(show(w[0]), show(Buffer.from([0x1b, 0x5b, 0x4d, 32 + 0, 32 + 5, 32 + 3])), 'ESC [ M, button, column, row (+32)');
  const far = send(`\x1b[<0;${X(surf.cols - 1)};${Y(2)}M`);
  eq(far.length, 1, 'the last column is encodable too');

  section('[7] mouse reporting off: unchanged');
  await flush(s.screen, '\x1b[?1000l');
  eq(terminal.sessionMouseMode(id), 'none', 'precondition: reporting off');
  eq(send(sgr(0, 4, 2)), [], 'a click is dropped (the child never asked for the mouse)');
  eq(send(`x${sgr(0, 4, 2)}y`), ['xy'], 'keys around it are forwarded');

  applyMsg({ type: 'terminal_exit' });
  terminal.destroyAll();
  fx.cleanup();
  process.stdout.write = _origWrite;
  report();
})();
