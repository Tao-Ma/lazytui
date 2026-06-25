#!/usr/bin/env node
/**
 * TUI — YAML-driven service manager.
 * Keyboard-first, lazygit-style layout. Zero npm dependencies.
 *
 * Usage: node tui.js [options] <config.yml|config.json>
 *        node tui.js <config> --exec <group>:<action> [args...]
 *        node tui.js --spec   (print Component authoring spec to stdout)
 *        node tui.js --help
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig, initState } = require('./state');

// Heavy modules (terminal.js → node-pty, layout/render, Component runtime)
// are loaded lazily inside the TUI branch in main() so CLI mode (--exec)
// doesn't pull in the render pipeline or its native deps.

const USAGE = `Usage: node tui.js [options] <config.yml|config.json>

Options:
  --exec <group>:<action>    Run a YAML action non-interactively and exit
                             with its rc. Args after the path become "$@".
                             Only type: run is supported in CLI mode.
  --list [filter]            Print every YAML action (path, label, desc).
                             Optional substring filters by path.
  --spec                     Print the Component authoring spec to stdout
  -h, --help                 Show this help, then exit

Examples:
  node tui.js services.yml
  node tui.js test.yml --list
  node tui.js test.yml --list detail
  node tui.js test.yml --exec detail:info
  node tui.js test.yml --exec base.observe.status:list 50
  node tui.js --spec | less
  node tui.js --spec > component-spec.md   # feed to an LLM as context

Free-config (interactive layout editor) is reachable at runtime via
the \`:free-config\` cmdline verb.

The Component authoring spec is the concatenation of SPEC.md plus
PRINCIPLES.md, PLUGINS.md, PROJECT.md, HUB.md, LAYOUT.md from this
repo. Use it to write a new Component without searching the codebase.
AI agents: read --spec output before writing Component code.`;

// Order matters — SPEC.md is the entry/quickstart, then invariants,
// then Component contract, then user-project contract (consumer-side
// of the same boundary), then optional layers, then layout reference.
// (DECORATORS.md retired in v0.5 Phase 5; the file is a one-page
// retirement note and isn't part of the authoring bundle anymore.)
const SPEC_DOCS = [
  'SPEC.md',
  'PRINCIPLES.md',
  'PLUGINS.md',
  'PROJECT.md',
  'HUB.md',
  'LAYOUT.md',
];

function printSpec() {
  // docs/ subtree at the repo root. tui.js lives at js/app/tui.js after
  // the v0.5 reorg, so resolve up two levels (js/app → js → repo root)
  // before joining `docs`.
  const docsDir = path.resolve(__dirname, '..', '..', 'docs');
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

  // TUI branch — needs a TTY on stdin and stdout. Without this guard,
  // setupKeyListener's setRawMode(true) below throws TypeError mid-boot
  // AFTER hideCursor + chrome paint have already run, leaving the
  // terminal with a hidden cursor + half-painted chrome and no cleanup.
  // Fail clean with a useful message instead.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('lazytui: needs a TTY on stdin and stdout (run interactively, not in a pipe or redirect)');
    process.exit(1);
  }

  // Lazy-load TUI runtime so CLI mode stays free of node-pty + render deps.
  const { hideCursor } = require('../io/term');
  // Load paint.js for its SIDE EFFECT: at module load it registers its
  // renderers into the render-queue seam (`setRenderers`, paint.js bottom).
  // `paintNow()`/`scheduleRender()` no-op until that runs, so this must happen
  // before the first `redraw()` below. (Until v0.6.6 FIX-3 this load rode in on
  // the `renderTerminalOverlay` import used by the overlay-poll setInterval;
  // that poll is now a model-conditional Sub, but the load-order anchor stays.)
  require('../render/paint');
  // v0.6.4 Phase F — redraw (dispatch-then-paint) lives in the dispatch
  // layer now; paint.js is a pure view. tui orchestrates both.
  const { redraw } = require('../dispatch/control/dispatch');
  const { registerComponent, refreshAll } = require('../panel/api');
  const { setupKeyListener } = require('../dispatch/control/input');
  const { getModel } = require('../model/store');
  const { installSuspendHandlers } = require('./suspend');
  const { cleanup } = require('../dispatch/runtime/cleanup');

  // Register the global cleanup handler FIRST — any throw between here
  // and the input pump starting (loadConfig, registerComponent, the
  // initial refreshAll) would otherwise leave the terminal in raw mode /
  // mouse on / bracketed paste on / focus events on / cursor hidden.
  // cleanup() is idempotent (destroyAll empties the session map; disable
  // escape codes are no-ops when already off) so the symmetric call from
  // the `quit` effect on user-quit is safe to fire too.
  process.on('exit', cleanup);
  // FIX-3 Phase 5 — tear down every live subscription on quit: stop the
  // `process-stream` Subs (kill their children — e.g. `docker events`, which
  // does NOT die with the parent), cancel intervals, remove the resize
  // listener. Replaces docker's old `cleanup: stopEventsStream` hook + its
  // `process.on('exit')` backstop now that the events stream is a declared Sub.
  process.on('exit', () => { try { require('./state').teardownSubscriptions(); } catch (_) {} });
  // Backstop: process.on('exit') runs only when Node exits NORMALLY.
  // An uncaught throw (async PTY handler after dispose, a hub publish
  // inside an effect that rethrows, etc.) would bypass it — terminal
  // left in raw + mouse mode + bracketed paste on, PTY children
  // orphaned. Run cleanup then re-throw to keep the stack trace.
  const _onFatal = (kind) => (err) => {
    try { cleanup(); } finally {
      process.stderr.write(`\n[lazytui] ${kind}: ${err && err.stack || err}\n`);
      process.exit(1);
    }
  };
  process.on('uncaughtException',  _onFatal('uncaughtException'));
  process.on('unhandledRejection', _onFatal('unhandledRejection'));

  // Wire the panel-host seam (ports/panel-host) before any dispatch — the
  // `panel/` layer invokes dispatch + overlay capabilities through it instead
  // of importing upward (the cut that dissolves the {dispatch,overlay,panel}
  // layer cycle). See docs/v0.6.5-render-exit.md "Domain detangle".
  require('../dispatch/runtime/host-wiring').wirePanelHost();
  // Inject the dispatch host into nav-state's writers (formalized injection —
  // they feed Msgs back through it instead of importing the relocating fan-out).
  // Before initState/refreshAll, whose finalizer runs syncPanelScroll→setScroll.
  require('../panel/nav-state').setNavDispatch(require('../dispatch/runtime/effects').effectHost());
  // Inject the same host into the command run-closures (cmdline / leader).
  require('../panel/commands').setCommandsDispatch(require('../dispatch/runtime/effects').effectHost());

  // Install the Component effect handlers (focus/render/apply_msg/...) before
  // any Component registers — a Component's update→effects must resolve at
  // first dispatch.
  require('../dispatch/runtime/effects').installBuiltins();

  // Friendly one-line error instead of a Node stack trace if the config
  // is missing, empty, or malformed — every other config-shaped error
  // in main (--exec missing, unknown flag, key-binding conflict) already
  // matches this pattern; loadConfig was the odd one out.
  try { loadConfig(configArgs[0]); }
  catch (e) { console.error(`config: ${e.message}`); process.exit(1); }

  // Built-in Components (TEA shape). The first three OWN state in their slices
  // (genuine isolation — poll loops, browsers, git cache); the rest are
  // stateless Components (empty slice + no-op update) — the API-uniformity tax
  // for keeping ONE panel shape across the stateless view set. See
  // docs/v0.5-layering.md.
  // layout (chrome-only) — the frame Component (Phase 1a skeleton; subsequent
  // sub-phases migrate focus/viewMode/freeConfig/arrange into its slice). See
  // docs/v0.5-layout-component.md.
  registerComponent(require('../panel/layout'));
  registerComponent(require('../panel/navigator/docker'));
  registerComponent(require('../panel/navigator/config-status'));
  registerComponent(require('../panel/navigator/files'));
  registerComponent(require('../panel/navigator/actions'));
  registerComponent(require('../panel/monitor/stats'));
  registerComponent(require('../panel/navigator/history'));
  // detail (the viewer) — owns the viewer slice + update; the last panel
  // migrated to the Component shape in v0.5 Phase B.
  registerComponent(require('../panel/viewer/viewer'));
  // groups (last in-tree migration, v0.5 Phase C). Owns the tree slice
  // (list / expanded / tab); the cascade (currentGroup / per-group root
  // chrome reset / viewer reset) goes out as apply_msg / dispatch_msg Cmds.
  registerComponent(require('../panel/navigator/groups'));

  // PTY exit fan-out — wires `panel/viewer/pty-lifecycle` into
  // `io/terminal.js` so the io layer stays a leaf (it used to lazy-
  // require panel/viewer/tabs + panel/api + render/geometry on every
  // session exit — a documented inversion). Must run AFTER the viewer
  // Component is registered so the handler's slice reads land.
  require('../panel/viewer/pty-lifecycle').install(require('../dispatch/runtime/effects').effectHost());

  // Phase 6 — the runtime Plugin API retired. External authors write
  // Components and register them the same way the built-ins above do.
  // The `plugins:` block still has a parser-level role though: entries
  // whose `path:` ends in `.yml`/`.yaml` are merged in by the parser as
  // YAML config splits (see `mergeYamlPlugins` in parser/index.js).
  // Warn only on entries that AREN'T splits — those are the ones that
  // would have been runtime plugins under the retired API.
  const { retiredPluginEntries } = require('../parser/index');
  const retired = retiredPluginEntries(getModel().config && getModel().config.plugins);
  if (retired.length > 0) {
    console.error(`[config] \`plugins:\` entries ${JSON.stringify(retired)} are no longer loaded (runtime Plugin API retired in v0.5 Phase 6); migrate to Components.`);
  }

  // Register any leader-key bindings declared in the top-level `keys:`
  // block, after Component registration so the binding-tree conflict
  // check sees the full picture. Built-in chords are already registered
  // at module load (and are overridable by user bindings). A genuine
  // conflict between two user bindings throws — surface it as a clean
  // config error and exit rather than crashing the boot with a raw stack.
  try {
    require('../dispatch/control/dispatch').loadKeyBindings(getModel().config);
  } catch (e) {
    console.error(`keys: ${e.message}`);
    process.exit(1);
  }

  // v0.6.4 Theme F Phase 4 — merge the top-level `mouse:` block (gesture →
  // intent overrides + the double-click window) over the code defaults. The
  // block is already schema-validated at parse time, so this can't throw on
  // a bad shape; it just fills the mouse-bindings registry the input layer
  // reads. No try/exit needed.
  require('../dispatch/control/dispatch').loadMouseBindings(getModel().config);

  // v0.6.4 Theme F follow-on — install the top-level `context-menu:` block
  // (extra right-click entries) into the context-menu registry. Schema-
  // validated at parse time; loadContextMenu only warns (never throws) on an
  // unresolved `action:`, so no try/exit needed.
  require('../dispatch/control/dispatch').loadContextMenu(getModel().config);

  initState();
  // Post-T7: no captured `model` local at boot. handleKey / handleMouse
  // read getModel() at entry; the paint path threads the current model
  // through the render-queue seam thunk (#D6 — render(model) is pure, the
  // thunk fetches at paint time); scheduleRender goes through render-queue.
  // Anything that needs current model state reads it AT the read site, not
  // from a frozen-at-boot snapshot.
  hideCursor();
  installSuspendHandlers();   // Ctrl+Z: restore terminal → suspend → resume
  // Initial refresh broadcasts a `{type:'refresh'}` Msg to every
  // Component synchronously (refreshAll's `async` wrapper doesn't
  // await anything internally). Each Component's update folds results
  // into its slice + may emit a tick/render Cmd for later polling.
  // The first redraw() below paints what's settled by then;
  // Components that drive async work (docker, files) will trigger
  // their own scheduleRender as their callbacks land. The historical
  // `refreshAll().then(() => render())` then a separate `redraw()`
  // double-painted the same state (P5.6).
  refreshAll();
  redraw();
  setupKeyListener();

  // Phase 6 — the framework's per-Plugin refresh-loop retired. Components
  // that need periodic polling (docker, files, config-status) self-arm
  // from their `refresh`-Msg handler via a `tick` effect; the cadence is
  // entirely Component-owned (the self-re-arming-tick Cmd pattern).

  // #D15 (2026-06-18, examined + KEPT) — eventual-consistency repaint of the
  // terminal overlay, the safety-net backstop for the off-model PTY island
  // (#D14). The event-driven triggers (PTY write→scheduleOverlay; tab-activation /
  // resize / any dispatch→render) cover the common cases, BUT the PTY's output is
  // ASYNC + off-model and has race windows the events miss — e.g. output that
  // arrives around tab-activation lands in the xterm buffer with no *subsequent*
  // write to repaint the now-visible overlay. We tried to eliminate this poll
  // (the review's D15) and `smoke/pty-overlay.js` EMPIRICALLY caught the
  // regression (the command marker stopped painting) — so it stays. It's the
  // adapted "render outside the loop" cost of the deliberately non-TEA xterm
  // island. As of v0.6.6 FIX-3 Phase 3 it's a model-conditional `interval` Sub
  // (`app/state.js#_appSubscriptions`): declared + running ONLY while a terminal
  // tab is on-screen, instead of an always-on `setInterval` that no-op'd
  // otherwise. Eliminable only if xterm exposes a buffer-change signal (D14) —
  // it does not.

  // Resize (resize-as-Msg P1) is now a declared app-global `resize` Sub
  // (v0.6.6 FIX-3 Phase 2 — `app/state.js#_subKinds.resize`): the reconciler
  // attaches the `process.stdout.on('resize')` listener, which refreshes
  // io/term's mirror, dispatches `term_resized` (lands dims in the model), and
  // repaints. Besides initState's boot seed this is the only live terminal-size
  // read; everything downstream reads layoutSlice.dims.

  // T12: PTY teardown rides on the global cleanup() handler registered
  // earlier in main — cleanup invokes destroyAll itself. The previous
  // standalone process.on('exit', destroyTerminals) was redundant with
  // that AND covered only the PTY-cleanup slice (left mouse/cursor/etc.
  // in their enabled state if anything mid-boot threw).
}

main();
