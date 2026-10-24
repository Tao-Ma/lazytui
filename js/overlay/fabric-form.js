/**
 * Fabric multi-field FORM overlay (args→ports slice 1 commit 2 + pre-release
 * review fixes).
 *
 * Paints `model.modal.fabricForm` as a bordered popup with N labeled port
 * fields grouped Required-first. Each row shows name, prefix (`>` on the
 * focused row), the input text with an in-buffer inverse-space caret, and a
 * right-anchored chip (`[default]` / `[modified]` / `[unset]`). The port's
 * `desc` renders dim below the input row — omitted when the port carries no
 * desc, so vertical space stays tight.
 *
 * Scroll-follows-focus (slice 1 pre-release review Fork 3 F1): on an action
 * with more fields than fit in the viewport, Tab-ing past the viewport edge
 * scrolls the box so the focused row stays visible. The reducer only tracks
 * `focusIdx`; scroll is a pure function of (lines array, focused line index,
 * inner height) computed per render — no model state for scroll, so there is
 * no stale-scroll edge case.
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
// How many rows of context to keep BELOW the focused row when scroll-follows-
// focus kicks in. 2 is enough to see the dim desc of the next field (if any)
// so the user has forward look-ahead while Tab-ing.
const SCROLL_BOTTOM_CONTEXT = 2;

function _chipMarkup(f) {
  // Computed-choices chip variants (args→ports slice 2) take precedence while
  // the fetch is pending or errored. Once state === 'ok' and the user hasn't
  // picked / typed yet, the chip reads `[N choices]` so the affordance is
  // visible before the user presses space to open the popover.
  if (f.computed) {
    if (f.computed.state === 'pending') return '[dim]\\[fetching…][/]';
    if (f.computed.state === 'error')   return '[error]\\[error][/]';
    if (f.computed.state === 'ok' && f.text === '' && f.default == null) {
      const n = f.computed.items.length;
      return `[dim]\\[${n} choice${n === 1 ? '' : 's'}][/]`;
    }
  }
  if (f.isDefault) return '[dim]\\[default][/]';
  if (f.isModified) return '[warning]\\[modified][/]';
  if (f.text === '' && f.default == null) return '[dim]\\[unset][/]';
  return '';
}

// Build the input row for one field. `leftW` is the fixed left column (indent
// + name-pad + gutter + prefix); `midW` is the input area; chip (if any) is
// right-anchored inside a CHIP_SLOT-wide reserve so chips of different widths
// ([default]=9, [modified]=10, [unset]=7) all END at the same column — the
// right-anchoring the docstring originally claimed, now actually enforced
// (slice-1 pre-release review round 2 Finding 3). If the input + caret
// overflow midW, text is truncated via `truncate` (adds `…`); the caret rides
// along in markup so its byte-level `[reverse] [/]` tag survives truncation
// (zero visible width).
//
// Narrow-terminal fallback: when `midW` collapses to 0 (COLS ≈ 20 — menuW=18,
// innerW=16, leftW ≈ 9, CHIP_SLOT+1 = 12 → midW = max(0, 16-9-12) = 0), the
// input area is a zero-width placeholder AND the chip reserve would push the
// row past innerW, so renderPanel truncates with `…` and the chip disappears
// mid-glyph. Drop the chip reserve in that case so the name and prefix
// survive; chip is omitted for the frame — the user still sees the field
// name, which is more useful than a mangled chip (slice-1 pre-release review
// round 2 UX Fork Finding 2).
function _inputRow(f, focused, name, pad, leftW, midW, chip) {
  const prefix = focused ? '[accent]>[/] ' : '  ';
  const left = `  ${focused ? '[accent]' + name + '[/]' : name}${pad} ${prefix}`;
  const caret = focused ? '[reverse] [/]' : '';
  const textVis = visibleLen(esc(f.text));
  const caretVis = focused ? 1 : 0;
  let mid;
  if (textVis + caretVis <= midW) {
    const padEnd = ' '.repeat(midW - textVis - caretVis);
    mid = `${esc(f.text)}${caret}${padEnd}`;
  } else {
    // Overflow — truncate text to leave room for the ellipsis; caret is
    // dropped (ellipsis takes the slot). `truncate` returns a string whose
    // visibleLen ALREADY INCLUDES the trailing `…`, so pad to midW directly.
    const budget = Math.max(0, midW);
    const t = truncate(esc(f.text), budget);
    const tv = visibleLen(t);
    const padEnd = ' '.repeat(Math.max(0, midW - tv));
    mid = `${t}${padEnd}`;
  }
  let chipPart;
  if (midW <= 0) {
    // Narrow-terminal fallback: no room for the chip reserve, so drop it.
    chipPart = '';
  } else if (chip) {
    // Right-anchor the chip inside the CHIP_SLOT reserve so chips of
    // different widths all end at the same column.
    const chipVis = visibleLen(chip);
    const lead = ' '.repeat(Math.max(0, CHIP_SLOT - chipVis));
    chipPart = ` ${lead}${chip}`;
  } else {
    // No chip for this row, but reserve the slot so sibling rows' chips
    // land in the same column.
    chipPart = ' '.repeat(CHIP_SLOT + 1);
  }
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
  // Rich `[/]` is a FULL reset (not a style-stack pop), so a `[bold][dim]…[/]`
  // reads as "bold+dim combined" which many terminals render as JUST dim
  // (bold weight suppressed by the dim attribute). Section headers want
  // visual prominence, not de-emphasis — pick BOLD alone. (slice-1 round 3
  // theme fork Finding 3.)
  return `  [bold]${esc(label)}[/]`;
}

// Compute scrollOffset so the focused row stays visible, with a bit of
// bottom-context so the user can see the next field while Tab-ing forward.
// Pure function of (focusLineIdx, totalLines, innerH); no reducer state.
function _scrollFor(focusLineIdx, totalLines, innerH) {
  if (totalLines <= innerH) return 0;
  const maxScroll = totalLines - innerH;
  // Keep SCROLL_BOTTOM_CONTEXT rows below the focus if possible — unless the
  // focus is near the end of the list, in which case the clamp against
  // maxScroll takes over and shows the tail.
  const wantBottom = focusLineIdx + SCROLL_BOTTOM_CONTEXT;
  const scroll = Math.max(0, Math.min(wantBottom - (innerH - 1), maxScroll));
  // Never scroll so far that the focus row goes above the viewport.
  if (focusLineIdx < scroll) return focusLineIdx;
  return scroll;
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
  const vp = viewportDims();
  const menuW = Math.min(MAX_WIDTH, Math.max(0, vp.cols - 2));
  const innerW = Math.max(0, menuW - 2);
  // `midW` is the input area. Reserve the chip slot (chip + 1-cell gap)
  // regardless of whether this row has a chip, so chips across rows line up
  // AND an unchipped row's input doesn't visually bleed into the slot.
  const midW = Math.max(0, innerW - leftW - CHIP_SLOT - 1);

  // Walk partitioned fields → markup rows, tracking which line the focused
  // row lands on so scroll-follows-focus can land that row inside the viewport.
  const focusField = f.fields[f.focusIdx] || null;
  const findFocus = (field) => field === focusField;
  let focusLineIdx = -1;
  const rows = [];
  const picking = f.picking;
  function pushField(field) {
    const name = esc(field.port);
    const pad = ' '.repeat(Math.max(0, maxNameVis - visibleLen(name)));
    const chip = _chipMarkup(field);
    if (findFocus(field)) focusLineIdx = rows.length;
    rows.push(_inputRow(field, findFocus(field), name, pad, leftW, midW, chip));
    if (field.desc) rows.push(_descRow(field.desc, leftW));
    // Choices popover: when this field is the picked port, render the choices
    // list indented to the input column. Highlighted entry inverse-painted
    // (matches the caret / field-focus style). The error path shows the error
    // text instead of the list; a pending popover shows an awaiting-row so
    // the user has visible feedback that the fetch is in flight.
    if (picking && picking.port === field.port) {
      const c = field.computed || null;
      if (!c || c.state === 'pending') {
        rows.push(`${' '.repeat(leftW)}[dim]awaiting choices…[/]`);
      } else if (c.state === 'error') {
        rows.push(`${' '.repeat(leftW)}[error]${esc(c.error || 'choices failed')}[/]`);
      } else if (c.state === 'ok') {
        if (c.items.length === 0) {
          rows.push(`${' '.repeat(leftW)}[dim](no choices)[/]`);
        } else {
          for (let i = 0; i < c.items.length; i++) {
            const label = c.labels && c.labels[i] ? c.labels[i] : c.items[i];
            const painted = i === picking.idx
              ? `[reverse]${esc(label)}[/]`
              : esc(label);
            rows.push(`${' '.repeat(leftW)}${painted}`);
          }
        }
      }
    }
  }

  if (required.length) {
    rows.push(_sectionHeader('Required'));
    for (const field of required) pushField(field);
  }
  if (required.length && optional.length) rows.push('');  // separator
  if (optional.length) {
    rows.push(_sectionHeader('Optional'));
    for (const field of optional) pushField(field);
  }
  // Required-still-missing hint — list any required field whose text is empty
  // AND has no default to fall back on. Shows BOTH on first open (if any
  // required was unresolved) AND on reopen (after a submit-with-empty bounced
  // off the resolver and reopened the form). Without this hint, a user whose
  // submit silently reopened the same form would think the TUI was wedged.
  // (Slice-1 pre-release review round 4 Fork 1 S3.)
  const stillMissing = f.fields
    .filter((x) => x.required && x.text === '' && x.default == null)
    .map((x) => x.port);
  rows.push('');
  if (stillMissing.length) {
    rows.push(`[warning]required inputs still missing: ${esc(stillMissing.join(', '))}[/]`);
  }
  // Help line adapts to the mode: the picker gets its own keys; a focused
  // computed-choices field advertises `[space] choices` so the affordance is
  // discoverable without reading docs.
  if (picking) {
    rows.push('[dim]\\[up/down] move   \\[enter] pick   \\[esc] close[/]');
  } else {
    const focused = f.fields[f.focusIdx];
    const hasChoices = focused && focused.choicesFnRef;
    const spaceHint = hasChoices ? '   \\[space] choices' : '';
    rows.push(`[dim]\\[tab] next   \\[shift-tab] prev${spaceHint}   \\[enter] run   \\[esc] cancel[/]`);
  }

  // Title — the action's label (friendlier than its key), falling back to
  // the actionKey, falling back to "Input" like fabric-field does. esc() the
  // title so a YAML `label: "[reverse]EVIL[/]"` lands as a 20-cell literal in
  // the top border, not styled markup (pre-release review Fork 2 Finding 1,
  // shared with fabric-field).
  const pa = f.pendingAction;
  const rawTitle = (pa && pa.action && typeof pa.action.label === 'string' && pa.action.label)
    ? pa.action.label
    : (pa && typeof pa.actionKey === 'string' && pa.actionKey) || 'Input';
  const title = esc(rawTitle);

  // Scroll — innerH matches renderPanel's: menuH-2, menuH = min(rows+2, ROWS-2).
  const menuH = Math.min(rows.length + 2, Math.max(0, vp.rows - 2));
  const innerH = Math.max(1, menuH - 2);
  const scrollOffset = focusLineIdx < 0 ? 0 : _scrollFor(focusLineIdx, rows.length, innerH);

  renderOverlay({ lines: rows, title, maxWidth: MAX_WIDTH, scrollOffset });
}

module.exports = { renderFabricFormOverlay, _scrollFor };
