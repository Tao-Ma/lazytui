/**
 * Runtime for computed port choices (`choices_fn:` in YAML, args→ports slice 2).
 *
 * Owns the `fetch_choices` effect: resolves the dotted ref against the api
 * registry, invokes the fn with its context + AbortSignal, awaits, normalizes
 * the return into a structured payload, and dispatches
 * `fabric_form_choices_resolved` back through applyMsg.
 *
 * The fn is a side-effect from the reducer's point of view — it may touch the
 * fs / spawn / await the network. The reducer stays pure: the fetch rides the
 * effect channel, its RESULT lands as a reducer arm whose payload is captured
 * in the WAL, and replay reproduces frames from the recorded arm WITHOUT
 * re-executing the fn (sibling discipline of the stream.js output path).
 *
 * Signature (what a component author writes):
 *
 *   choicesFns: {
 *     sections_of: async ({ values, actionKey, group, signal }) => {
 *       // ...read fs, spawn, hit a local index, whatever
 *       return ['intro', 'body', 'outro'];   // or a structured return
 *     },
 *   }
 *
 * Accepted return shapes (normalized here, not in the author's code):
 *   - `string[]`                              → { items, labels: null, error: null }
 *   - `{ items: string[], labels?: string[], error?: string }`
 *   - a Promise of either of the above
 *   - `undefined` / `null`                    → { items: [], ... } (empty list, no error)
 *
 * Anything else — a thrown exception, a non-string entry in items, a rejection
 * — is captured as `error` on the resolved payload. The form overlay paints
 * `[error]` and surfaces the message in the field's desc row; the user can
 * still free-type a value (choices_fn is a shortcut, never a hard constraint).
 *
 * Replay-determinism:
 *   The effect handler is skipped on replay (runEffects early-returns under
 *   `replay.isReplaying()`); the recorded `fabric_form_choices_resolved` arm
 *   replays verbatim with its captured items/labels/error. The fn is executed
 *   at live time only, so its output can't drift on re-execution.
 *
 * Stale-reply guard:
 *   Each fetch carries a monotonic `requestId`. The reducer stores the current
 *   requestId on the field; a resolved msg whose requestId no longer matches
 *   is dropped. The effect's `key` ties into the C5 keyed-effects registry so
 *   a dependency change aborts the prior fetch's AbortSignal, but a resolved
 *   msg that lands after abort would still be dropped by the requestId guard.
 *
 * Test hook:
 *   `__setChoicesFn(ref, fn)` writes directly into the api registry — unit
 *   tests mock a fn without going through YAML + feature-plugin boot. Same
 *   discipline as every other test shim in the codebase (prefix `__`).
 */
'use strict';

// Injected lookup — set at boot by `dispatch/runtime/effects.js` which pulls
// from `panel/api.getChoicesFn`. We don't require panel/ directly: feature/
// sits BELOW panel/ in the layer DAG, so an upward require (even deferred)
// would fail the test-dep-layering gate. Same seam pattern as feature-host.
let _lookup = null;
function setRegistryHost(host) { _lookup = host && host.getChoicesFn; }
function _getChoicesFn(ref) { return _lookup ? _lookup(ref) : null; }

// Normalize a (possibly-async) fn return into the resolved-arm payload shape.
// Pure, no I/O; callable from unit tests without the effect wrapper.
function normalizeResult(raw) {
  if (raw == null) return { items: [], labels: null, error: null };
  if (Array.isArray(raw)) {
    const items = raw.filter((v) => typeof v === 'string');
    return { items, labels: null, error: null };
  }
  if (typeof raw === 'object') {
    const items = Array.isArray(raw.items) ? raw.items.filter((v) => typeof v === 'string') : [];
    const labels = Array.isArray(raw.labels)
      ? raw.labels.slice(0, items.length).map((v) => (typeof v === 'string' ? v : ''))
      : null;
    const error = typeof raw.error === 'string' && raw.error ? raw.error : null;
    return { items, labels, error };
  }
  return { items: [], labels: null, error: 'choices_fn returned an unsupported value' };
}

/**
 * Register the `fetch_choices` effect handler. Called from installBuiltins()
 * at boot (sibling of the other feature-ish effect registrations). The
 * callback receives (eff, host): host.signal is the AbortSignal, host.applyMsg
 * is the Msg sink. host.releaseKey() is called in both the resolve and reject
 * paths so the C5 inflight entry doesn't wedge.
 *
 * eff shape (built in the reducer, consumed here):
 *   { type: 'fetch_choices', key, ref, port, values, requestId, actionKey, group }
 *
 * The reducer attaches `key` = `'choices_fn:<actionKey>.<port>'` so a
 * same-field re-request aborts the prior fetch's signal. This is the whole
 * point of C5 keying — a user who rapid-tabs through deps shouldn't pay for
 * stale enumerations.
 */
function registerFetchChoicesEffect(registerEffect) {
  registerEffect('fetch_choices', (eff, host) => {
    const fn = _getChoicesFn(eff.ref);
    const dispatchResolved = (payload) => {
      host.applyMsg({
        type: 'fabric_form_choices_resolved',
        port: eff.port,
        requestId: eff.requestId,
        items: payload.items,
        labels: payload.labels,
        error: payload.error,
      });
    };
    if (!fn) {
      dispatchResolved({ items: [], labels: null, error: `unknown choices_fn: ${eff.ref}` });
      if (host.releaseKey) host.releaseKey();
      return;
    }
    let raw;
    try {
      raw = fn({
        values: eff.values || {},
        actionKey: eff.actionKey,
        group: eff.group,
        signal: host.signal,
      });
    } catch (e) {
      dispatchResolved({ items: [], labels: null, error: String((e && e.message) || e) });
      if (host.releaseKey) host.releaseKey();
      return;
    }
    Promise.resolve(raw).then(
      (value) => {
        // The C5 abort fires via signal — the fn is expected to honor it, but if
        // it resolved anyway, let the stale-reply guard in the reducer drop the
        // msg by requestId. We still dispatch so the live-session frames stay
        // predictable (never silently swallow a resolved value).
        if (host.signal && host.signal.aborted) {
          if (host.releaseKey) host.releaseKey();
          return;   // abort — don't touch the WAL with stale data
        }
        dispatchResolved(normalizeResult(value));
        if (host.releaseKey) host.releaseKey();
      },
      (err) => {
        if (host.signal && host.signal.aborted) {
          if (host.releaseKey) host.releaseKey();
          return;
        }
        dispatchResolved({ items: [], labels: null, error: String((err && err.message) || err) });
        if (host.releaseKey) host.releaseKey();
      }
    );
  });
}

module.exports = {
  registerFetchChoicesEffect,
  setRegistryHost,
  normalizeResult,
};
