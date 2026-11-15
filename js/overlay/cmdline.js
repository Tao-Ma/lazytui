/**
 * Cmdline overlay — `:` modal prompt + match dropdown.
 *
 * The render half of dispatch/control/cmdline.js (which keeps the registry
 * build / scoring / run-closure stash). Lives under overlay/ for
 * symmetry with copy.js / register-popup.js / menu.js — dispatch
 * modules don't paint; overlays do. Pre-v0.6.x the render lived in
 * dispatch/control/cmdline.js, which forced render/geometry.js to require
 * dispatch/ — a layering inversion.
 *
 * Reads model.modal.cmdline (text, sel, matches projection — all
 * model-resident; the closures-only `_full` array stays in
 * dispatch/control/cmdline.js since it's effectful).
 */
'use strict';

const { getModel } = require('../model/store');
const { richToAnsi, RESET, visibleLen, esc } = require('../leaves/text/ansi');
const { fieldText } = require('../leaves/text/printable');
const { fieldWindow } = require('../leaves/text/field-window');
const { theme } = require('../leaves/infra/themes');
const { renderPanel, viewportDims, writeOut, publishBox } = require('../leaves/render/draw');
const { compositeRow } = require('../leaves/render/row-compositor');
const { DROPDOWN_VIEWPORT: MAX_DROPDOWN } = require('../leaves/text/cmdline-split');

// (Residue tracking retired — overlay-compositor end-of-Release-2
// cleanup; the dropdown composites into newRows and cell-diff handles
// the shrink/close/vanish from the natural row delta.)

/** Format one match as a single rich-markup line for the dropdown.
 *  "display ─ desc" with no inner style nesting (PRINCIPLES.md §8 —
 *  the caller wraps in [reverse] for the selection highlight; the
 *  panel renderer adds the reset before the right border). YAML
 *  `desc: |` block scalars get whitespace-collapsed to a single line. */
function _oneLine(s) { return s.replace(/\s+/g, ' ').trim(); }
function _formatMatchLine(match) {
  const display = esc(_oneLine(match.display));
  if (match.desc) return `${display} ─ ${esc(_oneLine(match.desc))}`;
  return display;
}

// Overlay-compositor end-of-Release-2: cmdline is MIXED-PATH. The
// dropdown composites into newRows via `row-compositor.compositeRow`
// (cell-diff handles shrink/close/vanish from the natural row delta —
// no sig tracker or residue tracker needed). The PROMPT ROW sits at
// row `ROWS` (the footer row, OUTSIDE newRows which spans only availH
// rows) and the cursor position is terminal state (not a cell to
// composite), so both stay as a direct writeOut. The pre-cleanup
// stdout fallback for the dropdown is retired.
function renderCmdline(newRows, cols) {
  if (!getModel().modes.cmdMode) return;
  // Buffer state lives on the model (folded onto update); the render-safe
  // match list (display/desc/kind) is enough to paint — run closures
  // stay module-held in dispatch/control/cmdline.js#_full.
  const { text: _text, sel: _sel, matches: _matches, scroll: _scroll = 0 } = getModel().modal.cmdline;
  const { cols: COLS, rows: ROWS } = viewportDims();
  const t = theme();

  // Visible window into the (possibly larger) match list. `_scroll` is
  // the lowest match-index visible at the BOTTOM of the dropdown; the
  // reducer (runtime.update#cmdline_nav) advances it as sel walks past
  // the viewport's upper bound. MAX_DROPDOWN is shared with the reducer
  // (leaves/cmdline-split.DROPDOWN_VIEWPORT) so they can't drift apart.
  const k = Math.min(_matches.length - _scroll, MAX_DROPDOWN);

  // Match dropdown — bordered panel just above the prompt row. The
  // panel chrome (border + title + count badge) reuses renderPanel so
  // the cmdline visually belongs to lazytui rather than overlaying it
  // with bare ANSI. Width scales with the terminal: full width minus
  // a 2-cell margin on each side, bottoming out at 40 so it stays
  // usable on narrow terminals.
  const panelH = k > 0 ? k + 2 : 0;
  const panelW = Math.max(40, COLS - 4);

  // Composite the dropdown rows into newRows. Cell-diff handles both
  // the leading paint AND the clean-up on shrink/close from the
  // natural row delta.
  if (k > 0) {
    const lines = [];
    // Hit map (docs/mouse-hit-map.md): rows are REVERSED (best match nearest the
    // prompt), so line i is match `_scroll + k - 1 - i`; a click selects THAT
    // match (cmdline_nav's absolute `to`). Selection only — Enter still submits
    // the typed text, as with ↑/↓.
    const lineTargets = [];
    for (let i = 0; i < k; i++) {
      const matchIdx = _scroll + k - 1 - i;
      const m = _matches[matchIdx];
      const label = _formatMatchLine(m);
      lineTargets[i] = { press: { msg: { type: 'cmdline_nav', to: matchIdx } } };
      lines.push(matchIdx === _sel ? `[${t.selected}]  ${label}` : `  ${label}`);
    }
    const content = renderPanel({
      width: panelW, height: panelH, lines,
      title: 'Commands', focused: true,
      count: [_sel + 1, _matches.length],
    });
    const offY = Math.max(0, ROWS - panelH - 1);
    const offX = Math.max(0, Math.floor((COLS - panelW) / 2));
    const panelLines = content.split('\n');
    for (let i = 0; i < panelLines.length; i++) {
      compositeRow(newRows, cols || COLS, panelLines[i], offX, offY + i, panelW);
    }
    // Own box (not renderOverlay) → publish through the shared helper. The wheel
    // sends the ↑/↓ keys, so the reversed visual order is the key handler's job.
    publishBox({ x: offX, y: offY, w: panelW, h: panelH, lines, lineTargets,
                 box: { 'wheel-up': { key: 'up' }, 'wheel-down': { key: 'down' } } });
  }

  // Prompt row sits at row ROWS (the footer row, outside newRows which
  // spans only availH rows), so it stays as a direct writeOut. Rich-style
  // markup mirrors renderFooter() so the cmdline blends with the chrome
  // it covers.
  // The typed text is TEXT: escaped, so `a[0].txt` shows as typed instead of
  // being read as a markup tag (it showed `a.txt`, the cursor past its end).
  // Windowed to the row (_promptView, shared with cmdlineCursor): the row was
  // never cut, so a command wider than the screen ran past the last column of
  // the LAST row — the host wrapped it and the whole screen scrolled up.
  const { shown } = _promptView(_text, COLS);
  const prompt = ` :${shown}`;
  const padded = prompt + ' '.repeat(Math.max(0, COLS - visibleLen(prompt)));
  const buf = `\x1b[${ROWS};1H` + richToAnsi(`[${t.footer}]${padded}[/]`) + RESET;
  // The cursor's position is cmdlineCursor's — paint's terminal-surface pass
  // places it LAST, on every frame and every PTY fast-path repaint (writing it
  // here, mid-frame, the main frame's diff moved it on: it ended in the
  // dropdown whenever the dropdown changed).

  // Through draw's injected writer → paint's depth funnel (P3) — never raw
  // stdout: this overlay's rows carry theme hex since the truecolor arc.
  writeOut(buf);
}

/** Reset module-local render state. Called from dispatch/cmdline#clear
 *  on cmdline_clear (submit/cancel) so the next cmd-mode open doesn't
 *  inherit residue-tracker state from the previous session. */
// Overlay-compositor R3 descriptor. zIndex=110. cmdline is a MIXED
// path: the dropdown panel composites into newRows (R2 Phase 2.b #3),
// but the prompt row + cursor stay direct `writeOut` because they sit
// on the footer row — OUTSIDE newRows. The compositor sees only the
// newRows-side; the writeOut-side still runs inside the render fn
// synchronously, as before (no behavior change).
function registerSelf(compositor) {
  compositor.register({
    id: 'cmdline',
    isActive: (m) => !!(m && m.modes && m.modes.cmdMode),
    render: (m, newRows, cols) => renderCmdline(newRows, cols),
    modal: true,
    zIndex: 110,
    // Typed command text → an outside click (incl. on the prompt row) is
    // swallowed, never discards the line (docs/mouse-hit-map.md §Backdrop).
    mouse: { outside: 'swallow' },
  });
}

/** Where the hardware cursor goes in cmd mode: the end of the typed text on the
 *  prompt row — column 1 (leading space) + ':' + the WIDTH of the text the row
 *  shows (columns, not UTF-16 units; `…` + the tail once it is scrolled —
 *  _promptView). 1-based { row, col }; null outside cmd mode. paint's
 *  terminal-surface pass emits it as the last move of every frame and of every
 *  PTY fast-path repaint. */
function cmdlineCursor(model) {
  if (!model.modes.cmdMode) return null;
  const { cols, rows } = viewportDims();
  return { row: rows, col: 3 + _promptView(model.modal.cmdline.text, cols).caretCol };
}

/** The prompt row's text and the cursor's place in it — ONE derivation, so
 *  what renderCmdline paints and where cmdlineCursor puts the cursor cannot
 *  disagree. The text after ` :` is a field window (leaves/text/field-window)
 *  over the text as a field shows it (printable.fieldText: a tab or line break
 *  is a space, control sequences are gone — whatever path set it; typed and
 *  pasted text is already that), scrolled to keep its END and the cursor cell
 *  on the row: `cols - 2` columns, `…` first when the start is cut. `shown` is
 *  markup (esc'd); `caretCol` is 0-based from the text's first column. */
function _promptView(text, cols) {
  const t = fieldText(text || '');
  const { clipped, before, caretCol } = fieldWindow(t, t.length, (cols | 0) - 2);
  return { shown: (clipped ? '…' : '') + esc(before), caretCol };
}

module.exports = { renderCmdline, registerSelf, cmdlineCursor };
