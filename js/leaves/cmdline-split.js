/**
 * Split a `:` cmdline buffer at the first whitespace into the fuzzy-
 * match query and the positional args. Same regex as the prior
 * cmdline.js#splitQuery / runtime.js#_cmdlineSplit — extracted to a
 * leaf so both can import from one home (cmdline.js requires runtime
 * indirectly via panel/api; importing it back to runtime.js would
 * cycle, hence the pre-v0.6.x duplicate).
 *
 *   splitQuery("focus groups")     → { query: "focus", args: ["groups"] }
 *   splitQuery("save-layout")      → { query: "save-layout", args: [] }
 *   splitQuery(":noargs   ")       → { query: ":noargs", args: [] }
 *
 * Whitespace-only sep, no quote handling — users wanting "one arg with
 * spaces" can collapse in the action's script body. Zero deps.
 */
'use strict';

function splitQuery(text) {
  const m = text.match(/^(\S*)\s+(.*)$/);
  if (!m) return { query: text, args: [] };
  const rest = m[2].trim();
  return { query: m[1], args: rest ? rest.split(/\s+/) : [] };
}

// Visible row count of the `:` cmdline match dropdown. The reducer
// scrolls the viewport so the selected match stays in view; the
// renderer paints the same window. Shared from this leaf so the
// reducer (app/runtime) and the overlay paint (overlay/cmdline) can
// never drift out of sync.
const DROPDOWN_VIEWPORT = 8;

module.exports = { splitQuery, DROPDOWN_VIEWPORT };
