/**
 * `:` command mode — vim/k9s-style modeline that resolves any panel,
 * action, or plugin-supplied command from a fuzzy-matched name.
 *
 * Spec: CMDMODE.md.
 *
 * Pure state + paint, like menu.js / copy.js: callers (dispatch.js) own
 * render() invocation so layout.js can require this module without forming
 * a cycle. Render is direct stdout (positions itself at the bottom of the
 * screen) — main column diff cache is untouched.
 */
'use strict';

const { S, allPanels } = require('./state');
const { richToAnsi, RESET, visibleLen, esc } = require('./ansi');
const { cols, rows, stdout } = require('./term');
const { theme } = require('./themes');
const { renderPanel } = require('./panel');
const { getCommands, getItems: apiGetItems } = require('./plugins/api');

const MAX_DROPDOWN = 8;

// Tracks the panel height (including borders) painted by the previous
// renderCmdline. When the new render is shorter (e.g., the user typed
// more chars and the match set shrank), we invalidate the diff cache
// for the now-uncovered rows so layout.render repaints the underlying
// panels there. Without this, the previous-render residue sticks
// around until the user types something that grows the panel again
// or until the overlay closes entirely.
let _lastPanelH = 0;

// Module-private mode state. S.cmdMode (the flag) stays on S so the
// render conductor can detect overlay-active. The buffers (typed
// text, selected match, cached match list) are transient per-session
// and live here.
let _text = '';
let _sel = 0;
let _matches = [];

// --- Mode toggles ---

function enterCmdline() {
  S.cmdMode = true;
  _text = '';
  _sel = 0;
  _matches = rebuildMatches('');
  _lastPanelH = 0;
}

function exitCmdline() {
  S.cmdMode = false;
  _text = '';
  _sel = 0;
  _matches = [];
  _lastPanelH = 0;
  // Cursor visibility is derived in layout.render() from S.cmdMode +
  // S.terminalMode — no need to emit hideCursor here. Overlay-close
  // detection in layout.render forces a full repaint, which wipes
  // any cmdline-panel residue.
}

// --- Registry ---
//
// The registry is rebuilt on every keystroke. It's small (panels +
// current-group actions + plugin commands ≈ tens of entries), so cost
// is negligible and we don't need an invalidation protocol.

/**
 * Split the cmdline buffer at the first whitespace into the action-name
 * query (used for fuzzy matching) and the positional args (passed to the
 * matched entry's run(args, S)). Whitespace-only split — no shell-style
 * quoting in v1; users wanting "one arg with spaces" can collapse via
 * the script body or wait for a follow-up.
 */
function splitQuery(text) {
  const m = text.match(/^(\S*)\s+(.*)$/);
  if (!m) return { query: text, args: [] };
  const rest = m[2].trim();
  return { query: m[1], args: rest ? rest.split(/\s+/) : [] };
}

function buildRegistry(state) {
  const reg = [];

  // Panels — focus the panel.
  for (const p of allPanels()) {
    reg.push({
      name: p.title.toLowerCase(),
      display: p.title,
      desc: `Focus the ${p.title} panel`,
      kind: 'panel',
      run: () => { state.focus = p.type; },
    });
  }

  // Current group's actions — run on Enter. Reuse api.getItems so the
  // active filter applies (so a filtered Actions panel shows fewer
  // candidates here too — consistent with what the user sees).
  const actions = apiGetItems('actions', state);
  for (const [key, action] of actions) {
    reg.push({
      name: action.label.toLowerCase(),
      display: action.label,
      desc: action.desc || `Run ${key}`,
      kind: 'action',
      run: (args) => { require('./actions').runAction(key, action, args); },
    });
  }

  // Plugin commands (static + dynamic). Built-in `theme <name>`,
  // `focus <panel>`, `quit`, `refresh`, `help` come through here from
  // plugins/core.js.
  for (const cmd of getCommands(state)) {
    reg.push({
      name: cmd.name.toLowerCase(),
      display: cmd.name,
      desc: cmd.desc || '',
      kind: 'command',
      run: cmd.run,
    });
  }

  return reg;
}

// --- Fuzzy match ---
//
// Three tiers, descending. A shorter name wins ties — typing "up" should
// match "up" before "upgrade-system".
//
//   Tier 1 (1000+):  name starts with query
//   Tier 2 (500+):   name contains query
//   Tier 3 (>0):     subsequence (every query char in order, gaps OK)

function score(query, name) {
  if (!query) return 1; // empty query — every entry is a candidate
  const lenBonus = -Math.min(name.length, 100) * 0.1;
  if (name.startsWith(query))   return 1000 + lenBonus;
  const idx = name.indexOf(query);
  if (idx >= 0)                 return 500 - idx + lenBonus;
  // Subsequence
  let qi = 0;
  for (let i = 0; i < name.length && qi < query.length; i++) {
    if (name[i] === query[qi]) qi++;
  }
  if (qi !== query.length) return -1;
  return 100 + lenBonus;
}

function rebuildMatches(text) {
  const reg = buildRegistry(S);
  // Fuzzy-match against the action-name part only — args (anything past
  // the first whitespace) are operands, not name characters.
  const { query } = splitQuery(text);
  const q = query.toLowerCase().trim();
  const scored = [];
  for (const entry of reg) {
    const s = score(q, entry.name);
    if (s > 0) scored.push({ entry, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_DROPDOWN).map(s => s.entry);
}

// --- Key handler ---

function handleCmdlineKey(key, seq) {
  if (key === 'escape') { exitCmdline(); return; }
  if (key === 'return') {
    const match = _matches[_sel];
    const { args } = splitQuery(_text);
    exitCmdline();
    // Honor the documented run(args, S) contract from CMDMODE.md. Existing
    // core commands captured S from closure scope and worked despite this
    // being missing; plugin commands like docker's :stop / :inspect read S
    // off the parameter and crashed without it.
    if (match) Promise.resolve(match.run(args, S)).catch(e => console.error('[cmd]', e.message));
    return;
  }
  if (key === 'up' || (seq === '\x1b[A')) {
    if (_sel < _matches.length - 1) _sel++;
    return;
  }
  if (key === 'down' || (seq === '\x1b[B')) {
    if (_sel > 0) _sel--;
    return;
  }
  if (seq === '\t') { // Tab — accept top match into buffer (refine further)
    const top = _matches[0];
    if (top) {
      // Keep any args the user already typed past the matched name.
      const { args } = splitQuery(_text);
      _text = top.display.toLowerCase() + (args.length ? ' ' + args.join(' ') : '');
      _sel = 0;
      _matches = rebuildMatches(_text);
    }
    return;
  }
  if (seq === '\x7f') { // Backspace
    _text = _text.slice(0, -1);
    _sel = 0;
    _matches = rebuildMatches(_text);
    return;
  }
  if (seq && seq.length === 1 && seq.charCodeAt(0) >= 32 && seq.charCodeAt(0) < 127) {
    _text += seq;
    _sel = 0;
    _matches = rebuildMatches(_text);
  }
}

// --- Render ---
//
// Layout:
//   row N-K   match[K-1]                  (worst match shown)
//   ...
//   row N-1   match[0]  ← selected (best match, closest to cursor)
//   row N     :typed_text_                ← prompt (replaces footer)
//
// Selected row uses [reverse] (no inner markup — see PRINCIPLES §8).
// Each row is padded to full screen width so we don't have to wipe
// background separately. _wasOverlayActive in layout.render() handles
// the residue wipe when cmd mode closes.

function renderCmdline() {
  if (!S.cmdMode) return;
  const COLS = cols();
  const ROWS = rows();
  const t = theme();

  const k = Math.min(_matches.length, MAX_DROPDOWN);

  // Build one string with embedded cursor moves — dropdown panel + prompt
  // + cursor positioning — and write once. Per-line stdout.write was a
  // syscall per row; on slow TTYs that could tear under load.
  let buf = '';

  // Match dropdown — bordered panel just above the prompt row. The
  // panel chrome (border + title + count badge) reuses renderPanel so
  // the cmdline visually belongs to lazytui rather than overlaying it
  // with bare ANSI. The previous render painted raw `\x1b[2m` rows
  // straight onto whatever panels sat underneath, which read as visual
  // bleed-through with no separator.
  //
  // Width scales with the terminal: full width minus a 2-cell margin
  // on each side, bottoming out at 40 so it stays usable on narrow
  // terminals. Centered horizontally.
  const panelH = k > 0 ? k + 2 : 0;
  const panelW = Math.max(40, COLS - 4);

  // Invalidate the diff cache for any rows that the previous render
  // painted but this one won't. Without this the residue from the
  // taller previous panel sticks around until the overlay closes.
  // Done BEFORE we emit the new paint so the next layout.render gets
  // dirty markers for those rows — but since renderCmdline runs at
  // the tail of THIS render(), the invalidation actually takes effect
  // on the NEXT render. To make THIS frame clean, also blank the
  // affected rows directly below (the underlying panel will redraw
  // on the next keystroke).
  if (panelH < _lastPanelH) {
    const oldTop = ROWS - _lastPanelH - 1;
    const newTop = ROWS - panelH - 1;
    require('./layout').invalidateRows(oldTop, newTop);
    // Blank the rows now so this frame doesn't show residue. Next
    // render repaints them from the underlying panels via the diff
    // cache we just invalidated.
    for (let y = oldTop; y < newTop; y++) {
      buf += `\x1b[${y + 1};1H\x1b[K`;
    }
  }
  _lastPanelH = panelH;

  if (k > 0) {
    const lines = [];
    // Order in the lines array: top of panel = worst match, bottom
    // of panel = best match (sel index 0), so the user's eye lands
    // on the selected best-match nearest the prompt cursor.
    for (let i = 0; i < k; i++) {
      const matchIdx = k - 1 - i;
      const m = _matches[matchIdx];
      const label = formatMatchLine(m);
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

  // Prompt row (replaces footer). Rich-style markup mirrors renderFooter()
  // so the cmdline blends with the chrome it's temporarily covering.
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

/**
 * Format one match as a single rich-markup line for the dropdown.
 * "  display ─ desc" without inner style nesting — the caller wraps
 * the entire row in [reverse] for selection highlight, and the
 * panel renderer adds a reset before the right border (PRINCIPLES.md
 * §8). renderPanel handles width-based truncation.
 */
function formatMatchLine(match) {
  if (match.desc) return `${esc(match.display)} ─ ${esc(match.desc)}`;
  return esc(match.display);
}

module.exports = {
  enterCmdline, exitCmdline, handleCmdlineKey, renderCmdline,
  // Test-only export — buffer parsing reused by test-cmdline-args.js.
  _splitQuery: splitQuery,
};
