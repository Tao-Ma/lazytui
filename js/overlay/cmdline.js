/**
 * Cmdline overlay — `:` modal prompt + match dropdown.
 *
 * The render half of dispatch/cmdline.js (which keeps the registry
 * build / scoring / run-closure stash). Lives under overlay/ for
 * symmetry with copy.js / register-popup.js / menu.js — dispatch
 * modules don't paint; overlays do. Pre-v0.6.x the render lived in
 * dispatch/cmdline.js, which forced render/layout.js to require
 * dispatch/ — a layering inversion.
 *
 * Reads model.modal.cmdline (text, sel, matches projection — all
 * model-resident; the closures-only `_full` array stays in
 * dispatch/cmdline.js since it's effectful).
 */
'use strict';

const { getModel } = require('../app/runtime');
const { richToAnsi, RESET, visibleLen, esc } = require('../io/ansi');
const { cols, rows, stdout } = require('../io/term');
const { theme } = require('../render/themes');
const { renderPanel } = require('../render/panel');

const MAX_DROPDOWN = 8;

// Panel height (including borders) painted by the previous render.
// When the new render is shorter (user typed more chars, match set
// shrank), we invalidate the diff cache for the uncovered rows so the
// next layout.render repaints the underlying panels there. Without
// this, residue from the taller previous frame sticks until the
// overlay closes.
let _lastPanelH = 0;

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

function renderCmdline() {
  if (!getModel().modes.cmdMode) return;
  // Buffer state lives on the model (folded onto update); the render-safe
  // match list (display/desc/kind) is enough to paint — run closures
  // stay module-held in dispatch/cmdline.js#_full.
  const { text: _text, sel: _sel, matches: _matches, scroll: _scroll = 0 } = getModel().modal.cmdline;
  const COLS = cols();
  const ROWS = rows();
  const t = theme();

  // Visible window into the (possibly larger) match list. `_scroll` is
  // the lowest match-index visible at the BOTTOM of the dropdown; the
  // reducer (runtime.update#cmdline_nav) advances it as sel walks past
  // the viewport's upper bound. MAX_DROPDOWN here must stay in sync
  // with CMDLINE_VW in app/runtime.js.
  const k = Math.min(_matches.length - _scroll, MAX_DROPDOWN);

  // Build one string with embedded cursor moves — dropdown panel +
  // prompt + cursor positioning — and write once. Per-line stdout.write
  // was a syscall per row; on slow TTYs that could tear under load.
  let buf = '';

  // Match dropdown — bordered panel just above the prompt row. The
  // panel chrome (border + title + count badge) reuses renderPanel so
  // the cmdline visually belongs to lazytui rather than overlaying it
  // with bare ANSI. Width scales with the terminal: full width minus
  // a 2-cell margin on each side, bottoming out at 40 so it stays
  // usable on narrow terminals.
  const panelH = k > 0 ? k + 2 : 0;
  const panelW = Math.max(40, COLS - 4);

  // Invalidate the diff cache for rows the previous render painted
  // but this one won't. The blanking writes here make THIS frame clean;
  // the invalidate makes the NEXT render repaint from the underlying
  // panels via the diff cache.
  if (panelH < _lastPanelH) {
    // T25 / R17 — clamp oldTop to >= 0. A resize that shrinks ROWS
    // below the stashed _lastPanelH makes oldTop negative; the blanking
    // loop would then write `\x1b[<negative>;1H` cursor moves, which
    // terminals clamp to row 1 — cosmetic flicker but unintended.
    const oldTop = Math.max(0, ROWS - _lastPanelH - 1);
    const newTop = Math.max(0, ROWS - panelH - 1);
    require('../render/layout').invalidateRows(oldTop, newTop);
    for (let y = oldTop; y < newTop; y++) {
      buf += `\x1b[${y + 1};1H\x1b[K`;
    }
  }
  _lastPanelH = panelH;

  if (k > 0) {
    const lines = [];
    // Order: top of panel = worst match, bottom of panel = best match
    // (sel index 0), so the user's eye lands on the selected best-
    // match nearest the prompt cursor.
    for (let i = 0; i < k; i++) {
      const matchIdx = _scroll + k - 1 - i;
      const m = _matches[matchIdx];
      const label = _formatMatchLine(m);
      lines.push(matchIdx === _sel ? `[reverse]  ${label}` : `  ${label}`);
    }
    const content = renderPanel({
      width: panelW, height: panelH, lines,
      title: 'Commands', focused: true,
      count: [_sel + 1, _matches.length],
    });
    const offY = Math.max(0, ROWS - panelH - 1);  // just above prompt row
    const offX = Math.max(0, Math.floor((COLS - panelW) / 2));
    const panelLines = content.split('\n');
    for (let i = 0; i < panelLines.length; i++) {
      buf += `\x1b[${offY + i + 1};${offX + 1}H` + richToAnsi(panelLines[i]) + RESET;
    }
  }

  // Prompt row (replaces footer). Rich-style markup mirrors
  // renderFooter() so the cmdline blends with the chrome it covers.
  const prompt = ` :${_text}`;
  const padded = prompt + ' '.repeat(Math.max(0, COLS - visibleLen(prompt)));
  buf += `\x1b[${ROWS};1H` + richToAnsi(`[${t.footer}]${padded}[/]`) + RESET;

  // Cursor at end of typed text. column = 1 (leading space) + ':' + _text.
  // Visibility is derived in layout.render() — only the *position* is
  // set here (and only while cmd mode is active).
  const cursorCol = 2 + 1 + _text.length;
  buf += `\x1b[${ROWS};${cursorCol}H`;

  stdout.write(buf);
}

/** Reset module-local render state. Called from dispatch/cmdline#clear
 *  on cmdline_clear (submit/cancel) so the next cmd-mode open doesn't
 *  inherit residue-tracker state from the previous session. */
function _resetRenderState() { _lastPanelH = 0; }

module.exports = { renderCmdline, _resetRenderState };
