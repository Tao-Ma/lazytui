/**
 * Mouse gesture → intent bindings (v0.6.4 Theme F Phase 4) — the pointer
 * analogue of the leader-key `keys:` registry. The default table lives
 * here in code; a top-level YAML `mouse:` block overrides it, exactly as
 * `keys:` overrides the built-in chords:
 *
 *   mouse:
 *     double-click: activate
 *     right-click:  context
 *     middle-click:  noop      # reserved today
 *     double-click-ms: 250     # the same-cell window, tunable
 *
 * The override surface is the **gesture → intent edge** (not gesture → Msg):
 * configs bind to stable semantic intents, the same way `keys:` binds to
 * verbs, so internal Msg renames never break a config. `dispatch/input.js`
 * reads `intentFor(gesture)` when resolving a discrete button gesture, and
 * the SGR parser reads `doubleClickMs()` for the double-tap window.
 *
 * Dependency-free leaf — no requires. `configure()` is called once at boot
 * (tui.js, after the config is parsed + schema-validated, so values here are
 * already well-typed). Schema validation (parser/schema.js validateMouse)
 * is the gate; this module trusts its input and only fills defaults.
 */
'use strict';

// Default gesture → intent map. Only the three discrete button gestures
// are bound (left-click stays focus+select and the wheel stays scroll —
// both hardcoded in input.js, not yet exposed for override). `noop` is the
// reserved-but-inert intent. Frozen so a caller can't mutate the baseline.
const DEFAULTS = Object.freeze({
  'double-click': 'activate',
  'right-click':  'context',
  'middle-click': 'noop',
});
const DEFAULT_DOUBLE_CLICK_MS = 250;

let _intents = { ...DEFAULTS };
let _doubleClickMs = DEFAULT_DOUBLE_CLICK_MS;

/**
 * Merge a parsed `mouse:` block over the code defaults. Absent / null
 * block → pure defaults. Idempotent: always rebuilds from DEFAULTS, so a
 * second call with a smaller block doesn't retain the first call's keys.
 */
function configure(mouseBlock) {
  _intents = { ...DEFAULTS };
  _doubleClickMs = DEFAULT_DOUBLE_CLICK_MS;
  if (!mouseBlock || typeof mouseBlock !== 'object') return;
  for (const g of Object.keys(DEFAULTS)) {
    if (g in mouseBlock) _intents[g] = mouseBlock[g];
  }
  if ('double-click-ms' in mouseBlock) _doubleClickMs = mouseBlock['double-click-ms'];
}

/** The intent a gesture is bound to ('activate' | 'context' | 'noop' | …).
 *  Unknown gesture → 'noop' (inert), never undefined. */
function intentFor(gesture) {
  return _intents[gesture] || 'noop';
}

/** The same-cell double-click window in ms (read by the SGR parser). */
function doubleClickMs() {
  return _doubleClickMs;
}

/** Reset to defaults — for tests that called configure(). */
function reset() {
  configure(null);
}

module.exports = {
  configure, intentFor, doubleClickMs, reset,
};
