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
  if (!Array.isArray(list)) return [];
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
    for (const c of comps) out.push(c);
  }
  return out;
}

/**
 * Peek a WAL log for the config carried by its first `set_config` Msg. A msg
 * entry is `{ kind:'msg', lane, msg:{ type, ... } }` (io/session-log +
 * dispatch/runtime/middleware); `set_config` is the first recorded entry of a
 * self-contained WAL. Returns null when absent.
 */
function configFromLog(log) {
  if (!Array.isArray(log)) return null;
  for (const e of log) {
    if (e && e.kind === 'msg' && e.msg && e.msg.type === 'set_config') {
      return e.msg.config || null;
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
