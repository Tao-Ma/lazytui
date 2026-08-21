'use strict';
/**
 * External (consumer-authored) Component loading — the config-declared
 * expansion path.
 *
 * A project lists Component module paths under the top-level `components:` key;
 * lazytui `require()`s each and registers it alongside the built-ins, so a
 * consumer keeps their Components in *their own* project without editing the
 * framework tree. This is the "new panel type" half of user expansion — the
 * replacement for the retired runtime Plugin API (docs/PLUGINS.md,
 * docs/PROJECT.md). The declarative YAML half (built-in panel types, actions,
 * metrics, themes) needs no code and is unaffected.
 *
 * Paths are resolved to absolute at PARSE time (parser/index.js) against the
 * config's `project_dir`, so the resolved config — and therefore the recorded
 * WAL's `set_config` Msg — carries absolute module paths. That is what gives
 * replay parity: the replay harness peeks the WAL's config and registers the
 * identical set (`configFromLog` + `registerExternal`), the same single-source
 * discipline app/components.js gives the built-ins. The module JS itself is not
 * stored in the WAL, so faithful replay needs the modules present at their
 * recorded paths — a same-machine/checkout guarantee, a cross-machine caveat.
 */

/**
 * Resolve + require the Components declared in `config.components`. A module may
 * export a single Component or an array of them; the result is flattened.
 *
 * Throws a composed Error naming the offending entry on any load failure — a
 * declared component is explicit intent, so the live boot fails loud rather than
 * silently degrading (the caller decides whether to abort or diagnose).
 */
function externalComponents(config) {
  const list = (config && config.components) || [];
  // Fail loud on a present-but-malformed value. The YAML parser already
  // validates this (schema.js), but a `.json` config bypasses the parser, so
  // guard here too rather than silently ignore.
  if (!Array.isArray(list)) {
    throw new Error(`components: must be a list of module paths (got ${typeof list})`);
  }
  const out = [];
  for (const spec of list) {
    if (typeof spec !== 'string' || !spec) {
      throw new Error(`components: entry must be a non-empty string (got ${JSON.stringify(spec)})`);
    }
    let mod;
    try {
      mod = require(spec);
    } catch (e) {
      throw new Error(`components: cannot load '${spec}': ${e.message}`);
    }
    const comps = Array.isArray(mod) ? mod : [mod];
    for (const c of comps) {
      // A module that LOADS but isn't a valid Component would otherwise be
      // silently dropped by registerComponent's skip-on-invalid guard — which
      // contradicts "a declared component fails loud". Validate the shape here
      // (same contract registerComponent enforces) and throw, naming the entry.
      if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name ||
          typeof c.init !== 'function' || typeof c.update !== 'function') {
        throw new Error(`components: '${spec}' did not export a valid Component (need { name, init, update })`);
      }
      out.push(c);
    }
  }
  return out;
}

/**
 * Peek a WAL log for the config that declares its external Components. A msg
 * entry is `{ kind:'msg', lane, msg:{ type, ... } }` (io/session-log +
 * dispatch/runtime/middleware); a from-boot `--record-save` WAL leads with a
 * `set_config` Msg carrying the resolved config. Returns null when neither a
 * set_config Msg nor a config-bearing checkpoint is present.
 *
 * FALLBACK — a checkpoint-first WAL (the in-session `:record-save` verb
 * checkpoints THEN streams, so there is NO set_config Msg) still carries the
 * full model inside a `checkpoint` entry's encoded `.state`
 * (`replay.snapshotState()` snapshots `getModel()`, so `state.model.config`
 * holds the same resolved `components:` list). Without this fallback, an
 * in-session-recorded session silently loses its external panels on replay
 * (blank panes, no crash) — the parity hole this closes.
 */
function configFromLog(log) {
  if (!Array.isArray(log)) return null;
  for (const e of log) {
    if (e && e.kind === 'msg' && e.msg && e.msg.type === 'set_config') {
      return e.msg.config || null;
    }
  }
  // No set_config Msg — read the config from the first config-bearing checkpoint.
  for (const e of log) {
    if (e && e.kind === 'checkpoint' && e.state) {
      let snap;
      try { snap = require('../io/session-log').decodeJson(e.state); }
      catch (_) { continue; }   // unreadable checkpoint — try the next
      const cfg = snap && snap.model && snap.model.config;
      if (cfg) return cfg;
    }
  }
  return null;
}

/**
 * Register every external Component declared in `config` through the given
 * `registerComponent`. Shared by the live boot (app/tui.js) and the replay
 * harness (app/replay-cli, dispatch/runtime/replay-control, app/dev-console) so
 * replay registers the identical set. Errors propagate — the caller picks the
 * policy (boot = fail loud; replay = best-effort diagnostic).
 */
function registerExternal(config, registerComponent) {
  for (const comp of externalComponents(config)) registerComponent(comp);
}

module.exports = { externalComponents, configFromLog, registerExternal };
