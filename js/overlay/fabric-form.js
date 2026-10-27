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
const { filterChoices } = require('../leaves/ports/choices-filter');
const { windowSlice } = require('../leaves/render/window-slice');

// Hard max for the overlay; the dims clamp (renderOverlay → overlayBox) narrows
// to COLS-2 on tight terminals.
const MAX_WIDTH = 72;
// Floor on the chip reserve — covers [modified] (10) + 1 for breathing room.
// The actual reserve each frame is `max(MIN_CHIP_SLOT, longest chip actually
// painted)`, so slice-2's longer labels ([fetching…]=10, [1024 choices]=15)
// don't overflow and truncate the row (R1D-BUG1).
const MIN_CHIP_SLOT = 11;
// How many rows of context to keep BELOW the focused row when scroll-follows-
// focus kicks in. 2 is enough to see the dim desc of the next field (if any)
// so the user has forward look-ahead while Tab-ing.
const SCROLL_BOTTOM_CONTEXT = 2;

function _chipMarkup(f) {
  // Computed-choices chip variants (args→ports slice 2) take precedence while
  // the fetch is pending or errored. Once state === 'ok' AND the user hasn't
  // picked / typed over the pre-fill, the chip reads `[N choices]` so the
  // affordance stays visible even when the port has a default (R1D-SMELL1:
  // slice-2 originally gated the chip on `default == null`, which hid the
  // affordance from the most common case — a computed port with a sensible
  // default). An actively modified field flips to `[modified]`, as before.
  if (f.computed) {
    // Brief 3 — the `⟳` suffix marks items served from the stale-while-
    // refetch cache: the user sees content immediately on form-open, but
    // a fresh fetch is in flight (ok+stale) OR failed and we're showing
    // the last-known list under an error chip (error+stale with items).
    // The ⟳ clears when the fresh ok settles.
    const staleMark = f.computed.stale ? ' ⟳' : '';
    if (f.computed.state === 'pending') return '[dim]\\[fetching…][/]';
    if (f.computed.state === 'error') {
      // Keep showing stale items under the error chip when the fetch failed
      // but we have a prior list — brief: "an old list beats an empty popover".
      return `[error]\\[error${staleMark}][/]`;
    }
    if (f.computed.state === 'ok' && !f.isModified) {
      const n = f.computed.items.length;
      return `[dim]\\[${n} choice${n === 1 ? '' : 's'}${staleMark}][/]`;
    }
  }
  // Brief 3 (v0.6.43) — a field seeded from this session's formHistory and
  // not yet edited reads `[last]`, under an accent (same color weight as
  // the computed-choices `[fetching…]` chip — the user looks for it on
  // every form re-open). Takes precedence over [modified] / [default]
  // because the author submitted this value LAST and the field hasn't
  // changed since — paint the stronger signal. Any edit (`_editCurrent`)
  // clears `isLast`, dropping the chip back to the standard three.
  if (f.isLast) return '[accent]\\[last][/]';
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
function _inputRow(f, focused, name, pad, leftW, midW, chip, chipSlot) {
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
    // Right-anchor the chip inside the reserve so chips of different widths
    // all end at the same column.
    const chipVis = visibleLen(chip);
    const lead = ' '.repeat(Math.max(0, chipSlot - chipVis));
    chipPart = ` ${lead}${chip}`;
  } else {
    // No chip for this row, but reserve the slot so sibling rows' chips
    // land in the same column.
    chipPart = ' '.repeat(chipSlot + 1);
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
  // Dynamic chip reserve: scan every field's chip once up front and take the
  // widest. Slice 1's fixed CHIP_SLOT=11 was tuned for [modified]; slice 2's
  // [fetching…] / [N choices] / [1024 choices] overran at N≥10 (R1D-BUG1).
  // Precomputing lets wider chips still right-anchor and shorter chips still
  // line up at a shared end column.
  let chipSlot = MIN_CHIP_SLOT;
  for (const field of f.fields) {
    const c = _chipMarkup(field);
    if (c) chipSlot = Math.max(chipSlot, visibleLen(c));
  }
  // `midW` is the input area. Reserve the chip slot (chip + 1-cell gap)
  // regardless of whether this row has a chip, so chips across rows line up
  // AND an unchipped row's input doesn't visually bleed into the slot.
  const midW = Math.max(0, innerW - leftW - chipSlot - 1);

  // Walk partitioned fields → markup rows, tracking which line the focused
  // row lands on so scroll-follows-focus can land that row inside the viewport.
  // When the choices popover is open, we also track the HIGHLIGHTED-choice row
  // and prefer it as the scroll anchor so the user's selection stays visible
  // even in a long list (R1D-BUG2).
  const focusField = f.fields[f.focusIdx] || null;
  const findFocus = (field) => field === focusField;
  let focusLineIdx = -1;
  let pickingLineIdx = -1;
  const rows = [];
  const picking = f.picking;

  // Pre-compute stillMissing + chrome row count so the popover's item slice
  // can size itself to the ACTUAL chrome, not a constant guess. R-II-3-BUG1:
  // a static CHROME_RESERVE=10 was calibrated for 1-field forms (chrome ≈ 7)
  // and pushed the help line + required-missing footer off screen for
  // 2+field forms (chrome 11-15), re-manifesting R2-BUG2 under cert-reissue /
  // kubectl-exec shapes at vp.rows=24. Dynamic count below walks the actual
  // form state. Border rows (2) are NOT in rows[] but still eat viewport —
  // `innerH = vp.rows - 4` because `menuH = min(rows+2, vp.rows-2)`.
  const stillMissing = f.fields
    .filter((x) => x.required && x.text === '' && x.default == null)
    .map((x) => x.port);
  const chromeRows =
    (required.length ? 1 : 0) +                                   // Required header
    (optional.length ? 1 : 0) +                                   // Optional header
    (required.length && optional.length ? 1 : 0) +                // req/opt separator
    f.fields.reduce((n, x) => n + 1 + (x.desc ? 1 : 0), 0) +      // every field's input + desc
    1 +                                                           // '' separator before still-missing
    (stillMissing.length ? 1 : 0) +
    1;                                                            // help line
  function pushField(field) {
    const name = esc(field.port);
    const pad = ' '.repeat(Math.max(0, maxNameVis - visibleLen(name)));
    const chip = _chipMarkup(field);
    if (findFocus(field)) focusLineIdx = rows.length;
    rows.push(_inputRow(field, findFocus(field), name, pad, leftW, midW, chip, chipSlot));
    if (field.desc) rows.push(_descRow(field.desc, leftW));
    // Choices popover: when this field is the picked port, render the choices
    // list indented to the input column. Highlighted entry inverse-painted
    // (matches the caret / field-focus style). The error path shows the error
    // text instead of the list; a pending popover shows an awaiting-row so
    // the user has visible feedback that the fetch is in flight.
    if (picking && picking.port === field.port) {
      const c = field.computed || null;
      // Brief 2 — paint `/<filter>` affordance line ABOVE the choices rows
      // whenever the user has typed anything. Dim+accent so it reads as a
      // state cue, not a selection target. Rendered even in pending/error
      // states (the filter buffered mid-fetch applies when ok lands —
      // showing it keeps the state visible). An empty filter paints no
      // row, so the popover's chrome stays as compact as pre-Brief-2.
      const filterStr = typeof picking.filter === 'string' ? picking.filter : '';
      if (filterStr) {
        // Pre-release round-2 edge-case review — truncate the filter text
        // to the available input area so a 100-char filter on a narrow
        // terminal (COLS=20) can't push the panel-painter's `…`
        // truncation mid-markup (`[acc…`) and leak a stray `[accent` into
        // the frame. The chip slot is reserved on data rows but NOT on
        // the filter row (filter is single-column, left-aligned), so the
        // budget is the inner width minus the leading left column.
        const filterBudget = Math.max(1, innerW - leftW);
        const filterPainted = truncate(esc(filterStr), filterBudget);
        rows.push(`${' '.repeat(leftW)}[dim]/[/][accent]${filterPainted}[/]`);
      }
      if (!c || c.state === 'pending') {
        rows.push(`${' '.repeat(leftW)}[dim]awaiting choices…[/]`);
      } else if (c.state === 'error') {
        rows.push(`${' '.repeat(leftW)}[error]${esc(c.error || 'choices failed')}[/]`);
      } else if (c.state === 'ok') {
        if (c.items.length === 0) {
          rows.push(`${' '.repeat(leftW)}[dim](no choices)[/]`);
        } else {
          // Brief 2 — the FILTERED view is what we paint, nav against, and
          // what dispatch.js's Enter looks up. Shared leaf, same list.
          const view = filterChoices(c.items, c.labels || null, filterStr);
          if (view.items.length === 0) {
            // "no match" row: filter is active and nothing survived. Enter
            // dispatches close here (dispatch.js guards on view[idx] === undefined).
            rows.push(`${' '.repeat(leftW)}[dim](no match)[/]`);
          } else {
            // Cap displayed items so the help line + required-missing footer
            // stay visible on tall-choices lists (R2-BUG2: items ≥~viewport
            // rows otherwise swallowed the hint). `chromeRows` computed above
            // walks the actual form state (section headers, every field's
            // input+desc, separator, still-missing, help), so a 1-field form
            // and a 5-field form get the right budget each. −4 is the border
            // (menuH compensates by 2 + innerH compensates by another 2) −
            // another 1 reserved for the overflow indicator row. Minimum
            // budget is 3 so the picker stays usable even on tiny terminals;
            // on terminals too small for chrome + 3 items + indicator, the
            // overlay viewport scrolls (acceptable — vp.rows ≤ 13 is extreme).
            // Brief 2 — the filter row ABOVE the list (painted when
            // filterStr is non-empty) is popover chrome that chromeRows
            // doesn't count (it's computed before pushField runs). Subtract
            // one so a 1-char filter doesn't push the overflow indicator off
            // screen on terminals that were previously right at the chrome
            // budget edge.
            const filterChromeRows = filterStr ? 1 : 0;
            const availableRows = (vp.rows || 24) - 4 - chromeRows - 1 - filterChromeRows;
            const budget = Math.max(3, availableRows);
            const total = view.items.length;
            // v0.6.47 — shared slice math with the action palette via
            // leaves/render/window-slice. Pre-fix this block inlined the
            // same math; the leaf extraction is a pure refactor on this
            // side (reference implementation preserved byte-for-byte).
            // The action palette gets the same scroll behavior without a
            // second copy to drift.
            const win = windowSlice({ idx: picking.idx, total, budget });
            const willOverflow = win.overflow;
            const sliceStart = win.start;
            const sliceEnd = win.end;
            for (let i = sliceStart; i < sliceEnd; i++) {
              // R2C-SMELL1 — `labels[i]` was truthy-checked, which treated an
              // explicit empty-string label as "no label" and fell back to the
              // raw item. An author passing `labels: ['', 'Beta']` wanted blank
              // for the first row, not the item. Compare against null|undefined
              // instead so the empty string survives.
              const label = (view.labels && view.labels[i] != null) ? view.labels[i] : view.items[i];
              if (i === picking.idx) pickingLineIdx = rows.length;
              const painted = i === picking.idx
                ? `[reverse]${esc(label)}[/]`
                : esc(label);
              rows.push(`${' '.repeat(leftW)}${painted}`);
            }
            if (willOverflow) {
              // "N of M" + the `+` suffix means "the fn also returned MORE
              // than M that we had already dropped at the cap" (R1B-BUG1's
              // original `[+more…]` cue, merged into this one line).
              const shown = sliceEnd - sliceStart;
              // Brief 2 — the `+` cue counts the FETCH-cap truncation on the
              // raw list; a filter narrowing an already-truncated list keeps
              // the `+` suffix so the user knows the fetch dropped candidates
              // that MIGHT have matched. The "N of M" tells them how many of
              // their filtered view they're seeing right now.
              const totalLabel = `${total}${c.truncated ? '+' : ''}`;
              rows.push(`${' '.repeat(leftW)}[dim]\\[${shown} of ${totalLabel} — up/down to scroll][/]`);
            } else if (c.truncated) {
              // R1B-BUG1: choices runtime caps items at MAX_CHOICES; the overlay
              // tells the user the fn's return was longer than the cap so they
              // know what they're not seeing. Escape the leading `[` so Rich
              // doesn't try to parse `[+more…]` as a markup tag.
              rows.push(`${' '.repeat(leftW)}[dim]\\[+more…][/]`);
            }
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
  // (Slice-1 pre-release review round 4 Fork 1 S3.) `stillMissing` was
  // hoisted up for the chrome-budget calc — reuse it here, don't recompute.
  rows.push('');
  if (stillMissing.length) {
    rows.push(`[warning]required inputs still missing: ${esc(stillMissing.join(', '))}[/]`);
  }
  // v0.6.44 Brief 3 — compact preview footer. One line: port count +
  // sensitive count + a truncated script teaser. Always-on so the
  // operator sees SOMETHING about what will run before pressing Enter;
  // the full preview block lives on the confirm overlay (if the action
  // has `confirm:`). Values are read from LIVE field state, not
  // defaults — the user may be mid-edit; the preview must reflect
  // what Enter will actually submit. Sensitive mask comes from the
  // same shared leaf as the confirm preview, so a port can't be
  // masked in one surface and leak in the other.
  {
    const { formatCompactFooter } = require('../leaves/ports/submit-preview');
    const pa = f.pendingAction;
    const act = pa && pa.action;
    const portsIn = (act && act.ports && act.ports.in) || {};
    const boundPorts = [];
    let variadic = null;
    for (const field of f.fields) {
      const decl = portsIn[field.port];
      if (decl && decl.variadic === true) {
        // Compact footer summary only tallies the port count +
        // sensitive count — never the ITEMS. Pass decl only (same as
        // scalar ports below) so a secret can't leak into the summary
        // line even by accident.
        variadic = { name: field.port, decl };
        continue;
      }
      // Pass only `name` + `decl` — the compact footer formatter
      // (`js/leaves/ports/submit-preview.formatCompactFooter`) reads
      // only these two for its summary (count + sensitive count +
      // script teaser). Passing field.text here would be a dead carry
      // and (worse) could obscure the "the summary never carries a
      // port VALUE" invariant pinned by test-submit-preview §5.
      boundPorts.push({ name: field.port, decl });
    }
    rows.push(formatCompactFooter({
      script: (act && act.script) || '',
      boundPorts, variadic,
    }));
  }

  // Help line adapts to the mode: the picker gets its own keys; a focused
  // computed-choices field advertises `[space] choices` so the affordance is
  // discoverable without reading docs.
  if (picking) {
    // R2B-SMELL8 — "close popover" disambiguates against the next-up Esc,
    // which closes the form. Brief 2 — show the filter affordance so users
    // discover type-to-filter without reading docs; the Esc hint reads
    // "clear/close" so the two-step (clear filter first, then close) is
    // discoverable too.
    const filterActive = typeof picking.filter === 'string' && picking.filter.length > 0;
    const escHint = filterActive ? '\\[esc] clear filter' : '\\[esc] close popover';
    rows.push(`[dim]\\[up/down] move   \\[type] filter   \\[enter] pick   ${escHint}[/]`);
  } else {
    const focused = f.fields[f.focusIdx];
    // Pre-release review (code fork) — same drift class as Brief 1: this hint
    // site was missed when `hasChoices` was centralized. Read the single-source
    // flag so a literal-only focused field advertises `[space] choices` too.
    // The flag is stamped by _normalize via js/leaves/ports/has-choices.js.
    const spaceHint = (focused && focused.hasChoices) ? '   \\[space] choices' : '';
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
  // When the popover is open, prefer the HIGHLIGHTED-choice row as the scroll
  // anchor so a long list stays navigable; otherwise fall back to the focused
  // field row (slice-1 behavior).
  const menuH = Math.min(rows.length + 2, Math.max(0, vp.rows - 2));
  const innerH = Math.max(1, menuH - 2);
  const anchorLineIdx = pickingLineIdx >= 0 ? pickingLineIdx : focusLineIdx;
  const scrollOffset = anchorLineIdx < 0 ? 0 : _scrollFor(anchorLineIdx, rows.length, innerH);

  renderOverlay({ lines: rows, title, maxWidth: MAX_WIDTH, scrollOffset });
}

module.exports = { renderFabricFormOverlay, _scrollFor };
