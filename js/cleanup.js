/**
 * Process exit hygiene — kill children, restore the terminal.
 * Called on user-quit (q / Ctrl-C) and from process.on('exit').
 *
 * Order matters: kill the streamed action first (so its stdout doesn't
 * arrive after we've reset the screen), then PTYs, then mouse + cursor +
 * full reset, finally clear and home cursor.
 */
'use strict';

const { RESET } = require('./ansi');
const { showCursor, moveTo, stdout, clearScreen, disableMouse } = require('./term');
const { destroyAll } = require('./terminal');
const { killCurrentProc } = require('./actions');

function cleanup() {
  killCurrentProc();
  destroyAll();
  disableMouse();
  showCursor();
  stdout.write(RESET);
  clearScreen();
  moveTo(1, 1);
}

module.exports = { cleanup };
