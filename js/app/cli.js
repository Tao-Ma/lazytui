/**
 * CLI mode — run a YAML-declared action non-interactively and exit with
 * its rc. The interactive TUI is the primary entry point; this file is
 * the alternate path that lets the same YAML drive shell scripts.
 *
 *   node tui.js <config.yml> --exec <group-path>:<action-key> [args...]
 *
 * The group path matches the parser's flat dotted-key form (e.g. base,
 * base.observe, base.observe.status). The colon separates group from
 * action key so dotted group names stay unambiguous.
 *
 * Covers `type: run` (default) — spawn `sh -c <script> -- <args>` with
 * stdio inherited, propagate the rc. `confirm:` is bypassed: invoking
 * the CLI is the user's authorization. `type: spawn` and `type:
 * background` aren't supported here — they're tied to terminal-window
 * detach semantics that don't fit a non-interactive CLI.
 *
 * Plugin-synthesized actions (docker plugin's `groupActions` for groups
 * with `compose:`, generic plugins like archive / config-branch) are
 * merged on demand via `_mergeForGroup` — YAML wins on conflict, so
 * explicit YAML actions still override the plugin's defaults. The
 * config is NEVER mutated (v0.6.2 — pre-v0.6.2 `applyPluginGroupActions`
 * mutated `group.actions` in place, retired for TEA-correctness
 * symmetry with the TUI accessor `panel/api.getMergedActions`).
 *
 * The set of plugins consulted here is hard-coded to built-ins that
 * ship with lazytui (`BUILT_IN_PLUGINS` below); user JS plugins loaded
 * via the YAML `plugins:` map aren't yet consulted in CLI mode and
 * remain TUI-only — straightforward extension when needed.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { loadConfig } = require('./state');
const { getModel } = require('./runtime');

// Built-in Components consulted for `groupActions(group, name)`
// synthesis. Add new generic Components here as they ship — keep
// the list explicit (rather than auto-discovering panel/**/*.js)
// for predictability.
//
// T18 — earlier framing claimed this list "avoids pulling render-
// coupled modules that don't tolerate CLI-mode startup." In practice
// `require('../panel/navigator/docker')` transitively loads panel/
// api → render/panel, render/themes, render/render-queue, render/
// scrollbar, io/term, io/stream, panel/viewer/tabs,
// dispatch/effects. CLI mode still doesn't pollute stdout/stderr
// today because none of those have load-time side effects (no top-
// level setRawMode / hideCursor / setInterval). The load-bearing
// contract is now "the transitive closure of these modules must not
// have load-time side effects" — if a future commit adds one, CLI
// mode breaks silently.
const BUILT_IN_PLUGINS = [
  '../panel/navigator/docker',
  '../feature/archive',
  '../panel/navigator/config-branch',
  '../feature/image-backup',
];

/**
 * Compute the merged `{ ...plugin, ...YAML }` action set for one group.
 * Pure — no config mutation; the returned object is fresh per call.
 * Plugin failures swallowed so one broken contributor can't wedge the
 * CLI. v0.6.2 — sibling of `panel/api.getMergedActions` (which uses
 * the Component registry); CLI uses its own static plugin list since
 * Components aren't booted in CLI mode.
 */
function _mergeForGroup(group, groupPath, config) {
  const result = {};
  for (const pluginPath of BUILT_IN_PLUGINS) {
    let plugin;
    try { plugin = require(pluginPath); } catch (_) { continue; }
    if (typeof plugin.groupActions !== 'function') continue;
    let synth;
    try { synth = plugin.groupActions(group, groupPath, config) || {}; } catch (_) { continue; }
    Object.assign(result, synth);
  }
  return { ...result, ...((group && group.actions) || {}) };
}

/**
 * Walk groups → actions and yield { path, action } records. Plugin-
 * synthesized actions appear alongside YAML ones via `_mergeForGroup`.
 */
function* iterActions(config) {
  const groups = (config && config.groups) || {};
  for (const [groupPath, group] of Object.entries(groups)) {
    const actions = _mergeForGroup(group, groupPath, config);
    for (const [key, action] of Object.entries(actions)) {
      yield { path: `${groupPath}:${key}`, action };
    }
  }
}

/** Bare path listing — used in error stderr to suggest valid targets. */
function listActions(config) {
  const lines = [];
  for (const { path } of iterActions(config)) lines.push(`  ${path}`);
  return lines.length ? lines.join('\n') : '  (no YAML actions found)';
}

/**
 * Verbose listing — column-aligned `path  label  — desc` for --list. Filters
 * by case-insensitive substring against the path if `filter` is provided.
 * Returns the formatted string; caller writes to stdout.
 */
function formatActionList(config, filter) {
  const f = filter ? filter.toLowerCase() : null;
  const rows = [];
  for (const { path, action } of iterActions(config)) {
    if (f && !path.toLowerCase().includes(f)) continue;
    const label = action.label || '';
    const desc = action.desc || '';
    rows.push([path, label, desc]);
  }
  if (!rows.length) {
    return f ? `(no actions matched "${filter}")` : '(no YAML actions found)';
  }
  const pathW = Math.max(...rows.map((r) => r[0].length));
  const labelW = Math.max(...rows.map((r) => r[1].length));
  return rows
    .map(([p, l, d]) =>
      `${p.padEnd(pathW)}  ${l.padEnd(labelW)}${d ? '  — ' + d : ''}`.trimEnd()
    )
    .join('\n');
}

function resolveAction(config, actionPath) {
  const idx = actionPath.indexOf(':');
  if (idx <= 0 || idx === actionPath.length - 1) {
    return { error: `expected <group-path>:<action-key>, got "${actionPath}"` };
  }
  const groupPath = actionPath.slice(0, idx);
  const actionKey = actionPath.slice(idx + 1);
  const group = (config.groups || {})[groupPath];
  if (!group) {
    return { error: `no group at "${groupPath}"` };
  }
  const action = _mergeForGroup(group, groupPath, config)[actionKey];
  if (!action) {
    return { error: `group "${groupPath}" has no action "${actionKey}"` };
  }
  return { groupPath, actionKey, action };
}

/**
 * Run an action by qualified path. Returns a Promise that resolves with
 * the subprocess exit code; the caller is expected to call process.exit.
 */
function runCli(configPath, actionPath, actionArgs) {
  // T18 — friendly one-line error matching tui.js's T12 pattern.
  // Pre-fix loadConfig leaked a 10-line ParseError stack to stderr;
  // programmatic callers couldn't grep for `tui --exec:` consistently.
  try { loadConfig(configPath); }
  catch (e) { process.stderr.write(`tui --exec: ${e.message}\n`); return Promise.resolve(1); }
  const config = getModel().config;

  const r = resolveAction(config, actionPath);
  if (r.error) {
    process.stderr.write(`tui --exec: ${r.error}\n\nAvailable actions:\n${listActions(config)}\n`);
    return Promise.resolve(1);
  }

  const { action, groupPath, actionKey } = r;
  const type = action.type || 'run';
  if (type !== 'run') {
    process.stderr.write(
      `tui --exec: action "${groupPath}:${actionKey}" has type "${type}"; ` +
      `only "run" is supported in CLI mode (spawn/background detach into terminal windows)\n`
    );
    return Promise.resolve(1);
  }

  const script = action.script || '';
  if (!script) {
    process.stderr.write(`tui --exec: action "${groupPath}:${actionKey}" has empty script\n`);
    return Promise.resolve(1);
  }

  const cwd = config.project_dir
    ? path.resolve(path.dirname(configPath), config.project_dir)
    : path.dirname(path.resolve(configPath));

  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', script, '--', ...actionArgs], {
      cwd,
      stdio: 'inherit',
    });

    // T18 — forward parent's termination signals to the child. With
    // stdio:'inherit', a Ctrl-C at the controlling TTY already
    // reaches both parent and child via the kernel (same process
    // group gets SIGINT). But an out-of-band `kill -INT <parent>`
    // from a supervisor / CI runner / parent shell DOES NOT — parent
    // exits and the child orphans with PPID=1, traps never fire.
    // Forward each signal once; clear the forwarders after exit so
    // we don't reinstall them on subsequent runCli calls (tests).
    const forwarders = {};
    const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const sig of forwarded) {
      forwarders[sig] = () => { try { child.kill(sig); } catch {} };
      process.on(sig, forwarders[sig]);
    }
    const detach = () => {
      for (const sig of forwarded) process.off(sig, forwarders[sig]);
    };

    child.on('exit', (code, signal) => {
      detach();
      if (signal) {
        process.stderr.write(`tui --exec: action terminated by signal ${signal}\n`);
        resolve(128 + (require('os').constants.signals[signal] || 0));
      } else {
        resolve(code === null ? 1 : code);
      }
    });
    child.on('error', (err) => {
      detach();
      process.stderr.write(`tui --exec: spawn failed: ${err.message}\n`);
      resolve(1);
    });
  });
}

/**
 * Print the verbose action list and return 0. Caller is responsible for
 * process.exit; symmetric with runCli().
 */
function runList(configPath, filter) {
  // T18 — symmetric with runCli's loadConfig wrap.
  try { loadConfig(configPath); }
  catch (e) { process.stderr.write(`tui --list: ${e.message}\n`); return Promise.resolve(1); }
  const out = formatActionList(getModel().config, filter);
  process.stdout.write(out + '\n');
  return Promise.resolve(0);
}

module.exports = {
  runCli, runList, resolveAction, listActions, formatActionList,
};
