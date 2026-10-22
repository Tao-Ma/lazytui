/**
 * The built-in groupAction-contributing feature plugins — the SINGLE source of
 * "which feature modules synthesize per-group actions."
 *
 * These modules export only `{ name, groupActions }`: they are NOT Components
 * (no `init`/`update`/`panelTypes`), so they are not registered via
 * `app/components.js` BUILTIN_COMPONENTS, and `registerComponent` rejects them.
 * Both execution paths consume THIS list so they can never drift:
 *   - the TUI registers them via `api.registerGroupActionPlugin` at boot
 *     (app/tui.js + app/replay-cli.js), so `api.getGroupActions` resolves them
 *     alongside the Component registry;
 *   - the CLI merges them in `app/cli.js` `_mergeForGroup` (Components aren't
 *     booted in CLI mode).
 *
 * (docker is NOT here — it is a real Component whose groupActions ride the
 * Component registry in the TUI; the CLI merges it separately.)
 */
'use strict';

module.exports = [
  require('./archive'),
  require('./config-branch'),
  require('./image-backup'),
];
