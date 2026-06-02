/**
 * Framework `:` cmdline command registry.
 *
 * Four sources collected into one list per call:
 *   1. FRAMEWORK_COMMANDS — static framework verbs (quit / refresh / help /
 *      save-layout / restore-layout). They live here because they're
 *      framework actions, not Component behavior.
 *   2. _frameworkDynamicCommands — state-derived framework verbs
 *      (theme <name> / focus <panel> / free-config / design / hide / show).
 *   3. Each Component's static `commands` array.
 *   4. Each Component's `getCommands(model)` (state-derived candidates).
 *
 * Each command: { name, desc, run(args) }. Source is stamped on `_source`
 * for telemetry / disambiguation; framework defaults + dynamic framework
 * verbs are stamped `<framework>`.
 *
 * Carved out of panel/api.js — api.js's `getCommands()` is now a thin
 * wrapper that calls `collectCommands(Object.values(components), getModel())`.
 * Dispatch primitives (dispatchMsg, refreshAll) live in api.js; the run
 * closures here lazy-require them to break the cycle. `wrap` comes from the
 * zero-dep route leaf directly (api.js itself is just a re-exporter).
 *
 * Run closures are lazy on their imports too: `help` lazy-requires help-text
 * to avoid an api → help-text → api cycle at module-load time. `cleanup`
 * lazy-requires `app/cleanup` because that file pulls `terminal` → `node-pty`,
 * which CLI mode (cli.js) needs to avoid — cli.js may require panel/api to
 * discover Component `groupActions` without booting the TUI runtime.
 */
'use strict';

const route = require('../leaves/route');
const { wrap } = route;
// Eager-require open-target scheme modules so their schemes register on
// the registry before the first `:open` invocation (or first cmdline
// rebuild that consults argComplete).
require('../feature/open-file');     // host scheme (catch-all)
require('../feature/open-docker');   // docker scheme (docker://<container>/<path>)

const FRAMEWORK_COMMANDS = [
  {
    name: 'quit',
    desc: 'Exit the TUI',
    run: () => {
      const { cleanup } = require('../app/cleanup');
      cleanup();
      process.exit(0);
    },
  },
  {
    name: 'refresh',
    desc: 'Re-fan a refresh Msg to every Component',
    run: async () => { await require('./api').refreshAll(); },
  },
  {
    name: 'help',
    desc: 'Show key help in detail panel',
    run: () => { require('../dispatch/help-text').showHelp(); },
  },
  {
    name: 'save-layout',
    desc: 'Persist current panel layout to the YAML config',
    run: () => {
      const { writeLayoutToFile } = require('../feature/yaml-layout');
      const { setViewerContent } = require('../app/state');
      const m = require('../app/runtime').getModel();
      const { error } = writeLayoutToFile(route.getInstanceSlice('layout').arrange, m.configPath);
      if (error) {
        setViewerContent(null, `[red]Layout save failed:[/] ${error.message}`);
      } else {
        require('./api').dispatchMsg(wrap('layout', { type: 'set_arrange', dirty: false }));
        setViewerContent(null, `[green]Layout saved to[/] ${m.configPath}`);
      }
    },
  },
  {
    name: 'open',
    desc: 'Open a file as a content tab — :open <path>  (or docker://container/path)',
    // Per-argument completion. Routes through the open-target scheme
    // registry so host paths, docker URIs (`docker://container/path`,
    // Phase B), and future schemes share the same TAB-completion machinery.
    argComplete: (text) => require('../feature/open-target').complete(text),
    run: (args) => {
      const input = (args && args.join(' ')) || '';
      if (!input) {
        const { setViewerContent } = require('../app/state');
        setViewerContent(null, '[red]:open requires a path[/] — usage: :open <path>');
        return;
      }
      // Strip wrapping quotes (the cmdline splits on whitespace; quoting
      // is the user's way of preserving a path with spaces).
      const cleaned = input.replace(/^['"]|['"]$/g, '');
      require('../feature/open-target').openInput(cleaned);
    },
  },
  {
    name: 'restore-layout',
    desc: 'Discard runtime changes; reload panel layout from YAML',
    run: () => {
      const { setViewerContent } = require('../app/state');
      const { rebuildLayoutFromConfig } = require('../leaves/arrange');
      const m = require('../app/runtime').getModel();
      const api = require('./api');
      api.dispatchMsg(wrap('layout', {
        type: 'set_arrange', arrange: rebuildLayoutFromConfig(m.config), dirty: false,
      }));
      // The runtime layout the user was working with is gone; the
      // undo/redo history pointed at it is no longer meaningful.
      api.dispatchMsg(wrap('layout', { type: 'free_config_clear_undo' }));
      setViewerContent(null, `[green]Layout restored from[/] ${m.configPath}`);
    },
  },
  {
    name: 'dismiss-warnings',
    desc: 'Clear the config-warning chrome notice',
    run: () => {
      require('./api').dispatchMsg(wrap('layout', { type: 'dismiss_warnings' }));
    },
  },
];

/**
 * Dynamic framework `:` verbs — synthesized per call because their
 * candidates depend on current state (loaded themes, configured panels).
 */
function _frameworkDynamicCommands(m) {
  const { setTheme, themeNames, activeThemeName } = require('../render/themes');
  const { allPanels } = require('../app/state');
  const api = require('./api');
  const out = [];
  for (const name of themeNames()) {
    out.push({
      name: `theme ${name}`,
      desc: `Switch to ${name} theme`,
      // Live preview while the user navigates cmdline matches — captures
      // the active theme at preview-time and returns the closure that
      // restores it (the cmdline framework calls it when sel moves off
      // or the user cancels). On submit, run() does the same setTheme
      // so the preview is the committed state.
      preview: () => {
        const orig = activeThemeName();
        setTheme(name);
        return () => setTheme(orig);
      },
      run: () => { setTheme(name); },
    });
  }
  for (const p of allPanels()) {
    out.push({
      name: `focus ${p.title}`,
      desc: `Focus the ${p.title} panel`,
      // focus_set is handled by layout.update (Phase 1c); route via
      // Component fan-out so the cascade (show_selected_info Cmd) runs.
      // Writing getFocus() directly would skip the refresh.
      run: () => {
        api.dispatchMsg(wrap('layout', { type: 'focus_set', focus: p.type }));
      },
    });
  }
  const layoutSlice = route.getInstanceSlice('layout');
  if (layoutSlice) {
    out.push({
      name: 'free-config',
      desc: 'Open free-config mode (layout edit + pool overlay)',
      run: () => { require('../dispatch/dispatch').startFreeConfig(); },
    });
  }
  // v0.6 Phase 2 — pool hide/show. One verb per id makes autocomplete
  // restrict to valid targets and gives `desc` somewhere to land. Same
  // pattern as `theme <name>` / `focus <name>` above.
  if (layoutSlice && layoutSlice.arrange && layoutSlice.arrange.pool) {
    const mpool = require('../leaves/pool');
    const arrange = layoutSlice.arrange;
    // :hide accepts the ACTIVE tab id of a placed pane (pool_hide
    // looks up by `p.id` which mirrors the active tab in v0.6.1). For
    // multi-tab panes, non-active tabs aren't directly hide-able —
    // managing them is :switch-tab + :hide. `activePaneIds` returns
    // the active ids only; `placedIds` now enumerates every tab to
    // keep hiddenIds honest.
    for (const id of mpool.activePaneIds(arrange)) {
      const entry = arrange.pool[id];
      if (!entry || mpool.isDetailPane(entry)) continue;  // detail can't be hidden
      out.push({
        name: `hide ${id}`,
        desc: `Hide the ${entry.title || id} panel (stays in pool)`,
        run: () => { api.dispatchMsg(wrap('layout', { type: 'pool_hide', id })); },
      });
    }
    for (const id of mpool.hiddenIds(arrange)) {
      const entry = arrange.pool[id];
      if (!entry) continue;
      out.push({
        name: `show ${id}`,
        desc: `Show the hidden ${entry.title || id} panel`,
        run: () => { api.dispatchMsg(wrap('layout', { type: 'pool_show', id })); },
      });
    }
    // v0.6.1 — :switch-tab <pool-id> flips the active tab in the
    // focused multi-tab pane. One entry per non-active tab so
    // autocomplete restricts to valid targets; absent on single-tab
    // panes. Resolves the focused pane by finding which pane's tabs
    // include the focused tab id (or whose pane.id matches focus —
    // singleton-instance fallback).
    const focus = layoutSlice.focus;
    if (focus) {
      const all = mpool.allPanesInColumns(arrange);
      const focusedPane = all.find(p =>
        (p.tabs && p.tabs.some(t => t.id === focus)) || p.id === focus
      );
      if (focusedPane && focusedPane.tabs && focusedPane.tabs.length > 1) {
        for (const t of focusedPane.tabs) {
          if (t.id === focusedPane.activeTabId) continue;
          const entry = arrange.pool[t.id];
          const title = (entry && entry.title) || t.id;
          out.push({
            name: `switch-tab ${t.id}`,
            desc: `Switch to '${title}' tab in this pane`,
            run: () => { api.dispatchMsg(wrap('layout', {
              type: 'set_active_tab', paneId: focusedPane.paneId, tabPoolId: t.id,
            })); },
          });
        }
      }
    }
  }
  return out;
}

/**
 * Collect every `:` command from framework + Components. `componentsList`
 * is the values of api.js's components registry (passed in to avoid a
 * load-time cycle); `model` is the current root-model snapshot.
 *
 * T28 / R23 — duplicate command name detection. Two Components contributing
 * the same command name silently both appear in the `:` cmdline; programmatic
 * lookup picks whichever was registered first. Warn on each collision so a
 * maintainer notices — log goes to console + event-log via the same channel
 * as the panel-type collision warning at registerComponent.
 *
 * Dedup scope: per call. `seen` and `warned` reset on every call, so a
 * duplicate collision re-warns on each cmdline rebuild (i.e. each keystroke
 * in `:` mode). Noisy if a real dup exists, but the common path (no dups)
 * never logs.
 */
function collectCommands(componentsList, m) {
  const out = [];
  const seen = new Map();
  const warned = new Set();
  const _addOrWarn = (cmd) => {
    out.push(cmd);
    const prior = seen.get(cmd.name);
    if (prior === undefined) { seen.set(cmd.name, cmd._source); return; }
    if (prior === cmd._source) return;
    const key = `${cmd.name}|${prior}|${cmd._source}`;
    if (warned.has(key)) return;
    warned.add(key);
    console.error(`[commands] duplicate name '${cmd.name}': '${prior}' and '${cmd._source}' both contribute (both will appear in the cmdline)`);
    try { require('../dispatch/event-log').record('error', {
      where: 'commands', kind: 'duplicate_name',
      name: cmd.name, owners: [prior, cmd._source],
    }); } catch (_) {}
  };
  for (const c of FRAMEWORK_COMMANDS) {
    _addOrWarn({ ...c, _source: '<framework>' });
  }
  for (const c of _frameworkDynamicCommands(m)) {
    _addOrWarn({ ...c, _source: '<framework>' });
  }
  for (const comp of componentsList) {
    const collect = (list) => {
      if (!Array.isArray(list)) return;
      for (const c of list) {
        if (!c || typeof c.name !== 'string' || typeof c.run !== 'function') continue;
        _addOrWarn({ ...c, _source: comp.name });
      }
    };
    collect(comp.commands);
    if (typeof comp.getCommands === 'function') {
      try { collect(comp.getCommands(m)); }
      catch (e) { console.error(`[${comp.name}] getCommands error: ${e.message}`); }
    }
  }
  return out;
}

module.exports = { FRAMEWORK_COMMANDS, collectCommands };
