/**
 * The built-in Component set, in registration order — the single source of
 * "which Components exist". Both the live boot (app/tui.js) and the replay
 * harness (app/replay-cli.js) register exactly this list, so a Component added
 * here is picked up by replay too (no divergence).
 *
 * The first group OWN state in their slices (genuine isolation — poll loops,
 * browsers, git cache); the rest are stateless Components (empty slice + no-op
 * update) — the API-uniformity tax for ONE panel shape across the view set.
 * See docs/v0.5-layering.md. `layout` is the chrome/frame Component; `detail`
 * (panel/viewer/viewer) is the viewer; `groups` owns the group tree.
 */
'use strict';

const BUILTIN_COMPONENTS = [
  require('../panel/layout'),
  require('../panel/navigator/docker'),
  require('../panel/navigator/config-status'),
  require('../panel/navigator/files'),
  require('../panel/navigator/actions'),
  require('../panel/monitor/stats'),
  require('../panel/navigator/history'),
  require('../panel/viewer/viewer'),   // detail (the viewer)
  require('../panel/navigator/groups'),
];

module.exports = { BUILTIN_COMPONENTS };
