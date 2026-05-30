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

const { allPanels } = require('./state');
const { getModel } = require('./runtime');
const { richToAnsi, RESET, visibleLen, esc } = require('./ansi');
const { cols, rows, stdout } = require('./term');
const { theme } = require('./themes');
const { renderPanel } = require('./panel');
const { getCommands, getItems: apiGetItems, dispatchMsg, wrap } = require('./components/api');

const MAX_DROPDOWN = 8;

// Tracks the panel height (including borders) painted by the previous
// renderCmdline. When the new render is shorter (e.g., the user typed
// more chars and the match set shrank), we invalidate the diff cache
// for the now-uncovered rows so layout.render repaints the underlying
// panels there. Without this, the previous-render residue sticks
// around until the user types something that grows the panel again
// or until the overlay closes entirely.
let _lastPanelH = 0;

// The matched registry entries for the current buffer — WITH their run
// closures. Folded onto the update spine: the text/sel/render-safe match
// list live on model.modal.cmdline (the reducer owns them); only the run
// closures stay module-held here (they're effectful — like copy.js's
// content thunks — and can't enter the pure reducer). Parallel-indexed to
// model.modal.cmdline.matches. cmdline_run invokes one by index.
let _full = [];

// --- Rebuild / run / clear (the effect side, driven by Cmds) ---

/**
 * Rebuild the match registry from `text` (reads the plugin facade via
 * buildRegistry(S) — an effect, so the reducer can't do it). Stashes the
 * full entries (with run closures) module-side and returns the render-safe
 * projection ({display, desc, kind}) for the reducer to store on the model.
 */
function rebuild(text) {
  _full = rebuildMatches(text);
  return _full.map(e => ({ display: e.display, desc: e.desc, kind: e.kind }));
}

/** Run the module-held match at `sel` (the cmdline_run Cmd). Plugin commands
 *  now read app-global state via `getModel()` — no S threading. */
function runAt(sel, args) {
  const match = _full[sel];
  if (match) Promise.resolve(match.run(args)).catch(e => console.error('[cmd]', e.message));
}

/** Drop the held registry + reset the render residue tracker (cmdline_clear,
 *  emitted on submit/cancel). */
function clear() {
  _full = [];
  _lastPanelH = 0;
}

// --- Registry ---
//
// The registry is rebuilt on every keystroke. It's small (panels +
// current-group actions + plugin commands ≈ tens of entries), so cost
// is negligible and we don't need an invalidation protocol.

/**
 * Split the cmdline buffer at the first whitespace into the action-name
 * query (used for fuzzy matching) and the positional args (passed to the
 * matched entry's run(args)). Whitespace-only split — no shell-style
 * quoting in v1; users wanting "one arg with spaces" can collapse via
 * the script body or wait for a follow-up.
 */
function splitQuery(text) {
  const m = text.match(/^(\S*)\s+(.*)$/);
  if (!m) return { query: text, args: [] };
  const rest = m[2].trim();
  return { query: m[1], args: rest ? rest.split(/\s+/) : [] };
}

function buildRegistry() {
  const reg = [];

  // Panels — focus the panel via the focus_set Msg (handled by layout's
  // update; routed through dispatchMsg fan-out since Phase 1c).
  for (const p of allPanels()) {
    reg.push({
      name: p.title.toLowerCase(),
      display: p.title,
      desc: `Focus the ${p.title} panel`,
      kind: 'panel',
      run: () => {
        dispatchMsg(wrap('layout', { type: 'focus_set', focus: p.type }));
      },
    });
  }

  // Current group's actions — run on Enter. Reuse api.getItems so the
  // active filter applies (so a filtered Actions panel shows fewer
  // candidates here too — consistent with what the user sees).
  const actions = apiGetItems('actions');
  for (const [key, action] of actions) {
    reg.push({
      name: action.label.toLowerCase(),
      display: action.label,
      desc: action.desc || `Run ${key}`,
      kind: 'action',
      run: (args) => { require('./actions').runAction(getModel(), key, action, args); },
    });
  }

  // Plugin / Component commands (static + dynamic), plus the framework
  // defaults + dynamic verbs (`quit`, `refresh`, `help`, `theme <name>`,
  // `focus <panel>`, `design`) — all collected by components/api.js#getCommands.
  for (const cmd of getCommands()) {
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
  const reg = buildRegistry();
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
  if (!getModel().modes.cmdMode) return;
  // Buffer state now lives on the model (folded onto update); the render-safe
  // match list (display/desc/kind) is enough to paint — the run closures it
  // mirrors stay module-held in _full.
  const { text: _text, sel: _sel, matches: _matches } = getModel().modal.cmdline;
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
 *
 * Whitespace in display/desc is collapsed to single spaces. YAML
 * `desc: |` block scalars produce multi-line strings; the embedded
 * newlines bypass renderPanel's truncate (visibleLen counts \n as
 * width 1 but the terminal honors it as a real line break, so the
 * right border ends up on its own row).
 */
function oneLine(s) { return s.replace(/\s+/g, ' ').trim(); }

function formatMatchLine(match) {
  const display = esc(oneLine(match.display));
  if (match.desc) return `${display} ─ ${esc(oneLine(match.desc))}`;
  return display;
}

/**
 * Run a cmdline command string programmatically (no UI): "logs",
 * "show-hidden toggle", etc. Resolves the leading word against the
 * same registry the `:` prompt uses (exact name, then prefix), passing
 * the rest as args. Returns the command's result, or false if no
 * command matched. Used by the YAML `keys:` reader to bind leader
 * chords to commands.
 */
function runCommandString(str) {
  const parts = String(str).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  const name = parts[0].toLowerCase();
  const args = parts.slice(1);
  const reg = buildRegistry();
  // Exact name match only. A declared `command:` binding names a
  // specific command; prefix/fuzzy matching (which the interactive `:`
  // prompt uses) would silently run a different command on a typo or
  // when an unrelated entry happens to share the prefix — and the
  // resolution would vary by group since the registry is state-derived.
  const entry = reg.find(e => e.name === name);
  if (!entry) return false;
  return entry.run(args);
}

module.exports = {
  rebuild, runAt, clear, renderCmdline,
  runCommandString,
  // Test-only export — buffer parsing reused by test-cmdline-args.js.
  _splitQuery: splitQuery,
};
