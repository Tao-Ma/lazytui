/**
 * Inbound dispatch middleware (C7, v0.6.7) — an ordered list of links that wrap
 * every Msg ENTERING the loop, before the reducer runs.
 *
 * A link is `(entry, next) => result`, where `next(entry)` continues the chain
 * (ending in the lane's terminal dispatch). Links run in registration order
 * (first registered = OUTERMOST); the terminal is innermost. A link may:
 *   - observe (call next, return its result),
 *   - transform the entry (the terminal reads the transformed entry),
 *   - wrap with try/catch or timing.
 *
 * Contract (by convention — see docs/v0.6.7.md):
 *   - a link MUST NOT dispatch (no applyMsg/dispatchMsg from a link — emit a Cmd
 *     instead, so the @32 cross-layer cap stays consistent);
 *   - a link MUST NOT do non-replay-safe IO. The one sanctioned "IO-ish" link is
 *     the WAL record, which self-gates on session-log._enabled (so it is inert on
 *     replay) — replay-neutrality is the LINK's property, not the seam's.
 *
 * `entry` shapes: `{ lane:'root'|'comp', msg }` | `{ lane:'key', key, seq }`.
 *
 * This is the ONE inbound seam. Outbound concerns (the post-dispatch finalizer +
 * the instance/subscription reconcilers) stay where they are — they have a
 * different cardinality (once per outermost dispatch, not per Msg), phase
 * (post-commit, re-enters the loop), and replay treatment (deliberately gated).
 * It replaces the 3 hardcoded `sessionLog.recordMsg` calls that were previously
 * the only inbound tap (loop.js).
 *
 * The chain is composed ONCE per terminal fn (the 3 lane terminals are stable
 * module-level fns in ./loop), cached by terminal identity, rebuilt on use().
 * Steady state: 2 links wrapping a direct call — negligible on the hot path.
 *
 * Layer: dispatch/runtime; requires io leaves (session-log, event-log) — legal
 * down-edges, the same ones ./loop already used for the record calls.
 */
'use strict';

const sessionLog = require('../../io/session-log');

let _links = [];
let _cache = new WeakMap();   // terminal fn → composed (entry) => result

/** Register a link. Ordered: first registered runs outermost. Boot-time only. */
function use(link) { _links.push(link); _cache = new WeakMap(); }

/**
 * Run `entry` through the link chain, terminating in `terminal(entry)`.
 * `terminal` must be a STABLE fn (cached by identity); ./loop's three lane
 * terminals are module-level singletons for exactly this reason.
 */
function run(entry, terminal) {
  if (_links.length === 0) return terminal(entry);
  let composed = _cache.get(terminal);
  if (!composed) {
    // reduceRight: accumulator starts as terminal (innermost); first-registered
    // link ends up outermost. composed(entry) = link0(entry, link1(entry, term)).
    composed = _links.reduceRight((next, link) => (e) => link(e, next), terminal);
    _cache.set(terminal, composed);
  }
  return composed(entry);
}

// ——— Built-in links ————————————————————————————————————————————————————

/**
 * Crash reporter — OUTERMOST (registered first). The root-reducer path
 * (applyMsg) has no other try/catch, so a thrown reducer would otherwise crash
 * the process uninspected. Stamp the offending entry + error + recent WAL tail
 * into the event log (post-mortem repro context), then RE-THROW — observe, don't
 * change control flow. (The Component paths already catch per-instance in ./loop;
 * this adds the root path + a unified forensic record.)
 */
function crashReporterLink(entry, next) {
  try { return next(entry); }
  catch (e) {
    try {
      require('../../io/event-log').record('dispatch_crash', {
        lane: entry.lane,
        msg: entry.msg || { key: entry.key, seq: entry.seq },
        message: e && e.message,
        stack: e && e.stack,
        walTail: sessionLog.snapshot().slice(-20),
      });
    } catch (_) { /* event-log unavailable — let the throw carry the info */ }
    throw e;
  }
}

/**
 * WAL record — INNERMOST (registered last), so it records the POST-transform
 * entry (what actually gets dispatched). Self-gates: session-log.record no-ops
 * when disabled (the default, and during replay folds), so this is the same
 * near-zero-cost tap the 3 hardcoded recordMsg calls were.
 */
function recordLink(entry, next) {
  sessionLog.recordMsg(entry.lane === 'key'
    ? { lane: 'key', key: entry.key, keySeq: entry.seq }
    : { lane: entry.lane, msg: entry.msg });
  return next(entry);
}

function installBuiltins() {
  use(crashReporterLink);   // outermost
  use(recordLink);          // innermost
}

// Test seam — clear the link list (test files run in isolated processes, so this
// can't leak; restore with installBuiltins()).
function _reset() { _links = []; _cache = new WeakMap(); }

installBuiltins();

module.exports = { use, run, installBuiltins, _reset, crashReporterLink, recordLink };
