/**
 * Prompt overlay — single-line input modal for actions that declare `args:`.
 *
 * When the user hits Enter on an action with `args:` from the actions
 * panel, dispatch.js opens this overlay instead of running directly. The
 * caller stages a label, the args spec (display hint), and a callback
 * that receives the parsed arg array. Enter submits, Esc cancels.
 *
 * Pattern matches confirm.js: one S flag (S.promptMode) + module-private
 * label/spec/text/onSubmit; render via panel.renderOverlay; submit
 * deferred through setImmediate so the overlay-gone frame paints before
 * doRun() blocks on spawn().
 *
 * Args parsing: whitespace-split, no shell-style quoting (same v1 rule as
 * cmdline). Empty input → empty args array — script bodies still get
 * called with no positional params, matching the cmdline behavior of
 * `:exec` with no trailing text.
 */
'use strict';

const { S } = require('./state');
const { esc, visibleLen } = require('./ansi');
const { renderOverlay } = require('./panel');
const { stdout, cols, rows } = require('./term');

let _label = '';
let _spec = '';
let _text = '';
let _onSubmit = null;

function enterPrompt(label, spec, onSubmit, initialText = '') {
  _label = label || 'Input';
  _spec = spec || '';
  // Pre-fill the input — the cursor lands at the end (visibleLen of
  // _text in renderPromptOverlay). Backspace deletes one char; Ctrl+U
  // clears the line for fast override.
  _text = typeof initialText === 'string' ? initialText : '';
  _onSubmit = typeof onSubmit === 'function' ? onSubmit : null;
  S.promptMode = true;
}

function exitPrompt(commit) {
  const fn = _onSubmit;
  const text = _text;
  S.promptMode = false;
  _label = '';
  _spec = '';
  _text = '';
  _onSubmit = null;
  if (commit && fn) {
    const args = text.trim() ? text.trim().split(/\s+/) : [];
    // Defer: same reason as confirm.js — let the input pump paint the
    // overlay-gone frame before the callback runs (which typically
    // ends in spawn()).
    setImmediate(() => fn(args));
  }
}

function handlePromptKey(key, seq) {
  if (key === 'escape') { exitPrompt(false); return; }
  if (key === 'return') { exitPrompt(true);  return; }
  if (seq === '\x7f') { _text = _text.slice(0, -1); return; }   // Backspace
  if (seq === '\x15') { _text = ''; return; }                   // Ctrl+U — clear line
  if (seq && seq.length === 1 && seq.charCodeAt(0) >= 32 && seq.charCodeAt(0) < 127) {
    _text += seq;
  }
}

function renderPromptOverlay() {
  if (!S.promptMode) return;
  const lines = [];
  if (_spec) lines.push(`[dim]args: ${esc(_spec)}[/]`);
  lines.push('');
  const inputLine = `> ${esc(_text)}`;
  const inputLineIdx = lines.length;
  lines.push(inputLine);
  lines.push('');
  lines.push('[dim]\\[Enter] run   \\[Ctrl+U] clear   \\[Esc] cancel[/]');

  const maxWidth = 70;
  renderOverlay({ lines, title: _label, maxWidth });

  // Position the real terminal cursor at the end of the typed text.
  // Mirror renderOverlay's offX/offY math so the cursor lands inside
  // the input row of the box. Visibility is flipped on by layout.render
  // when S.promptMode is true.
  const COLS = cols(), ROWS = rows();
  const W = Math.min(maxWidth, COLS - 2);
  const H = Math.min(lines.length + 2, ROWS - 2);
  const offY = Math.max(0, Math.floor((ROWS - H) / 2));
  const offX = Math.max(0, Math.floor((COLS - W) / 2));
  // ANSI rows/cols are 1-based; +1 for the box's top border, +1 for left.
  const cursorRow = offY + 1 + inputLineIdx + 1;
  const cursorCol = offX + 1 + 1 + 2 + visibleLen(esc(_text));
  stdout.write(`\x1b[${cursorRow};${cursorCol}H`);
}

module.exports = { enterPrompt, exitPrompt, handlePromptKey, renderPromptOverlay };
