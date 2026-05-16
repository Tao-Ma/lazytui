/**
 * Decorator framework — slot-based plugin extension for any UI surface.
 * Spec: DECORATORS.md.
 *
 * Slots are named strings (`row:containers`, `footer:right`, etc.).
 * Plugins register handlers by exporting a `decorators` map keyed by
 * slot. At plugin-load time, plugins/api.js calls `register()` for each
 * entry. At render time, renderers call `decorate(slot, ctx)` and append
 * the result to whatever they're already rendering.
 *
 * Hard performance requirement: a slot with zero registered handlers
 * costs one Map.get + one falsiness check per call. No allocation. No
 * iteration. The empty-registry path is the hot path because most users
 * use few decorators on most slots.
 *
 * Zero npm dependencies; pure JS.
 */
'use strict';

const { visibleLen } = require('./ansi');

// Registry: slot name → handler[]. Entries are { fn, plugin } so we can
// emit per-plugin error messages. Empty by default — no slot has an
// allocation until something subscribes.
const registry = new Map();

// Slot composition rules. Slots not listed here use the row default
// (single space, append).
const COMPOSITION = {
  'row:*':       { sep: ' ',     reverse: false },
  'title:*':     { sep: ', ',    reverse: false },
  'tab:*':       { sep: ' ',     reverse: false },
  'footer:left': { sep: ' │ ',   reverse: false },
  'footer:right':{ sep: ' │ ',   reverse: true  },  // renderer aligns right
};

function compositionFor(slot) {
  if (COMPOSITION[slot]) return COMPOSITION[slot];
  // Match prefix patterns like 'row:containers' → 'row:*'.
  const colon = slot.indexOf(':');
  if (colon > 0) {
    const wild = slot.slice(0, colon + 1) + '*';
    if (COMPOSITION[wild]) return COMPOSITION[wild];
  }
  return { sep: ' ', reverse: false };  // sensible default
}

/**
 * Register a handler for a slot. Called once per slot per plugin during
 * plugin load. `pluginName` is used for error reporting only.
 *
 * Returns an unregister token (a unique object) — pass to unregister()
 * to remove. Mostly useful for testing; production plugins are expected
 * to register at load time and stay.
 */
function register(slot, fn, pluginName) {
  if (typeof fn !== 'function') {
    console.error(`[decorators] handler for '${slot}' (plugin '${pluginName}') is not a function; ignored`);
    return null;
  }
  let handlers = registry.get(slot);
  if (!handlers) { handlers = []; registry.set(slot, handlers); }
  const entry = { fn, plugin: pluginName || '<unknown>' };
  handlers.push(entry);
  return entry;
}

function unregister(token) {
  if (!token) return;
  for (const [slot, handlers] of registry) {
    const i = handlers.indexOf(token);
    if (i >= 0) {
      handlers.splice(i, 1);
      if (handlers.length === 0) registry.delete(slot);
      return;
    }
  }
}

/**
 * Compose decoration text for a slot. Returns '' if no handlers
 * registered for the slot — the hot path. Otherwise iterates handlers,
 * collects their output, sorts by weight, joins with the slot's
 * separator, and truncates to ctx.width if specified.
 *
 * Handlers that throw are reported and skipped — one buggy decorator
 * doesn't break the whole row.
 */
function decorate(slot, ctx) {
  const handlers = registry.get(slot);
  if (!handlers) return '';                // hot path: empty slot
  if (handlers.length === 0) return '';    // (defensive — register cleans empty)

  const items = [];
  for (const entry of handlers) {
    let result;
    try { result = entry.fn(ctx); }
    catch (e) {
      console.error(`[decorators:${entry.plugin}] '${slot}' handler error: ${e.message}`);
      continue;
    }
    if (result == null || result === '') continue;
    if (typeof result === 'string') {
      items.push({ text: result, weight: 0 });
    } else if (typeof result === 'object' && typeof result.text === 'string') {
      if (result.text === '') continue;
      items.push({ text: result.text, weight: result.weight || 0 });
    }
  }

  if (items.length === 0) return '';

  // Stable sort by weight ascending. JS Array.sort is stable as of ES2019.
  items.sort((a, b) => a.weight - b.weight);

  const comp = compositionFor(slot);
  let parts = items.map(i => i.text);
  if (comp.reverse) parts = parts.reverse();
  let out = parts.join(comp.sep);

  // Outer truncate as a safety net — handlers SHOULD self-clip via
  // ctx.width but we don't trust them to.
  if (ctx && typeof ctx.width === 'number' && ctx.width > 0) {
    if (visibleLen(out) > ctx.width) {
      // Drop characters from the right until it fits. Cheap rather than
      // rigorous (markup-aware truncation lives in panel.js#truncate
      // for the row-line case; we don't want to recurse into that here).
      out = out.slice(0, Math.max(0, ctx.width - 1)) + '…';
    }
  }
  return out;
}

/**
 * Iterate registered slots — for `:decorators list` style introspection.
 * Returns Map<slot, plugin[]>.
 */
function slots() {
  const out = new Map();
  for (const [slot, handlers] of registry) {
    out.set(slot, handlers.map(h => h.plugin));
  }
  return out;
}

/**
 * Test-only: clear the registry. Not exported in the typical require
 * destructure; smoke tests call this between cases.
 */
function _reset() {
  registry.clear();
}

module.exports = { register, unregister, decorate, slots, _reset };
