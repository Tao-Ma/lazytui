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

const { allPanels } = require('../app/state');
const { getModel } = require('../model/store');
const { esc } = require('../io/ansi');
const { getCommands, getItems: apiGetItems, dispatchMsg, wrap } = require('../panel/api');

// Render moved to overlay/cmdline.js (v0.6 layering cleanup — dispatch
// modules don't paint). This file owns: registry build, fuzzy scoring,
// run-closure stash, programmatic runCommandString.

// The matched registry entries for the current buffer — WITH their run
// closures. Folded onto the update spine: the text/sel/render-safe match
// list live on model.modal.cmdline (the reducer owns them); only the run
// closures stay module-held here (they're effectful — like copy.js's
// content thunks — and can't enter the pure reducer). Parallel-indexed to
// model.modal.cmdline.matches. cmdline_run invokes one by index.
let _full = [];

// Active preview teardown — set by previewAtSel when an entry's preview()
// returns a closure, called when the selection moves OFF that entry (or
// the user cancels). Submit drops it WITHOUT calling — the entry's run()
// will produce the committed state. Generalized: any cmdline entry can
// opt into live preview by defining `preview: () => teardownFn`; the
// framework doesn't know what the preview affects (theme, focus, view).
let _activeTeardown = null;

// --- Rebuild / run / clear (the effect side, driven by Cmds) ---

/**
 * Rebuild the match registry from `text` (reads the plugin facade via
 * buildRegistry(S) — an effect, so the reducer can't do it). Stashes the
 * full entries (with run closures) module-side and returns the render-safe
 * projection ({display, desc, kind}) for the reducer to store on the model.
 */
function rebuild(text) {
  _full = rebuildMatches(text);
  // Pass `argComplete` + `refine` through. argComplete (Tab handler):
  // entry's display IS the full cmdline replacement. refine
  // (cmdline_submit handler): Enter on this entry behaves like Tab —
  // the entry isn't terminally actionable (dirs to descend, containers
  // to refine, hints to surface). Without refine, Enter would fire a
  // no-op run() and silently close the cmdline.
  return _full.map(e => ({
    display: e.display, desc: e.desc, kind: e.kind,
    argComplete: !!e.argComplete,
    refine: !!e.refine,
  }));
}

/** Run the module-held match at `sel` (the cmdline_run Cmd). Plugin commands
 *  now read app-global state via `getModel()` — no S threading. */
function runAt(sel, args) {
  const match = _full[sel];
  if (match) Promise.resolve(match.run(args)).catch(e => console.error('[cmd]', e.message));
}

/** Drop the held registry + reset the render residue tracker (cmdline_clear,
 *  emitted on submit/cancel). Render residue lives in the overlay module
 *  post-v0.6 split; ask it to reset alongside the dispatch-side state.
 *
 *  Also drops any active preview teardown WITHOUT calling it. On submit
 *  the chosen entry's run() produces the final state, so we don't want
 *  to undo the preview; on cancel, the reducer emits
 *  `cmdline_revert_preview` BEFORE this clear, so the teardown has
 *  already fired. */
function clear() {
  _full = [];
  _activeTeardown = null;
  require('../overlay/cmdline')._resetRenderState();
}

/** Drive the live preview for the selected match. Called from the
 *  `cmdline_preview` Cmd handler on every sel change (typing-narrowed
 *  matches via cmdline_set_matches, or arrow-nav via cmdline_nav).
 *
 *  Generic protocol: an entry opts in by defining `preview: () => () => void`
 *  — preview() runs the effect, returns a teardown closure. The framework:
 *    1. Calls any active teardown (selection moving OFF the previously
 *       previewed entry, or text just cleared).
 *    2. If cmdline text is non-empty AND the new match has a `preview`,
 *       invokes it and stashes the returned teardown.
 *
 *  The text-non-empty gate prevents previewing on cmdline open — `:`
 *  opens with text='' and matches=ALL entries; sel=0 might happen to be
 *  a previewable entry, and we don't want the screen flashing without
 *  user intent. Once the user types anything, previewing kicks in. */
function previewAtSel(sel) {
  if (_activeTeardown) {
    try { _activeTeardown(); }
    catch (e) { console.error('[cmdline preview teardown]', e && e.message); }
    _activeTeardown = null;
  }
  const text = getModel().modal.cmdline.text;
  if (!text) return;
  const match = _full[sel];
  if (!match || typeof match.preview !== 'function') return;
  try {
    const teardown = match.preview();
    if (typeof teardown === 'function') _activeTeardown = teardown;
  } catch (e) { console.error('[cmdline preview]', e && e.message); }
}

/** Call any active preview's teardown. Emitted from `cmdline_cancel`
 *  before `cmdline_clear` so Esc restores whatever was previewed. */
function revertPreview() {
  if (_activeTeardown) {
    try { _activeTeardown(); }
    catch (e) { console.error('[cmdline preview teardown]', e && e.message); }
    _activeTeardown = null;
  }
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
// splitQuery moved to the zero-dep leaves/cmdline-split leaf so
// runtime.js can import the same impl without the back-cycle that
// kept the duplicate around pre-v0.6.x.
const { splitQuery } = require('../leaves/cmdline-split');

function buildRegistry() {
  const reg = [];

  // Panels — focus the panel via the focus_set Msg (handled by layout's
  // update). When two panels share a title (e.g. two file-browsers
  // named "Files"), bare title scoring is identical and the user can't
  // disambiguate. Detect title duplicates up-front; for dupes, include
  // the id in both the match name and the display.
  const panels = allPanels();
  const titleCounts = new Map();
  for (const p of panels) {
    titleCounts.set(p.title, (titleCounts.get(p.title) || 0) + 1);
  }
  for (const p of panels) {
    const dup = titleCounts.get(p.title) > 1;
    const display = dup ? `${p.title} (${p.id})` : p.title;
    reg.push({
      name: display.toLowerCase(),
      display,
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
      run: (args) => { require('./action-runner').runAction(key, action, args); },
    });
  }

  // Plugin / Component commands (static + dynamic), plus the framework
  // defaults + dynamic verbs (`quit`, `refresh`, `help`, `theme <name>`,
  // `focus <panel>`, `free-config`) — all collected by panel/api.js#getCommands.
  for (const cmd of getCommands()) {
    reg.push({
      name: cmd.name.toLowerCase(),
      display: cmd.name,
      desc: cmd.desc || '',
      kind: 'command',
      run: cmd.run,
      // argComplete is the per-command path/value completer (see
      // panel/commands.js#open). Carried through buildRegistry so
      // rebuildMatches can dispatch to it when the user types past the
      // command name.
      argComplete: typeof cmd.argComplete === 'function' ? cmd.argComplete : null,
      // preview is the optional live-preview hook (see previewAtSel) —
      // entries opt into the cursor-driven preview by exporting
      // `preview: () => () => void` (effect + teardown closure).
      preview: typeof cmd.preview === 'function' ? cmd.preview : null,
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
  const { query, args } = splitQuery(text);

  // Argument-completion path — when the user is past the command name AND
  // the matched command declares argComplete(), swap the dropdown to its
  // completion list. Triggers when there's any arg text OR the buffer
  // ends with a space (so the empty-arg case lists "all entries in dir").
  const hasArgsCtx = args.length > 0 || /\s$/.test(text);
  if (hasArgsCtx) {
    const qLower = query.toLowerCase();
    const matchedCmd = reg.find(e => e.name === qLower);
    if (matchedCmd && typeof matchedCmd.argComplete === 'function') {
      try {
        const completions = matchedCmd.argComplete(args.join(' ')) || [];
        return completions.map(c => ({ ...c, argComplete: true }));
      } catch (e) {
        console.error('[cmdline] argComplete error:', e.message);
        return [];
      }
    }
  }

  // Default path — fuzzy-match the command name. For SINGLE-WORD entries
  // (`logs`, `quit`, `help`, panel titles…) match against the leading
  // word `query` so trailing args (typed as operands, not name chars)
  // don't break the score. For MULTI-WORD entries (`theme dracula`,
  // `focus FilePanel`) match against the FULL text so typing
  // `:theme drac` narrows to `theme dracula` instead of landing on
  // shortest-name tiebreak (`theme nord`). Pre-fix the full text was
  // discarded in this branch — only the query word was matched, so
  // multi-word commands all tied on `startsWith(query)` and the user
  // had to arrow-nav to refine.
  const qQuery = query.toLowerCase().trim();
  const qFull = text.toLowerCase().trim().replace(/\s+/g, ' ');
  const scored = [];
  for (const entry of reg) {
    const q = entry.name.includes(' ') ? qFull : qQuery;
    const s = score(q, entry.name);
    if (s > 0) scored.push({ entry, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  // No cap here — the render side (overlay/cmdline) truncates to its
  // visible window. Returning the full ranked list keeps the run-
  // closure `_full` indexed parallel to model.modal.cmdline.matches
  // without an out-of-band index translation.
  return scored.map(s => s.entry);
}

// Render (renderCmdline + dropdown formatting + _lastPanelH state) moved
// to overlay/cmdline.js — see header comment.

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
  rebuild, runAt, clear,
  previewAtSel, revertPreview,
  runCommandString,
  // Test-only export — buffer parsing reused by test-cmdline-args.js.
  _splitQuery: splitQuery,
};
