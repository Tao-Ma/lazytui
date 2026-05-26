/**
 * Core plugin — composes the framework's built-in panel types from
 * per-panel-type files. Registered as a single plugin under the name
 * "core" so the framework dogfoods its own plugin API; the per-file
 * split is a structural / readability concern, not a contract change.
 *
 * Adding a new core panel type:
 *   1. Drop a new file in this directory exporting
 *      { panelType, def, decorators? }.
 *   2. Add the require here and append to `mods` below.
 * Removing one is a one-file delete.
 */
'use strict';

const { allPanels } = require('../../state');
const { setTheme, themeNames } = require('../../themes');

const groups       = require('./groups');
const actions      = require('./actions');
const files        = require('./files');     // unified files panel + file-manager/file-browser aliases
const history      = require('./history');
const detail       = require('./detail');
const stats        = require('./stats');

// `files` is an array-mod (multiple panelTypes per file) so the loop
// below has to handle both shapes. Spread up front to keep the loop
// simple: flatten array-mods into a flat list of {panelType, def, …}.
const mods = [groups, actions, ...files, history, detail, stats];

// --- commands (`:` cmdline mode) ---
//
// `quit`, `refresh`, `help` live in the framework default set
// (plugins/api.js#FRAMEWORK_COMMANDS) — they're not panel-type behavior
// and used to force corePlugin to import `../dispatch` and `../cleanup`
// (layer leak). Only the dynamic `theme <name>` / `focus <panel>`
// entries belong here: they depend on runtime state (loaded themes /
// configured panels) and must be synthesized per call.

function getCommands(state) {
  const out = [];
  for (const name of themeNames()) {
    out.push({
      name: `theme ${name}`,
      desc: `Switch to ${name} theme`,
      run: () => { setTheme(name); },
    });
  }
  for (const p of allPanels()) {
    out.push({
      name: `focus ${p.title}`,
      desc: `Focus the ${p.title} panel`,
      run: () => { state.focus = p.type; },
    });
  }
  // Design mode — gated by the same flag as the menu entry. Lazy-require
  // dispatch to avoid a static cycle (dispatch → plugins/api → core).
  if (state.designEnabled) {
    out.push({
      name: 'design',
      desc: 'Open layout design mode',
      run: () => { require('../../dispatch').startDesignMode(); },
    });
  }
  return out;
}

// Compose panelTypes + decorators + commands from each per-file module.
// `commands` is the fixed-verb cmdline-command list — see plugins/api.js
// getCommands(). Combined with the per-call getCommands() above (which
// synthesizes dynamic entries like `theme <name>`), this gives core
// plugin modules a way to register their own `:`-verbs without
// touching this index file's logic.
const corePlugin = {
  name: 'core',
  getCommands,
  panelTypes: {},
  decorators: {},
  commands: [],
};

for (const m of mods) {
  corePlugin.panelTypes[m.panelType] = m.def;
  if (m.decorators) Object.assign(corePlugin.decorators, m.decorators);
  if (Array.isArray(m.commands)) corePlugin.commands.push(...m.commands);
}

module.exports = corePlugin;
