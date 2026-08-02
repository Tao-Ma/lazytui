/**
 * Global user config — `~/.config/lazytui/config.yml` (docs/global-config).
 *
 * App-behavior preferences that follow the USER across projects: theme, keys,
 * keymap, mouse, context-menu, selection, editor (schema.GLOBAL_TOP_KEYS).
 * Loaded once at boot by app/state.loadConfig and layered UNDER the project
 * config BEFORE the `set_config` Msg — so the recorded Msg carries the merged
 * result and replay never re-reads the file.
 *
 * Tolerant by contract: a missing file is silently fine; an unreadable or
 * malformed file degrades to project-only with a `{code, message}` warning
 * riding the normal boot-diagnostics path (config.warnings). A broken global
 * file must never brick a project.
 *
 * Path resolution: `LAZYTUI_GLOBAL_CONFIG` overrides (a path; the empty
 * string disables entirely — the test harness sets this for hermeticity),
 * else `$XDG_CONFIG_HOME/lazytui/config.yml`, else
 * `~/.config/lazytui/config.yml`.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { validateGlobal } = require('./schema');

/** Resolved global-config path, or null when disabled / unresolvable. */
function globalConfigPath(env) {
  env = env || process.env;
  if ('LAZYTUI_GLOBAL_CONFIG' in env) {
    const p = env.LAZYTUI_GLOBAL_CONFIG;
    return p ? path.resolve(p) : null;          // '' disables
  }
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(base, 'lazytui', 'config.yml');
}

/**
 * Load + validate the global config. Returns `{ config, warnings }`:
 * `config` is the validated section object (only GLOBAL_TOP_KEYS) or null
 * (disabled / missing / broken); `warnings` is a `{code, message}` list for
 * the boot-diagnostics path. Never throws.
 */
function loadGlobal(env) {
  const warnings = [];
  const p = globalConfigPath(env);
  if (!p || !fs.existsSync(p)) return { config: null, warnings };
  let data;
  try {
    data = yaml.load(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    warnings.push({ code: 'global.unreadable',
      message: `global config ${p}: ${e.message} — ignored` });
    return { config: null, warnings };
  }
  if (data == null) return { config: null, warnings };   // empty file
  try {
    validateGlobal(data, warnings);
  } catch (e) {
    warnings.push({ code: 'global.invalid',
      message: `global config ${p}: ${e.message} — ignored` });
    return { config: null, warnings };
  }
  return { config: data, warnings };
}

/**
 * Layer the global config UNDER the project config (pure; neither input is
 * mutated). Per-section rules:
 *   - keyed sections merge at the ENTRY level — a global binding applies
 *     everywhere unless the project rebinds that same key:
 *       keys, mouse         (flat maps)
 *       keymap              (`normal` merges per key; `version` project-wins)
 *   - `context-menu` is a LIST: global entries first, project's appended
 *   - scalars are wholesale, project-wins: theme, selection, editor
 */
function mergeGlobal(project, global) {
  if (!global) return project;
  const out = { ...project };
  for (const k of ['theme', 'selection', 'editor']) {
    if (!(k in out) && k in global) out[k] = global[k];
  }
  for (const k of ['keys', 'mouse']) {
    if (k in global) out[k] = { ...global[k], ...(out[k] || {}) };
  }
  if ('keymap' in global) {
    const g = global.keymap, p = out.keymap || {};
    out.keymap = {
      ...('version' in p ? { version: p.version }
        : 'version' in g ? { version: g.version } : {}),
      normal: { ...(g.normal || {}), ...(p.normal || {}) },
    };
  }
  if ('context-menu' in global) {
    out['context-menu'] = [...global['context-menu'], ...(out['context-menu'] || [])];
  }
  return out;
}

module.exports = { globalConfigPath, loadGlobal, mergeGlobal };
