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
 *
 * Run closures execute in the dispatch layer (cmdline / leader-key), so every
 * runtime ask they make — dispatchMsg, refreshAll, cleanup (:quit), showHelp
 * (:help) — goes through the injected dispatch host (`setCommandsDispatch`,
 * wired at boot), not an upward import. `wrap` is the zero-dep route leaf. This
 * keeps panel below dispatch/overlay (no panel→dispatch import) and keeps
 * node-pty (pulled in by dispatch/cleanup→terminal) off CLI mode's load path.
 * The formalized-injection model — see docs/v0.6.5-dispatch-loop.md.
 */
'use strict';

const route = require('../panel/route');
const { wrap } = route;
const { getModel } = require('../model/store');
// Eager-require open-target scheme modules so their schemes register on
// the registry before the first `:open` invocation (or first cmdline
// rebuild that consults argComplete).
require('../feature/open-file');     // host scheme (catch-all)
require('../feature/open-docker');   // docker scheme (docker://<container>/<path>)

// Injected dispatch host (set at boot via setCommandsDispatch). Command run
// closures execute in dispatch (cmdline / leader), so they feed Msgs + runtime
// asks (dispatchMsg/refreshAll/cleanup/showHelp) back through this host instead
// of importing the relocating fan-out / panel-host seam. Closures run only
// AFTER boot, so _host is always set by call time. See docs/v0.6.5-dispatch-loop.md.
let _host = null;
function setCommandsDispatch(host) { _host = host; }

const FRAMEWORK_COMMANDS = [
  {
    name: 'quit',
    desc: 'Exit the TUI',
    run: () => {
      _host.cleanup();
      process.exit(0);
    },
  },
  {
    name: 'refresh',
    desc: 'Re-fan a refresh Msg to every Component',
    run: async () => { await _host.refreshAll(); },
  },
  {
    name: 'help',
    desc: 'Show key help in detail panel',
    run: () => { _host.showHelp(); },
  },
  {
    name: 'save-layout',
    desc: 'Persist current panel layout to the YAML config',
    run: () => {
      const { writeLayoutToFile } = require('../feature/yaml-layout');
      const { appendViewerLines } = require('./nav-state');
      const m = getModel();
      const { error } = writeLayoutToFile(route.getInstanceSlice('layout').arrange, m.configPath);
      if (error) {
        appendViewerLines(`[red]Layout save failed:[/] ${error.message}`);
      } else {
        _host.dispatchMsg(wrap('layout', { type: 'set_arrange', dirty: false }));
        appendViewerLines(`[green]Layout saved to[/] ${m.configPath}`);
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
        const { appendViewerLines } = require('./nav-state');
        appendViewerLines('[red]:open requires a path[/] — usage: :open <path>');
        return;
      }
      // Strip wrapping quotes (the cmdline splits on whitespace; quoting
      // is the user's way of preserving a path with spaces). Only strip
      // a balanced pair — `"foo'` is not quoted.
      const cleaned = input.replace(/^(['"])(.*)\1$/, '$2');
      require('../feature/open-target').openInput(cleaned);
    },
  },
  {
    name: 'restore-layout',
    desc: 'Discard runtime changes; reload panel layout from YAML',
    run: () => {
      const { appendViewerLines } = require('./nav-state');
      const { rebuildLayoutFromConfig } = require('../leaves/arrange');
      const m = getModel();
      _host.dispatchMsg(wrap('layout', {
        type: 'set_arrange', arrange: rebuildLayoutFromConfig(m.config), dirty: false,
      }));
      // The runtime layout the user was working with is gone; the
      // undo/redo history pointed at it is no longer meaningful.
      _host.dispatchMsg(wrap('layout', { type: 'free_config_clear_undo' }));
      appendViewerLines(`[green]Layout restored from[/] ${m.configPath}`);
    },
  },
  {
    name: 'dismiss-warnings',
    desc: 'Clear the config-warning chrome notice',
    run: () => {
      _host.dispatchMsg(wrap('layout', { type: 'dismiss_warnings' }));
    },
  },
  {
    name: 'add-column',
    desc: 'Insert an empty column — :add-column [position]  (default: just before the last column)',
    run: (args) => {
      const layoutSlice = route.getInstanceSlice('layout');
      const mpool = require('../leaves/pool');
      const N = mpool.columnCount(layoutSlice && layoutSlice.arrange);
      // Default: insert just before the last column (so it sits between
      // the navigators and the viewer-side last column). 1-based for
      // the cmdline UX (user sees columns numbered 1..N+1); internal
      // position is 0-based.
      // Use `Number` (not `parseInt`) so '5.5' fails the integer check
      // — parseInt would silently floor to 5 and dispatch a bogus
      // success.
      let position1 = (args && args.length > 0) ? Number(args[0]) : N;
      if (!Number.isInteger(position1)) {
        const { appendViewerLines } = require('./nav-state');
        appendViewerLines(`[red]:add-column requires a 1-based integer position[/]`);
        return;
      }
      _host.dispatchMsg(wrap('layout', { type: 'add_column', position: position1 - 1 }));
    },
  },
  {
    name: 'remove-column',
    desc: 'Remove an empty column — :remove-column <n>  (1-based; refused on last column or non-empty)',
    run: (args) => {
      if (!args || args.length === 0) {
        const { appendViewerLines } = require('./nav-state');
        appendViewerLines(`[red]:remove-column requires a column number[/]`);
        return;
      }
      const n1 = Number(args[0]);
      if (!Number.isInteger(n1)) {
        const { appendViewerLines } = require('./nav-state');
        appendViewerLines(`[red]:remove-column requires a 1-based integer column number[/]`);
        return;
      }
      _host.dispatchMsg(wrap('layout', { type: 'remove_column', columnIndex: n1 - 1 }));
    },
  },
];

/**
 * Dynamic framework `:` verbs — synthesized per call because their
 * candidates depend on current state (loaded themes, configured panels).
 */
function _frameworkDynamicCommands(m) {
  const { themeNames } = require('../leaves/infra/themes');
  const { allPanels } = require('./nav-state');
  const out = [];
  for (const name of themeNames()) {
    out.push({
      name: `theme ${name}`,
      desc: `Switch to ${name} theme`,
      // Live preview while the user navigates cmdline matches. Theme is model
      // state now (model.theme), so preview / commit / restore all flow through
      // the `set_theme` Msg instead of poking the palette cache directly — the
      // model always reflects what's on screen, and the restore is a dispatch
      // (not the old imperative setTheme(orig)). `orig` reads getModel().theme
      // FRESH at preview-time (not the build-time `m`, which is stale during
      // arrow-nav; the framework runs the prior teardown before this preview,
      // so the read sees the committed value).
      preview: () => {
        const orig = getModel().theme;
        _host.applyMsg({ type: 'set_theme', name });
        return () => _host.applyMsg({ type: 'set_theme', name: orig });
      },
      run: () => _host.applyMsg({ type: 'set_theme', name }),
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
        _host.dispatchMsg(wrap('layout', { type: 'focus_set', focus: p.type }));
      },
    });
  }
  const layoutSlice = route.getInstanceSlice('layout');
  if (layoutSlice) {
    out.push({
      name: 'free-config',
      desc: 'Open free-config mode (layout edit + pool overlay)',
      run: () => { _host.dispatchMsg(wrap('layout', { type: 'free_config_enter' })); },
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
        run: () => { _host.dispatchMsg(wrap('layout', { type: 'pool_hide', id })); },
      });
    }
    for (const id of mpool.hiddenIds(arrange)) {
      const entry = arrange.pool[id];
      if (!entry) continue;
      out.push({
        name: `show ${id}`,
        desc: `Show the hidden ${entry.title || id} panel`,
        run: () => { _host.dispatchMsg(wrap('layout', { type: 'pool_show', id })); },
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
      // v0.6.3 post-arch-arc — focus is paneId post-T3.5. Match the
      // owning pane via paneId first; legacy form (tab id / pool id)
      // kept for any pre-migration caller that hands `focus` in raw.
      const mpane = require('../leaves/pane');
      const focusedPane = all.find(p =>
        mpane.paneMatchesFocus(p, focus)
        || (p.tabs && p.tabs.some(t => t.id === focus))
      );
      if (focusedPane && focusedPane.tabs && focusedPane.tabs.length > 1) {
        for (const t of focusedPane.tabs) {
          if (t.id === focusedPane.activeTabId) continue;
          const entry = arrange.pool[t.id];
          const title = (entry && entry.title) || t.id;
          out.push({
            name: `switch-tab ${t.id}`,
            desc: `Switch to '${title}' tab in this pane`,
            run: () => { _host.dispatchMsg(wrap('layout', {
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
    try { require('../io/event-log').record('error', {
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

module.exports = { setCommandsDispatch, FRAMEWORK_COMMANDS, collectCommands };
