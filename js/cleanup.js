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
const {
  showCursor, moveTo, stdout, clearScreen,
  disableMouse, disableFocusEvents, disableBracketedPaste,
} = require('./term');
const { destroyAll } = require('./terminal');
const { killCurrentProc } = require('./actions');

function cleanup() {
  killCurrentProc();
  destroyAll();
  // Stop plugin refresh loops + fire plugin cleanup hooks (e.g. docker's
  // events stream) so no timer or child fires after quit. Lazy-required
  // and guarded: CLI mode (--exec/--list) never loaded the plugin API.
  try {
    const api = require('./plugins/api');
    api.stopRefreshLoops();
    api.cleanupPlugins();
  } catch { /* plugin API not initialized (CLI path) */ }
  disableMouse();
  disableFocusEvents();
  disableBracketedPaste();
  showCursor();
  stdout.write(RESET);
  clearScreen();
  moveTo(1, 1);
}

module.exports = { cleanup };
