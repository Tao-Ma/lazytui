/**
 * Terminal helpers — cursor, screen, ANSI output.
 * Zero dependencies.
 */
'use strict';

const stdout = process.stdout;
let COLS = stdout.columns || 80;
let ROWS = stdout.rows || 24;

function refreshSize() {
  COLS = stdout.columns || 80;
  ROWS = stdout.rows || 24;
}

function moveTo(row, col) { stdout.write(`\x1b[${row};${col}H`); }
function clearScreen() { stdout.write('\x1b[2J\x1b[H'); }
function hideCursor() { stdout.write('\x1b[?25l'); }
function showCursor() { stdout.write('\x1b[?25h'); }
function enableMouse() { stdout.write('\x1b[?1000h\x1b[?1006h'); }
function disableMouse() { stdout.write('\x1b[?1000l\x1b[?1006l'); }

function cols() { return COLS; }
function rows() { return ROWS; }

module.exports = {
  refreshSize, moveTo, clearScreen, hideCursor, showCursor,
  enableMouse, disableMouse, cols, rows, stdout,
};
