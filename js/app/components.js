/**
 * The built-in Component set, in registration order — the single source of
 * "which Components exist". Both the live boot (app/tui.js) and the replay
 * harness (app/replay-cli.js) register exactly this list, so a Component added
 * here is picked up by replay too (no divergence).
 *
 * The first group OWN state in their slices (genuine isolation — poll loops,
 * browsers, git cache); the rest are stateless Components (empty slice + no-op
 * update) — the API-uniformity tax for ONE panel shape across the view set.
 * See docs/v0.5-layering.md. `layout` is the chrome/frame Component; `groups`
 * owns the group tree. The former `detail`/viewer Component is gone (U2f): the
 * content slot is a position-tab container whose default tab is an `info` pane
 * (+ a `text-view` Transcript), identified by `pane.role === 'content'`.
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
  require('../panel/navigator/groups'),
  require('../panel/fabric/ports-pane'),   // component-ports (dataflow fabric, P1.5)
  require('../panel/fabric/wire-list'),    // fabric-wires (global edge view, P1.5)
  require('../panel/text-view/text-view'), // text-view (mint-into-slot, U2b)
  require('../panel/terminal/terminal'),   // terminal (PTY as a pane, U2d)
  require('../panel/info/info'),           // info (viewer's Info tab as a pane, U2e)
  require('../panel/agent/agent'),         // agent (live-agent chat pane, docs/live-agent.md)
];

module.exports = { BUILTIN_COMPONENTS };
