/**
 * Normal-mode keymap (v0.6.7 E9 — dispatch-from-data). Pure, dependency-free
 * bottom-tier leaf.
 *
 * Lets a user remap normal-mode single keys via the YAML `keymap:` block:
 *
 *   keymap:
 *     version: 1            # future-extension hook (see schemaCompat)
 *     normal:               # this release's scope (room later: leader:, modal:)
 *       R: refresh          # bare string = a built-in verb (VERB_CATALOG)
 *       g: { action: grep } # mapping form for an action / command target
 *       ",": noop           # `noop` disables a default
 *
 * This leaf owns the DATA + pure logic: the verb catalog, the default table, the
 * resolver, and the defaults⊕user merge. It holds NO thunks — `dispatch.js` maps
 * each verb name to its dispatch (`NORMAL_VERBS`) and runs the resolved spec. The
 * footer-hint registry (`leaves/input/bindings.js`) is a SEPARATE concern and is
 * untouched.
 *
 * Why a registry: `handleNormalKey`'s hardcoded switch can't be rebound. The
 * cleanly-global, single-dispatch keys move here as data; `handleNormalKey`
 * resolves them through `resolveNormalSpec` before its switch. The keys whose
 * dispatch BRANCHES on focus / mode (return, escape, x, T, v, the nav keys, the
 * `[`/`]` groups-quick fork, the viewer-claimed `/`) stay in the switch and are
 * RESERVED — binding one is a boot error (see dispatch.loadKeymap).
 *
 * AI-authored configs are the common case, so the catalog is the single source
 * for the legal verb set + the `--keymap` dump + docs/keymap.md, and the merge
 * returns actionable error strings an agent can self-correct from.
 */
'use strict';

// Bump when the `keymap:` format changes; see schemaCompat for the policy.
const KEYMAP_VERSION = 1;

// The curated, AI-facing verb catalog: name → one-line summary. SINGLE SOURCE
// for the legal `builtin:` verb set, the `--keymap` dump, and docs/keymap.md.
// `dispatch.js` maps each name → a thunk (`NORMAL_VERBS`); a test asserts the
// two key-sets are identical, so the catalog can't drift from what dispatches.
const VERB_CATALOG = {
  refresh:     "Re-run the focused panel's data source",
  show_help:   'Open the help overlay',
  page_up:     'Scroll the focused panel up one page',
  page_down:   'Scroll the focused panel down one page',
  goto_top:    'Jump to the top of the focused panel',
  goto_bottom: 'Jump to the bottom of the focused panel',
  register:    'Open the yank-register picker',
  cmdline:     'Open the command line',
  copy_mode:   'Enter copy mode (select text to yank)',
};

// Default normal-mode bindings, by context. v1: every default is GLOBAL — the
// verb self-contextualizes (e.g. page_up scrolls whichever panel is focused),
// so there are no per-focus-kind defaults yet. The resolver still walks
// [focusKind, 'global'], so a future context-scoped default is purely additive.
const DEFAULT_NORMAL = {
  global: [
    { key: 'r', spec: { builtin: 'refresh' } },
    { key: '?', spec: { builtin: 'show_help' } },
    { key: ',', spec: { builtin: 'page_up' } },
    { key: '.', spec: { builtin: 'page_down' } },
    { key: '<', spec: { builtin: 'goto_top' } },
    { key: '>', spec: { builtin: 'goto_bottom' } },
    { key: '"', spec: { builtin: 'register' } },
    { key: ':', spec: { builtin: 'cmdline' } },
    { key: 'y', spec: { builtin: 'copy_mode' } },
  ],
};

// `noop` (disable) sentinel returned by _normalizeSpec.
const NOOP = Symbol('keymap.noop');

/**
 * Normalize a raw YAML binding value into a spec (or a sentinel / null):
 *   'verbname'                 → { builtin: 'verbname' }   (the bare-string form)
 *   'noop'                     → NOOP                       (disable a default)
 *   { builtin|action|command } → that one-verb spec (trimmed)
 *   anything else              → null (caller reports a form error)
 */
function _normalizeSpec(raw) {
  if (raw === 'noop') return NOOP;
  if (typeof raw === 'string') return raw.trim() ? { builtin: raw.trim() } : null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const verbs = ['builtin', 'action', 'command'].filter(
      v => typeof raw[v] === 'string' && raw[v].trim());
    if (verbs.length === 1) return { [verbs[0]]: raw[verbs[0]].trim() };
  }
  return null;
}

/**
 * Resolve a key to its binding spec by walking `contexts` most-specific-first
 * (e.g. [focusKind, 'global']). Returns the first matching key's spec, or null
 * (→ the caller falls through to the hardcoded switch). Pure.
 */
function resolveNormalSpec(key, contexts, table) {
  for (const ctx of contexts) {
    const entries = (table && table[ctx]) || [];
    for (const e of entries) if (e.key === key) return e.spec;
  }
  return null;
}

/**
 * Merge a user `normal:` block over the defaults. Pure: returns a NEW table
 * (overrides applied to the `global` context for v1) plus a list of actionable
 * error strings. `noop` removes a binding; a reserved key, an unknown builtin
 * verb, or a malformed value is rejected (with a message naming the valid
 * options). action/command TARGETS are validated by the caller (they need the
 * live config's action set), so only their SHAPE is checked here.
 *
 *   opts: { reservedKeys: Set<string>, legalVerbs: Set<string> }
 */
function mergeUserNormal(defaultTable, userNormal, opts = {}) {
  const reserved = opts.reservedKeys || new Set();
  const legal = opts.legalVerbs || new Set(Object.keys(VERB_CATALOG));
  const errors = [];
  // Deep-copy each carried default's spec so the returned table never aliases
  // into the module-level DEFAULT_NORMAL singleton (the "new table" contract).
  const byKey = new Map((defaultTable.global || []).map(e => [e.key, { key: e.key, spec: { ...e.spec } }]));
  const remappable = () => [...byKey.keys()].join(' ');
  for (const [key, raw] of Object.entries(userNormal || {})) {
    if (reserved.has(key)) {
      errors.push(`keymap: key '${key}' is reserved by a built-in handler and can't be remapped — remappable keys: ${remappable()}`);
      continue;
    }
    if (key === '' || /\s/.test(key)) {
      errors.push(`keymap: key ${JSON.stringify(key)} is not a pressable key (empty or contains whitespace)`);
      continue;
    }
    const spec = _normalizeSpec(raw);
    if (spec === NOOP) { byKey.delete(key); continue; }
    if (!spec) {
      errors.push(`keymap: binding for '${key}' must be a verb name or a {builtin|action|command} mapping (or 'noop' to disable)`);
      continue;
    }
    if (spec.builtin && !legal.has(spec.builtin)) {
      errors.push(`keymap: unknown verb '${spec.builtin}' for key '${key}' — valid verbs: ${[...legal].join(', ')}`);
      continue;
    }
    byKey.set(key, { key, spec });
  }
  return { table: { ...defaultTable, global: [...byKey.values()] }, errors };
}

/**
 * Classify a config's `keymap.version` against this build (mirrors the WAL
 * SCHEMA_VERSION policy — no hard fail): missing → assume current; older/newer →
 * load best-effort with a warning. Returns { compat, message|null }.
 */
function schemaCompat(version) {
  if (version == null) return { compat: 'missing', message: null };
  // Only an actual number (or a numeric string) is a version. Coercing other
  // types — false/[]/{}/'' all Number()→0, [1]→1 — would mis-report a bogus
  // "version 0 < current" instead of "not a number" (review round). The schema
  // already enforces an integer upstream; this is the defensive direct-call path.
  let n = NaN;
  if (typeof version === 'number') n = version;
  else if (typeof version === 'string' && version.trim() !== '') n = Number(version);
  if (!Number.isFinite(n)) {
    return { compat: 'missing', message: `keymap: ignoring non-numeric version ${JSON.stringify(version)}` };
  }
  if (n === KEYMAP_VERSION) return { compat: 'ok', message: null };
  if (n < KEYMAP_VERSION) {
    return { compat: 'older', message: `keymap: config version ${n} < current ${KEYMAP_VERSION} — loading best-effort` };
  }
  return { compat: 'newer', message: `keymap: config version ${n} is NEWER than this build (${KEYMAP_VERSION}) — loading best-effort, some keys may be ignored` };
}

module.exports = {
  KEYMAP_VERSION, VERB_CATALOG, DEFAULT_NORMAL, NOOP,
  _normalizeSpec, resolveNormalSpec, mergeUserNormal, schemaCompat,
};
