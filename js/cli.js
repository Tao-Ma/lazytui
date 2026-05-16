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
 * with `compose:`, future generic plugins like archive / config-branch)
 * are merged into config.groups[*].actions before resolution — YAML
 * wins on conflict, so explicit YAML actions still override the
 * plugin's defaults. The set of plugins consulted here is hard-coded
 * to built-ins that ship with lazytui (BUILT_IN_PLUGINS below); user
 * JS plugins loaded via the YAML `plugins:` map aren't yet consulted
 * in CLI mode and remain TUI-only — straightforward extension when
 * needed.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { S, loadConfig } = require('./state');

// Built-in plugins consulted for `groupActions(group, name)` synthesis.
// Add new generic plugins here as they ship — keeping this list explicit
// (rather than auto-discovering plugins/*.js) avoids accidentally
// pulling render-coupled modules that don't tolerate CLI-mode startup.
const BUILT_IN_PLUGINS = [
  './plugins/docker',
  './plugins/archive',
  './plugins/config-branch',
  './plugins/image-backup',
];

/**
 * Walk every plugin in BUILT_IN_PLUGINS, call its groupActions on each
 * group, and merge the result into config.groups[*].actions. YAML
 * actions are NEVER overwritten (matches the parser's plugin merge
 * rule). Mutates config in place; returns nothing.
 *
 * Failures in any single plugin are swallowed — a broken plugin must
 * never wedge the CLI.
 */
function applyPluginGroupActions(config) {
  const groups = (config && config.groups) || {};
  for (const pluginPath of BUILT_IN_PLUGINS) {
    let plugin;
    try { plugin = require(pluginPath); } catch (_) { continue; }
    if (typeof plugin.groupActions !== 'function') continue;
    for (const [groupPath, group] of Object.entries(groups)) {
      let synth;
      try { synth = plugin.groupActions(group, groupPath, config) || {}; } catch (_) { continue; }
      const keys = Object.keys(synth);
      if (!keys.length) continue;
      group.actions = group.actions || {};
      for (const k of keys) {
        if (!group.actions[k]) group.actions[k] = synth[k];
      }
    }
  }
}

/**
 * Walk groups → actions and yield { path, action } records. Includes
 * plugin-synthesized actions because applyPluginGroupActions is called
 * upstream of this in runCli / runList.
 */
function* iterActions(config) {
  const groups = (config && config.groups) || {};
  for (const [groupPath, group] of Object.entries(groups)) {
    const actions = (group && group.actions) || {};
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
  const action = (group.actions || {})[actionKey];
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
  loadConfig(configPath);
  const config = S.config;
  applyPluginGroupActions(config);

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
    child.on('exit', (code, signal) => {
      if (signal) {
        process.stderr.write(`tui --exec: action terminated by signal ${signal}\n`);
        resolve(128 + (require('os').constants.signals[signal] || 0));
      } else {
        resolve(code === null ? 1 : code);
      }
    });
    child.on('error', (err) => {
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
  loadConfig(configPath);
  applyPluginGroupActions(S.config);
  const out = formatActionList(S.config, filter);
  process.stdout.write(out + '\n');
  return Promise.resolve(0);
}

module.exports = {
  runCli, runList, resolveAction, listActions, formatActionList,
  applyPluginGroupActions,
};
