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
 *   Tests register fns via `api.registerChoicesFn('<ns>', { fnName: fn })`
 *   and reset between describe blocks with `api.__resetChoicesFns()`. See
 *   test-choices-fn-registry.js + test-choices-fn-runtime.js for the pattern.
 *
 * Observability (R3D-SMELL2):
 *   Every error path — unknown ref, fn sync-throw, fn Promise rejection,
 *   normalizeResult failure — also writes a `diag-log.error('choices_fn', …)`
 *   entry so an author can see the problem in the `:diag` view, not just as
 *   an [error] chip in the popover. The chip is UX; diag-log is the trail.
 */
'use strict';

// Injected lookup — set at boot by `dispatch/runtime/effects.js` which pulls
// from `panel/api.getChoicesFn`. We don't require panel/ directly: feature/
// sits BELOW panel/ in the layer DAG, so an upward require (even deferred)
// would fail the test-dep-layering gate. Same seam pattern as feature-host.
let _lookup = null;
function setRegistryHost(host) { _lookup = host && host.getChoicesFn; }
function _getChoicesFn(ref) { return _lookup ? _lookup(ref) : null; }

// Diagnostic sink for error paths (R3D-SMELL2). Lazy-require so the runtime
// stays loadable without io/ wired up (same discipline as effects.js's
// `require('../../io/event-log')` call site). Silent swallow if diag-log is
// unavailable — this is a secondary sink, not the primary error channel.
function _diagError(code, message) {
  try { require('../io/diag-log').error(code, message); }
  catch (_) { /* diag-log unavailable (CLI mode, early boot) — chip is primary */ }
}

// Hard ceiling on the choices list — a buggy or hostile fn returning e.g.
// Array(10_000_000).fill('x') would bloat `model.modal.fabricForm.fields[i].
// computed.items` (and the WAL-captured resolved payload) by tens of MB and
// make every repaint allocate the full rows[] array. The parallel of the
// slice-1 MAX_FIELD_TEXT=8192 for paste bloat on a field text; here the risk
// is the fn's RETURN SIZE, not keystroke paste. 1024 covers "list every
// branch in a large monorepo" / "every table in a mid-sized db" with room
// to spare; past that the overlay would be unusable anyway. R1B-BUG1.
//
// Note (R2A-SMELL1): the cap trims on LANDING, not on allocation — the fn's
// return value is already materialized by the time we see it. A fn that
// allocates 10M items still spends that memory in author code; the cap only
// prevents it from reaching the WAL / overlay. The guide's "capped at 1024"
// wording is a landing cap, not a production cap.
const MAX_CHOICES = 1024;

// R3E-SMELL3 — the empty-resolve shape in literal form repeated 5× across
// the handler's error paths. Hoisted so a schema change (e.g., adding a
// future `source` field) lands in one place.
const EMPTY_RESOLVE = { items: [], labels: null, error: null, truncated: false };

// Replace control chars that would break single-row rendering with a single
// space. `stripControls` (ansi.js) PRESERVES `\n` and `\t` by design — fine
// for streamed action output, lethal for the popover where every row is one
// line AND a `\n` emits a cursor-move escape that re-anchors subsequent
// paint at a wrong row/column (R2C-BUG1 — breaks the overlay geometry +
// bleeds items into the next field). Also strips `\r` so a Windows-line-
// ending'd item (`'intro\r'`) doesn't paint a hidden carriage return.
// Applied at normalizeResult so the WAL stores the already-cleaned payload
// (single source of truth; paint can trust what it reads).
function _stripRowBreaks(s) {
  return typeof s === 'string' ? s.replace(/[\r\n\t]+/g, ' ') : s;
}

// Normalize a (possibly-async) fn return into the resolved-arm payload shape.
// Pure, no I/O; callable from unit tests without the effect wrapper.
//
// Return shape now includes `truncated: true` when the fn returned more than
// MAX_CHOICES items — the overlay renders a trailing `[+N more]` row so the
// user knows the cap applied.
function normalizeResult(raw) {
  if (raw == null) return { ...EMPTY_RESOLVE };
  let items, labels, error;
  if (Array.isArray(raw)) {
    // R3C-SMELL1 — drop empty-string items. An item renders as one popover
    // row, so a `''` is a blank row with nothing to pick — confusing UX.
    // Authors can filter upstream; this is defense-in-depth. Row-break-strip
    // runs FIRST so `'\n'` collapses to `' '` (one-space row, meaningful).
    items = raw.filter((v) => typeof v === 'string').map(_stripRowBreaks).filter((v) => v !== '');
    labels = null;
    error = null;
  } else if (typeof raw === 'object') {
    items = Array.isArray(raw.items)
      ? raw.items.filter((v) => typeof v === 'string').map(_stripRowBreaks).filter((v) => v !== '')
      : [];
    labels = Array.isArray(raw.labels)
      ? raw.labels.slice(0, items.length).map((v) => _stripRowBreaks(typeof v === 'string' ? v : ''))
      : null;
    error = typeof raw.error === 'string' && raw.error ? _stripRowBreaks(raw.error) : null;
  } else {
    return { ...EMPTY_RESOLVE, error: 'choices_fn returned an unsupported value' };
  }
  let truncated = false;
  if (items.length > MAX_CHOICES) {
    items = items.slice(0, MAX_CHOICES);
    if (labels) labels = labels.slice(0, MAX_CHOICES);
    truncated = true;
  }
  return { items, labels, error, truncated };
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
        actionKey: eff.actionKey,       // R1C — cross-form stale-reply guard
        requestId: eff.requestId,
        items: payload.items,
        labels: payload.labels,
        error: payload.error,
        truncated: !!payload.truncated,  // R1B-BUG1 — items cap affordance
      });
    };
    // R3E-SMELL2: `host.releaseKey` is unconditionally defined on the host
    // because the fetch_choices Cmd always carries a `key` (effects.js attaches
    // releaseKey only when eff.key is truthy, and the fabric-form reducer
    // always sets it). The pre-R3 `if (host.releaseKey)` guards were dead
    // defensive code — simplified to bare calls.
    if (!fn) {
      const msg = `unknown choices_fn: ${eff.ref} (registered via api.registerChoicesFn? component plugin loaded?)`;
      _diagError('choices_fn.unknown_ref', msg);
      dispatchResolved({ ...EMPTY_RESOLVE, error: msg });
      host.releaseKey();
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
      const em = String((e && e.message) || e);
      _diagError('choices_fn.sync_throw', `${eff.ref} (${eff.actionKey}.${eff.port}): ${em}`);
      dispatchResolved({ ...EMPTY_RESOLVE, error: em });
      host.releaseKey();
      return;
    }
    Promise.resolve(raw).then(
      (value) => {
        // The C5 abort fires via signal — the fn is expected to honor it, but if
        // it resolved anyway, let the stale-reply guard in the reducer drop the
        // msg by requestId. We still dispatch so the live-session frames stay
        // predictable (never silently swallow a resolved value).
        if (host.signal && host.signal.aborted) {
          host.releaseKey();
          return;   // abort — don't touch the WAL with stale data
        }
        const normalized = normalizeResult(value);
        // R3D-SMELL1 — a non-empty return array that NORMALIZED to zero
        // items means every entry was either non-string or empty after the
        // row-break strip. A common authoring mistake (returning numbers,
        // objects, or a per-char split). One diag entry per occurrence so
        // the author can trace it in `:diag` instead of staring at a silent
        // "(no choices)" popover.
        if (Array.isArray(value) && value.length > 0 && normalized.items.length === 0 && !normalized.error) {
          _diagError('choices_fn.dropped_items',
            `${eff.ref} (${eff.actionKey}.${eff.port}): returned ${value.length} entries, 0 survived string+non-empty filter`);
        }
        dispatchResolved(normalized);
        host.releaseKey();
      },
      (err) => {
        if (host.signal && host.signal.aborted) {
          host.releaseKey();
          return;
        }
        const em = String((err && err.message) || err);
        _diagError('choices_fn.rejected', `${eff.ref} (${eff.actionKey}.${eff.port}): ${em}`);
        dispatchResolved({ ...EMPTY_RESOLVE, error: em });
        host.releaseKey();
      }
    );
  });
}

module.exports = {
  registerFetchChoicesEffect,
  setRegistryHost,
  normalizeResult,
};
