/**
 * Prompt overlay — single-line input modal for actions that declare `args:`.
 *
 * State + behavior now live in the reducer (runtime.update: prompt_enter/key/
 * submit/cancel). The caller stages a base do_run Cmd descriptor; submit
 * parses args from the typed text and merges them in. This module is
 * render-only: renderPromptOverlay paints model.modal.prompt + positions the
 * terminal cursor. The autosuggest ghost is seeded by the caller (from the
 * yank register) into model.modal.prompt.ghost.
 */
'use strict';

const { getModel } = require('../model/store');
const { _ghostSuffix } = require('../app/runtime');
const { esc, visibleLen } = require('../io/ansi');
const { renderOverlay, viewportDims } = require('../render/panel');
const { stdout } = require('../io/term');

function renderPromptOverlay() {
  if (!getModel().modes.promptMode) return;
  const p = getModel().modal.prompt;
  const lines = [];
  if (p.spec) lines.push(`[dim]args: ${esc(p.spec)}[/]`);
  lines.push('');
  // Autosuggest tail (dim, after the typed text) — empty unless the typed
  // text is a strict prefix of the ghost.
  const tail = _ghostSuffix(p.text, p.ghost);
  const tailMarkup = tail ? `[dim]${esc(tail)}[/]` : '';
  const inputLine = `> ${esc(p.text)}${tailMarkup}`;
  const inputLineIdx = lines.length;
  lines.push(inputLine);
  lines.push('');
  const acceptHint = tail ? '   \\[Tab/→] accept' : '';
  lines.push(`[dim]\\[Enter] run${acceptHint}   \\[Ctrl+U] clear   \\[Esc] cancel[/]`);

  const maxWidth = 70;
  renderOverlay({ lines, title: p.label, maxWidth });

  // Position the real cursor at the end of the typed text (before the dim
  // tail). Mirrors renderOverlay's offX/offY math. Visibility is flipped on
  // by layout.render when promptMode is true.
  const { cols: COLS, rows: ROWS } = viewportDims();
  const W = Math.min(maxWidth, COLS - 2);
  const H = Math.min(lines.length + 2, ROWS - 2);
  const offY = Math.max(0, Math.floor((ROWS - H) / 2));
  const offX = Math.max(0, Math.floor((COLS - W) / 2));
  const cursorRow = offY + 1 + inputLineIdx + 1;
  const cursorCol = offX + 1 + 1 + 2 + visibleLen(esc(p.text));
  stdout.write(`\x1b[${cursorRow};${cursorCol}H`);
}

module.exports = { renderPromptOverlay };
