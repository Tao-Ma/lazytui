/**
 * Shared classification for `variadic: true` input ports (Brief 3). The
 * parser enforces at most one variadic port per action and that it is LAST in
 * declaration order (schema.js _validateVariadicConstraints), so every caller
 * agrees on "what the variadic port of this action is" — centralize that
 * agreement here to prevent a v0.6.29-postmortem-class CLI/TUI drift:
 *
 *   - js/app/cli.js --exec       : splits actionArgs at this index.
 *   - js/dispatch/runtime/action-runner.js _splitVariadic
 *                                : removes this port from the env map and
 *                                  routes its items into the argv tail.
 *
 * Pure leaf: no io, no model, data only.
 */
'use strict';

/**
 * Find the variadic input port's name on an action.ports.in map.
 * Returns the string name (always LAST in declaration order per the parser)
 * or null if the action declares no variadic port.
 *
 * portsIn — the `action.ports.in` object (name → pdef). May be null/undefined.
 */
function findVariadicPortName(portsIn) {
  if (!portsIn || typeof portsIn !== 'object') return null;
  const names = Object.keys(portsIn);
  for (let i = 0; i < names.length; i++) {
    const d = portsIn[names[i]];
    if (d && d.variadic === true) return names[i];
  }
  return null;
}

module.exports = { findVariadicPortName };
