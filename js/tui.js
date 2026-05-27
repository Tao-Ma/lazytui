#!/usr/bin/env node
/**
 * TUI — YAML-driven service manager.
 * Keyboard-first, lazygit-style layout. Zero npm dependencies.
 *
 * Usage: node tui.js [--design] <config.yml|config.json>
 *        node tui.js <config> --exec <group>:<action> [args...]
 *        node tui.js --spec   (print plugin authoring spec to stdout)
 *        node tui.js --help
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { S, loadConfig, initState } = require('./state');

// Heavy modules (terminal.js → node-pty, layout/render, plugin runtime) are
// loaded lazily inside the TUI branch in main() so CLI mode (--exec) doesn't
// pull in the render pipeline or its native deps.

const USAGE = `Usage: node tui.js [options] <config.yml|config.json>

Options:
  --design                   Interactive layout editor mode
  --exec <group>:<action>    Run a YAML action non-interactively and exit
                             with its rc. Args after the path become "$@".
                             Only type: run is supported in CLI mode.
  --list [filter]            Print every YAML action (path, label, desc).
                             Optional substring filters by path.
  --spec                     Print the plugin authoring spec to stdout
  -h, --help                 Show this help, then exit

Examples:
  node tui.js services.yml
  node tui.js --design services.yml
  node tui.js test.yml --list
  node tui.js test.yml --list detail
  node tui.js test.yml --exec detail:info
  node tui.js test.yml --exec base.observe.status:list 50
  node tui.js --spec | less
  node tui.js --spec > plugin-spec.md   # feed to an LLM as context

The plugin authoring spec is the concatenation of SPEC.md plus
PRINCIPLES.md, PLUGINS.md, PROJECT.md, HUB.md, DECORATORS.md,
LAYOUT.md from this repo. Use it to write a new plugin without
searching the codebase. AI agents: read --spec output before writing
plugin code.`;

// Order matters — SPEC.md is the entry/quickstart, then invariants,
// then plugin contract, then user-project contract (consumer-side
// of the same boundary), then optional layers, then layout reference.
const SPEC_DOCS = [
  'SPEC.md',
  'PRINCIPLES.md',
  'PLUGINS.md',
  'PROJECT.md',
  'HUB.md',
  'DECORATORS.md',
  'LAYOUT.md',
];

function printSpec() {
  // docs/ subtree under the repo root, since the 2026-05 reorg.
  const docsDir = path.resolve(__dirname, '..', 'docs');
  for (let i = 0; i < SPEC_DOCS.length; i++) {
    const name = SPEC_DOCS[i];
    const filepath = path.join(docsDir, name);
    let body;
    try {
      body = fs.readFileSync(filepath, 'utf8');
    } catch (e) {
      process.stderr.write(`--spec: missing doc ${filepath}\n`);
      process.exit(1);
    }
    if (i > 0) process.stdout.write('\n');
    process.stdout.write(body);
    if (!body.endsWith('\n')) process.stdout.write('\n');
  }
}

function main() {
  const args = process.argv.slice(2);
  let designEnabled = false;
  let execPath = null;
  let execArgs = [];
  let listMode = false;
  let listFilter = null;
  const configArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE + '\n');
      process.exit(0);
    } else if (a === '--spec') {
      printSpec();
      process.exit(0);
    } else if (a === '--design') {
      designEnabled = true;
    } else if (a === '--exec') {
      if (i + 1 >= args.length) {
        console.error('--exec requires <group>:<action>');
        process.exit(2);
      }
      execPath = args[++i];
      // After --exec <path>, every remaining arg is forwarded to the
      // action's "$@" — no further flag parsing.
      execArgs = args.slice(i + 1);
      break;
    } else if (a === '--list') {
      listMode = true;
      // An optional non-flag arg after --list is a substring filter.
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        listFilter = args[++i];
      }
    } else if (a.startsWith('-')) {
      console.error(`Unknown flag: ${a}`);
      console.error(USAGE);
      process.exit(2);
    } else configArgs.push(a);
  }
  if (configArgs.length < 1) {
    console.error(USAGE);
    process.exit(1);
  }

  if (execPath !== null) {
    const { runCli } = require('./cli');
    runCli(configArgs[0], execPath, execArgs).then((rc) => process.exit(rc));
    return;
  }

  if (listMode) {
    const { runList } = require('./cli');
    runList(configArgs[0], listFilter).then((rc) => process.exit(rc));
    return;
  }

  // Lazy-load TUI runtime so CLI mode stays free of node-pty + render deps.
  const { hideCursor } = require('./term');
  const { render, redraw, renderTerminalOverlay } = require('./layout');
  const { scheduleRender } = require('./render-queue');
  const { registerPlugin, loadPlugins, refreshAll, startRefreshLoops } = require('./plugins/api');
  const { setupKeyListener } = require('./input');
  const { destroyAll: destroyTerminals } = require('./terminal');
  const { installSuspendHandlers } = require('./suspend');

  S.designEnabled = designEnabled;

  loadConfig(configArgs[0]);

  // Register core panels (groups, actions, file-manager, detail) as a plugin
  // so the framework dogfoods its own plugin API.
  registerPlugin(require('./plugins/core'));

  // Register built-in plugins. docker provides the containers panel +
  // groupActions for `compose:` groups; config-status provides the
  // panel type that renders the file registry with category-grouped tabs.
  registerPlugin(require('./plugins/docker'));
  registerPlugin(require('./plugins/config-status'));

  // Load user plugins from YAML
  const configDir = path.dirname(path.resolve(configArgs[0]));
  loadPlugins(S.config.plugins, configDir);

  // Register any leader-key bindings declared in the top-level `keys:`
  // block, after plugins so the binding-tree conflict check sees the
  // full picture. Built-in chords are already registered at module load.
  require('./dispatch').loadKeyBindings(S.config);

  initState();
  hideCursor();
  installSuspendHandlers();   // Ctrl+Z: restore terminal → suspend → resume
  // Initial refresh kicks off async — first frame uses cached/empty data,
  // re-renders when plugins finish. UX: brief "no data" flash on first paint
  // is acceptable; freezing the boot wasn't.
  refreshAll(S.config).then(() => render());
  redraw();
  setupKeyListener();

  // Per-plugin refresh loops. Each plugin self-schedules at its declared
  // `refreshIntervalMs` (default 10000). Overlap-skip + focus-gating
  // happen inside startRefreshLoops; the call here just wires the
  // dependencies (config + focus state + paint callback). This replaces
  // the previous single setTimeout loop that fanned out to every plugin
  // on the same 10s tick — stats can now declare 1s, archive can
  // declare 5min, docker stays at 10s.
  startRefreshLoops(S.config, {
    isFocused: () => S.focused,
    onChanged: render,
  });

  // Safety-net poll for terminal overlay — primary updates come from
  // xterm.write callback (event-driven). This catches edge cases where
  // internal state changes without parse events. Always-on so ephemeral
  // terminals (created at runtime via plugins) are covered too. The
  // function returns immediately if no terminal tab is active.
  setInterval(() => renderTerminalOverlay(), 250);

  // Handle resize. Debounced via scheduleRender — modern terminals
  // emit 30+ resize events/sec during a window-edge drag; one paint per
  // event would run a full calcLayout + force-full repaint each time.
  process.stdout.on('resize', () => scheduleRender());

  // Clean up terminal sessions on exit
  process.on('exit', destroyTerminals);
}

main();
