/**
 * Event hub — single in-process pub/sub data bus that decouples
 * producers (plugins that collect data) from consumers (panels and other
 * plugins that render it). Spec: HUB.md.
 *
 * Storage shape: per-(topic, rowKey) ring buffer, sized by the max
 * `window` across all subscribers matching the topic (literal or
 * wildcard). Zero subscribers → publish drops; cost scales with
 * what's rendered, not what's possible.
 *
 * Zero npm dependencies; pure JS.
 */
'use strict';

// --- Internal state ---

const buffers = new Map();      // topic -> Map<rowKey, sample[]>
const schemas = new Map();      // topic -> { rowKey?, columns? }
const subs = [];                // [{ token, pattern, isWildcard, prefix, window, onUpdate }]
let nextToken = 1;

// Cache of effective window per topic (max across matching subs). Recomputed
// on subscribe/unsubscribe; lookup is hot in publish so we don't want to
// rescan subs[] every call.
const windowCache = new Map();  // topic -> number

// --- Pattern matching ---

/**
 * Subscribers can be either a literal topic name or a wildcard ending in
 * `.*` which matches any topic that starts with the given prefix.
 *   'docker.stats'    matches exactly that topic
 *   'docker.stats.*'  matches 'docker.stats.X' for any X (NOT 'docker.stats')
 *   'docker.*'        matches 'docker.stats', 'docker.events', etc.
 */
function parsePattern(pattern) {
  if (pattern.endsWith('.*')) {
    return { isWildcard: true, prefix: pattern.slice(0, -1) }; // keeps trailing dot
  }
  return { isWildcard: false, prefix: pattern };
}

function matches(sub, topic) {
  if (sub.isWildcard) return topic.startsWith(sub.prefix);
  return sub.prefix === topic;
}

// --- Window cache ---

/**
 * Recompute the cached effective window for a topic. Called on subscribe
 * and unsubscribe; never on hot publish path.
 */
function recomputeWindow(topic) {
  let max = 0;
  for (const sub of subs) {
    if (matches(sub, topic)) {
      if (sub.window > max) max = sub.window;
    }
  }
  if (max === 0) windowCache.delete(topic);
  else windowCache.set(topic, max);
}

/**
 * Recompute every known topic's window (after a wildcard sub change that
 * could affect any number of topics). Cheap because both maps are small.
 */
function recomputeAllWindows() {
  const known = new Set([...buffers.keys(), ...schemas.keys()]);
  // Also pre-seed cache for literal subscribers so a topic with no prior
  // publish still reports a window > 0 (lets the first publish allocate).
  for (const sub of subs) {
    if (!sub.isWildcard) known.add(sub.prefix);
  }
  for (const topic of known) recomputeWindow(topic);
}

// --- Producer API ---

/**
 * Publish a sample. Drops silently if no subscriber wants this topic.
 * Trims the per-row ring buffer to the cached window. Fires onUpdate
 * callbacks for matching subscribers (sync — subscribers must not block).
 *
 * `rowKey` may be null/undefined for single-stream topics; normalized to
 * '_' (the spec convention) so all storage paths use one shape.
 */
function publish(topic, rowKey, sample) {
  // Event log (PRINCIPLES.md §11 + CHANGELOG v0.2.0). Record before
  // the retention/dedup branches so the recording reflects every
  // publish call as the producer saw it — even ones that the hub
  // drops because no subscribers ask for the topic.
  require('./event-log').record('publish', { topic, rowKey, sample });
  // Component Msg dispatch (v0.3.0). Hub publishes fan out to every
  // Component's update() as a 'hub' Msg.
  require('./components/api').dispatchMsg({ type: 'hub', topic, rowKey, sample });
  // Wildcard subscriptions don't pre-populate the cache for topics they'd
  // match (the topic name isn't known until first publish). Compute on
  // demand and cache so the second publish is hot.
  let window = windowCache.get(topic);
  if (window === undefined) {
    window = 0;
    for (const sub of subs) {
      if (matches(sub, topic) && sub.window > window) window = sub.window;
    }
    if (window > 0) windowCache.set(topic, window);
  }
  if (window === 0) return;
  const rk = rowKey == null ? '_' : String(rowKey);
  let topicBuf = buffers.get(topic);
  if (!topicBuf) { topicBuf = new Map(); buffers.set(topic, topicBuf); }
  let rowBuf = topicBuf.get(rk);
  if (!rowBuf) { rowBuf = []; topicBuf.set(rk, rowBuf); }
  rowBuf.push(sample);
  while (rowBuf.length > window) rowBuf.shift();
  // Notify subscribers (literal + wildcard) — sync, see HUB.md §13.
  for (const sub of subs) {
    if (sub.onUpdate && matches(sub, topic)) {
      try { sub.onUpdate(topic, rk, sample); }
      catch (e) { console.error(`[hub] onUpdate error: ${e.message}`); }
    }
  }
}

/** Optionally declare a topic's row-key dimension and column shape. */
function defineTopic(topic, schema) {
  schemas.set(topic, schema || {});
}

/**
 * Producer-driven row removal. The hub doesn't GC by itself — the
 * producer knows when a row's identity is gone (container destroyed,
 * process exited) and clears it explicitly.
 */
function deleteRow(topic, rowKey) {
  const rk = rowKey == null ? '_' : String(rowKey);
  const topicBuf = buffers.get(topic);
  if (!topicBuf) return;
  topicBuf.delete(rk);
  if (topicBuf.size === 0) buffers.delete(topic);
}

// --- Consumer API ---

/**
 * Subscribe to a topic or wildcard pattern. Returns a token to pass to
 * unsubscribe(). `opts.window` (default 1) sets retention; `opts.onUpdate`
 * is an optional sync callback fired on publish.
 */
function subscribe(pattern, opts = {}) {
  const { isWildcard, prefix } = parsePattern(pattern);
  const sub = {
    token: nextToken++,
    pattern, isWildcard, prefix,
    window: opts.window || 1,
    onUpdate: opts.onUpdate || null,
  };
  subs.push(sub);
  if (isWildcard) recomputeAllWindows();
  else recomputeWindow(prefix);
  return sub.token;
}

function unsubscribe(token) {
  const idx = subs.findIndex(s => s.token === token);
  if (idx < 0) return;
  const [removed] = subs.splice(idx, 1);
  if (removed.isWildcard) {
    recomputeAllWindows();
    // Trim any over-window buffers now that retention may have shrunk.
    for (const [topic, topicBuf] of buffers) {
      const w = windowCache.get(topic) || 0;
      for (const rowBuf of topicBuf.values()) {
        while (rowBuf.length > w) rowBuf.shift();
      }
    }
  } else {
    recomputeWindow(removed.prefix);
    const topicBuf = buffers.get(removed.prefix);
    if (topicBuf) {
      const w = windowCache.get(removed.prefix) || 0;
      for (const rowBuf of topicBuf.values()) {
        while (rowBuf.length > w) rowBuf.shift();
      }
    }
  }
}

/**
 * Time-series read: history of one row. Newest last. `limit` defaults to
 * the full retained window. Returns [] if topic/row unknown.
 */
function history(topic, rowKey, limit) {
  const rk = rowKey == null ? '_' : String(rowKey);
  const topicBuf = buffers.get(topic);
  if (!topicBuf) return [];
  const rowBuf = topicBuf.get(rk);
  if (!rowBuf) return [];
  if (limit == null || limit >= rowBuf.length) return rowBuf.slice();
  return rowBuf.slice(rowBuf.length - limit);
}

/**
 * Snapshot read: latest sample per row. Returns Map<rowKey, sample>.
 * Native shape for table panels.
 */
function snapshot(topic) {
  const out = new Map();
  const topicBuf = buffers.get(topic);
  if (!topicBuf) return out;
  for (const [rk, rowBuf] of topicBuf) {
    if (rowBuf.length) out.set(rk, rowBuf[rowBuf.length - 1]);
  }
  return out;
}

/**
 * Matrix read: per-row history. Returns Map<rowKey, samples[]>.
 * Native shape for time-series-grid visualizations (multi-line graphs,
 * per-row inline bars, etc.).
 */
function matrix(topic, limit) {
  const out = new Map();
  const topicBuf = buffers.get(topic);
  if (!topicBuf) return out;
  for (const [rk, rowBuf] of topicBuf) {
    if (limit == null || limit >= rowBuf.length) out.set(rk, rowBuf.slice());
    else out.set(rk, rowBuf.slice(rowBuf.length - limit));
  }
  return out;
}

// --- Introspection ---

function topics() {
  // Union of topics seen in publish + topics declared via defineTopic.
  return [...new Set([...buffers.keys(), ...schemas.keys()])];
}

function schema(topic) {
  return schemas.get(topic) || null;
}

// --- Test-only reset (used by smoke test; not exported via the public hub) ---
function _reset() {
  buffers.clear();
  schemas.clear();
  subs.length = 0;
  windowCache.clear();
  nextToken = 1;
}

module.exports = {
  publish, defineTopic, delete: deleteRow,
  subscribe, unsubscribe,
  history, snapshot, matrix,
  topics, schema,
  _reset,
};
