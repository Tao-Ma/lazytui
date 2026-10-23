/**
 * Fabric multi-field FORM overlay (args→ports slice 1 commit 2).
 *
 * Paints `model.modal.fabricForm` as a bordered popup with N labeled port
 * fields grouped Required-first. Each row shows name, prefix (`>` on the
 * focused row), the input text with an in-buffer inverse-space caret, and a
 * right-anchored chip (`[default]` / `[modified]` / `[unset]`). The port's
 * `desc` renders dim below the input row — omitted when the port carries no
 * desc, so vertical space stays tight.
 *
 * The companion `fabric-field` overlay (invoke-time single-port popup, ports-
 * pane in-grid edit) stays unchanged — the action-runner picks the lane in
 * commit 3 (2+ ports → this form; 1 port → fabric-field).
 *
 * Render-only. Reads `model.modes.fabricFormMode` + `model.modal.fabricForm`,
 * paints via `renderOverlay`. Returns early when the mode is off or the form
 * carries no fields.
 *
 * Caret stays in-buffer (inverse space, same as fabric-field), so the shared
 * cursor-visibility bitmap at the bottom of paint.js stays untouched
 * (terminalMode / cmdMode only).
 */
'use strict';

const { getModel } = require('../model/store');
const { esc, visibleLen } = require('../leaves/text/ansi');
const { renderOverlay, truncate, viewportDims } = require('../leaves/render/draw');

// Hard max for the overlay; the dims clamp (renderOverlay → overlayBox) narrows
// to COLS-2 on tight terminals.
const MAX_WIDTH = 72;
// Longest chip label is `[modified]` (10 visible cells). Reserve one trailing
// space before the chip for breathing room; renderPanel adds the right border.
const CHIP_SLOT = 11;

function _chipMarkup(f) {
  if (f.isDefault) return '[dim]\\[default][/]';
  if (f.isModified) return '[warning]\\[modified][/]';
  if (f.text === '' && f.default == null) return '[dim]\\[unset][/]';
  return '';
}

// Build the input row for one field. `leftW` is the fixed left column (indent
// + name-pad + gutter + prefix); `midW` is the input area; chip (if any) is
// right-anchored with a 1-cell gap. If the input + caret overflow midW, text
// is truncated via `truncate` (adds `…`); the caret rides along in markup so
// its byte-level `[inverse] [/]` tag survives truncation (zero visible width).
function _inputRow(f, focused, name, pad, leftW, midW, chip) {
  const prefix = focused ? '[accent]>[/] ' : '  ';
  const left = `  ${focused ? '[accent]' + name + '[/]' : name}${pad} ${prefix}`;
  const caret = focused ? '[inverse] [/]' : '';
  const textVis = visibleLen(esc(f.text));
  const caretVis = focused ? 1 : 0;
  let mid;
  if (textVis + caretVis <= midW) {
    const padEnd = ' '.repeat(midW - textVis - caretVis);
    mid = `${esc(f.text)}${caret}${padEnd}`;
  } else {
    // Overflow — truncate text to leave room for the ellipsis; caret rides inside
    // the inverse-tag at the end, becoming visible when text was shorter than midW,
    // suppressed when the ellipsis itself replaced the tail.
    const budget = Math.max(0, midW - 1);                           // 1 for the `…`
    const t = truncate(esc(f.text), budget);
    const tv = visibleLen(t);
    const padEnd = ' '.repeat(Math.max(0, midW - tv - 1));          // -1 for `…`
    mid = `${t}${padEnd}`;                                          // caret dropped on overflow (ellipsis takes the slot)
  }
  const chipPart = chip ? ` ${chip}` : ' '.repeat(CHIP_SLOT + 1);   // reserve the slot so rows align
  return `${left}${mid}${chipPart}`;
}

// Dim one-liner under the input row. Indented past the name/prefix so it
// visually associates with the input to its right. renderPanel truncates
// anything that overflows `innerW` with `…`; we don't pre-truncate here —
// a markup-aware pre-trim would add complexity for no visible gain.
function _descRow(desc, leftW) {
  return `${' '.repeat(leftW)}[dim]${esc(desc)}[/]`;
}

function _sectionHeader(label) {
  return `  [bold][dim]${esc(label)}[/][/]`;
}

function renderFabricFormOverlay() {
  const m = getModel();
  if (!m.modes || !m.modes.fabricFormMode) return;
  const f = m.modal && m.modal.fabricForm;
  if (!f || !Array.isArray(f.fields) || f.fields.length === 0) return;

  // Partition — the reducer already stored fields required-first, but we need
  // the boundary for section headers. A simple linear scan: the first !required
  // field marks the start of Optional.
  const required = f.fields.filter((x) => x.required);
  const optional = f.fields.filter((x) => !x.required);

  // Left column — name padded to the widest name (so prefixes/inputs align).
  const maxNameVis = f.fields.reduce((w, x) => Math.max(w, visibleLen(esc(x.port))), 0);
  const INDENT = 2;      // leading spaces before name
  const PREFIX = 2;      // `> ` / `  `
  const GUTTER = 1;      // space between name col and prefix
  const leftW = INDENT + maxNameVis + GUTTER + PREFIX;

  // overlayBox will clamp menuW to min(MAX_WIDTH, COLS-2); mirror that here so
  // the midW budget matches what the panel actually paints. +2 is the border.
  const menuW = Math.min(MAX_WIDTH, Math.max(0, viewportDims().cols - 2));
  const innerW = Math.max(0, menuW - 2);
  // `midW` is the input area. Reserve the chip slot (chip + 1-cell gap)
  // regardless of whether this row has a chip, so chips across rows line up
  // AND an unchipped row's input doesn't visually bleed into the slot.
  const midW = Math.max(0, innerW - leftW - CHIP_SLOT - 1);

  // Walk partitioned fields -> markup rows. For each field: one input row,
  // plus one dim desc row if a desc is present.
  const findFocus = (field) => f.fields.indexOf(field) === f.focusIdx;
  function pushField(acc, field) {
    const name = esc(field.port);
    const pad = ' '.repeat(Math.max(0, maxNameVis - visibleLen(name)));
    const chip = _chipMarkup(field);
    acc.push(_inputRow(field, findFocus(field), name, pad, leftW, midW, chip));
    if (field.desc) acc.push(_descRow(field.desc, leftW));
  }

  const rows = [];
  if (required.length) {
    rows.push(_sectionHeader('Required'));
    for (const field of required) pushField(rows, field);
  }
  if (required.length && optional.length) rows.push('');  // separator
  if (optional.length) {
    rows.push(_sectionHeader('Optional'));
    for (const field of optional) pushField(rows, field);
  }
  rows.push('');
  rows.push('[dim]\\[tab] next   \\[shift-tab] prev   \\[enter] run   \\[esc] cancel[/]');

  // Title — the action's label (friendlier than its key), falling back to
  // the actionKey, falling back to "Input" like fabric-field does.
  const pa = f.pendingAction;
  const title = (pa && pa.action && typeof pa.action.label === 'string' && pa.action.label)
    ? pa.action.label
    : (pa && typeof pa.actionKey === 'string' && pa.actionKey) || 'Input';

  renderOverlay({ lines: rows, title, maxWidth: MAX_WIDTH });
}

module.exports = { renderFabricFormOverlay };
