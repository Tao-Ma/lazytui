/**
 * Fabric multi-field FORM modal sub-reducer (args→ports slice 1).
 *
 * The invoke-time popup for an action with 2+ declared `ports.in` (one popup,
 * N labeled fields, atomic submit). The 1-port invoke-time path and the ports-
 * pane in-grid edit stay on `fabricFieldMode` (see modal/fabric-field.js).
 *
 * Shape in model.modal.fabricForm:
 *   { fields: [{ port, text, isDefault, isModified, required, default, desc }, …],
 *     focusIdx: int,
 *     pendingAction: { actionKey, action } | null }
 *
 * The caller (action-runner, commit 3) builds `fields[]` by resolving the
 * action's `ports.in` against the current injects/wires and passes it on
 * `fabric_form_enter`. Fields arrive already in required-first order with their
 * resolved value pre-filled. The reducer stays PURE — it does not call into the
 * fabric host/registry (that is the caller's job). Tests build fake fields and
 * drive the reducer directly.
 *
 * Submit writes one ONE-SHOT inject per `isModified` field and emits a `do_run`
 * for the pending action. The existing `_consumeOneShotInjects` in action-runner
 * clears the one-shots after a successful spawn, same as the fabric-field popup
 * path. A `isModified: false` field writes nothing — the resolver picks up its
 * default (or sticky inject/wire) on the next run.
 *
 * Chip rules (per docs/action-ports-guide.md):
 *   - [default]  text === decl.default
 *   - [modified] text differs from default (incl. a user-blanked field whose
 *                decl has a default)
 *   - [unset]    text === '' AND decl has no default   (renderer-side derivation;
 *                reducer encodes it as isDefault:false + isModified:false)
 *
 * `update(model, msg) → [model, cmds]`.
 */
'use strict';

const { withModalMode, withModal } = require('../model-ops');
const { isChainActive } = require('../../../leaves/input/modes');
const { applyInject } = require('../fabric');

const TYPES = [
  'fabric_form_enter', 'fabric_form_key',
  'fabric_form_focus_next', 'fabric_form_focus_prev',
  'fabric_form_reset_default', 'fabric_form_clear',
  'fabric_form_submit', 'fabric_form_cancel',
  // Args→ports slice 2 (`choices_fn:`): computed-choices lifecycle. The
  // fetch_choices effect's reply, a user pick from the choices popover, and
  // the pre-fetch state write a reducer uses when a request is kicked off.
  // Placeholder arms in commit 2 — the real reducer body lands in commit 3.
  'fabric_form_choices_request', 'fabric_form_choices_resolved',
  'fabric_form_choices_pick', 'fabric_form_choices_open',
  'fabric_form_choices_close', 'fabric_form_choices_nav',
];

const CLOSED = { fields: [], focusIdx: 0, pendingAction: null, picking: null,
                 requestSeq: 0 };

// Deterministic hash of a port's depended-on values. Order-independent (sorted
// keys) so a decl rewrite that reorders dependsOn can't invalidate the cache;
// pure JSON stringify so replay reproduces identical hashes.
function _depsHash(values) {
  const keys = Object.keys(values || {}).sort();
  const pairs = keys.map((k) => [k, values[k]]);
  return JSON.stringify(pairs);
}
// Build the depValues map for a computed field — just a slice of the form's
// current field texts, keyed by name. Fields the field doesn't depend on are
// not included (the fetch handler sees ONLY the deps it needs).
function _depValuesForField(fields, dependsOn) {
  const dv = {};
  for (const name of dependsOn || []) {
    const f = fields.find((x) => x.port === name);
    // R1A-SMELL2: default to '' so a missing/undefined-text dep hashes the
    // same way as an explicitly-empty one. Pre-fix, a hand-built field with
    // `text: undefined` dropped the dep from the hash — which collided with
    // the "dep not in form at all" hash.
    dv[name] = (f && typeof f.text === 'string') ? f.text : '';
  }
  return dv;
}

// Per-field text size ceiling, in JS String code units (UTF-16; NOT bytes —
// 8192 code units can be anywhere from 8 KiB on all-ASCII to 32 KiB when the
// field is all 4-byte emoji). A field is a prompt input — a thousand or two
// code units is generous for anything a human types; a paste much larger
// than this is almost certainly either an accidental dump of logs/binary
// content or an unbounded WAL-rider attempt (every keystroke rides the WAL,
// so N 10MB fields would bloat replay checkpoints). The cap is enforced on
// every text-growing path (typed append + paste); backspace / Ctrl-U are
// unlimited as always (shrinking is fine). Slice-1 pre-release review Fork 2
// Finding 6 + round 2 wording cleanup.
//
// The cap is applied via `text.slice(0, MAX_FIELD_TEXT)`, which can split a
// surrogate pair at the boundary. The resulting unmatched surrogate is still
// valid JS (JSON.stringify round-trips it, markup rendering treats it as a
// replacement glyph) — and the user controls what they typed, so a mid-paste
// cut lands wherever they stopped reading. No special handling needed.
const MAX_FIELD_TEXT = 8192;

// Classify a (text, default) pair into the chip flags the submit path reads.
// `def` is the declared default (string or null); `text` is the current value.
function _chip(text, def) {
  if (def != null && text === def) return { isDefault: true,  isModified: false };
  if (text === '' && def == null)  return { isDefault: false, isModified: false };
  return                                 { isDefault: false, isModified: true  };
}

// A field with a `choices_fn:` carries a `computed` slot the fetch handler
// writes to. Shape: { state, requestId, inputsHash, items, labels, error }.
//   state         'idle' | 'pending' | 'ok' | 'error'
//   requestId     monotonic — the stale-reply guard; a resolved msg whose
//                 id ≠ the field's current requestId is dropped on arrival.
//   inputsHash    the depended-on values' hash at request time; the request
//                 arm uses this to short-circuit no-op refetches on identical
//                 inputs (same-form session).
//   items/labels  the current result (empty while idle/pending).
//   error         fetch error text, or null.
const EMPTY_COMPUTED = { state: 'idle', requestId: 0, inputsHash: null,
                         items: [], labels: null, error: null, truncated: false };

// Normalize an incoming raw field decl into the slot shape the reducer stores.
// Caller sends { port, text, required, default, desc, choicesFnRef?, dependsOn? };
// the chip flags are recomputed here from (text, default) so a caller-provided
// chip can never drift from the text/default actually passed. Computed-choices
// fields (choicesFnRef present) are seeded with an idle `computed` slot — the
// renderer paints `[fetching…]` once the request arm transitions it to
// `pending`, so a brand-new form opens quiet rather than flashing "idle".
//
// Defense-in-depth (slice-1 pre-release review Fork 1 R1): `default` is also
// accepted as a number/boolean and String()'d, so a caller that forgot to
// stringify (e.g. a Msg hand-built in a test, or a non-action-runner source)
// doesn't silently lose the default. Primary caller (action-runner's
// `_promptMissing`) already stringifies; this is belt-and-suspenders.
function _normalize(raw) {
  const port = String(raw && raw.port || '');
  // Defense-in-depth (R1A-SMELL2): a hand-built field decl with `text:
  // undefined` would make `_depValuesForField` omit the port from the hash,
  // which hashes identically to a port that doesn't exist in the form. Seed
  // text to '' so an unedited field hashes consistently with other callers.
  const text = raw && typeof raw.text === 'string' ? raw.text : '';
  const required = raw && raw.required !== false;                 // default true
  const def = raw && raw.default != null && typeof raw.default !== 'object'
    ? String(raw.default)
    : null;
  const desc = raw && typeof raw.desc === 'string' ? raw.desc : '';
  const choicesFnRef = raw && typeof raw.choicesFnRef === 'string' && raw.choicesFnRef
    ? raw.choicesFnRef : null;
  const dependsOn = raw && Array.isArray(raw.dependsOn)
    ? raw.dependsOn.filter((n) => typeof n === 'string' && n) : [];
  const computed = choicesFnRef ? { ...EMPTY_COMPUTED } : null;
  return { port, text, required, default: def, desc, choicesFnRef, dependsOn,
           computed, ..._chip(text, def) };
}

// Defense-in-depth guards on the raw fields array passed on fabric_form_enter:
//   - drop null / undefined slots so a caller holding an array with holes
//     doesn't materialize ghost anonymous rows (Fork 1 R2);
//   - drop entries with an empty port name — those would address injects as
//     `actionKey.` which the fabric resolver can't key against (Fork 1 R2);
//   - dedupe by port name, last-wins — matches YAML map semantics where a key
//     that appears twice resolves to the last value (Fork 1 R3). Production
//     path (action-runner builds `fields` from `Object.keys(ports.in)`) never
//     produces duplicates, but the normalize/dedupe guards defense-in-depth
//     against a hand-built Msg or a future caller that doesn't share that
//     invariant.
function _cleanFields(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Map();                               // port → last normalized record
  for (const r of raw) {
    if (r == null) continue;
    const n = _normalize(r);
    if (!n.port) continue;
    seen.set(n.port, n);
  }
  return [...seen.values()];
}

// Required rows render before optional rows; original order preserved within
// each partition. A field with no `required` key defaults to required (matches
// the YAML schema's default).
function _partition(fields) {
  const req = [], opt = [];
  for (const f of fields) (f.required ? req : opt).push(f);
  return req.concat(opt);
}

function _editCurrent(fields, idx, nextText) {
  if (idx < 0 || idx >= fields.length) return fields;
  const cur = fields[idx];
  if (cur.text === nextText) return fields;
  const chips = _chip(nextText, cur.default);
  const next = fields.slice();
  next[idx] = { ...cur, text: nextText, ...chips };
  return next;
}

function _advance(fields, idx, delta) {
  const n = fields.length;
  if (n === 0) return 0;
  return ((idx + delta) % n + n) % n;
}

function update(model, msg) {
  switch (msg.type) {
    case 'fabric_form_enter': {
      // Flat modals — don't open over a live modal.
      if (isChainActive(model.modes)) return [model, []];
      // Belt-and-suspenders defense: _cleanFields drops holes / empty-port /
      // dupe entries; if nothing survives, the modal is not opened.
      const fields = _partition(_cleanFields(msg.fields));
      if (fields.length === 0) return [model, []];
      // Initial choices requests: for every computed field whose dependsOn
      // values are already in the form state, emit a request Cmd via the `msg`
      // effect. (A computed field with no deps also qualifies — depValues={}
      // hashes trivially; fetch runs immediately.) A field whose deps aren't
      // all populated stays idle: the renderer paints no `[fetching…]` chip,
      // and the fetch fires once the user tabs to a dep and provides a value.
      const initialRequests = [];
      for (const field of fields) {
        if (!field.choicesFnRef) continue;
        const deps = field.dependsOn || [];
        // Only fire when ALL deps have non-empty text — a request against
        // partially-resolved deps is almost always wasted (`choices_fn` for
        // "sections of this file" with an empty file path).
        const haveAllDeps = deps.every((n) => {
          const d = fields.find((x) => x.port === n);
          return d && typeof d.text === 'string' && d.text !== '';
        });
        if (!haveAllDeps) continue;
        initialRequests.push({
          type: 'msg',
          msg: { type: 'fabric_form_choices_request', port: field.port },
        });
      }
      return [withModalMode(model, { fabricFormMode: true }, {
        fabricForm: {
          fields,
          focusIdx: 0,
          pendingAction: msg.pendingAction || null,
          picking: null,       // choices-popover state; opened via fabric_form_choices_open
          requestSeq: 0,       // monotonic counter for choices-request ids (replay-safe)
        },
      }), initialRequests];
    }
    case 'fabric_form_key': {
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      const cur = f.fields[f.focusIdx];
      if (!cur) return [model, []];
      let text = cur.text;
      if (msg.seq === '\x7f') text = text.slice(0, -1);                       // backspace
      else if (msg.seq === '\x15') text = '';                                  // Ctrl+U — clear-line
      else if (msg.key === 'paste' && typeof msg.seq === 'string') {
        text += msg.seq.replace(/[\r\n]+/g, ' ');                              // single-line: collapse breaks
      } else if (msg.seq && msg.seq.length === 1
                 && msg.seq.charCodeAt(0) >= 32 && msg.seq.charCodeAt(0) < 127) {
        text += msg.seq;
      } else {
        return [model, []];
      }
      // Cap total field size — paste or sustained typing can't bloat WAL beyond
      // this. Shrinking paths (backspace / Ctrl+U) bypass the cap by taking the
      // `slice` or `''` branch first.
      if (text.length > MAX_FIELD_TEXT) {
        text = text.slice(0, MAX_FIELD_TEXT);
        // Surrogate split guard — if the cap landed on the HIGH surrogate of a
        // supplementary-plane char (emoji ≥ U+10000), step back one unit so we
        // never leave a lone high surrogate at the tail. Lone surrogates are
        // technically-valid UTF-16 but trip `visibleLen` (counts +1 for the
        // orphan) and render as a replacement glyph, which drifts one column
        // against the painted midW. (Round 4 Fork 4 Finding 2.)
        const last = text.charCodeAt(text.length - 1);
        if (last >= 0xD800 && last <= 0xDBFF) text = text.slice(0, -1);
      }
      const nextFields = _editCurrent(f.fields, f.focusIdx, text);
      if (nextFields === f.fields) return [model, []];
      return [withModal(model, { fabricForm: { ...f, fields: nextFields } }), []];
    }
    case 'fabric_form_focus_next':
    case 'fabric_form_focus_prev': {
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      const nextIdx = _advance(f.fields, f.focusIdx, msg.type === 'fabric_form_focus_next' ? 1 : -1);
      if (nextIdx === f.focusIdx) return [model, []];
      // Reactive refetch: the just-blurred field may be a dependency of one or
      // more computed fields. For each dependent whose current depsHash differs
      // from its stored inputsHash, emit a request Cmd (via `msg`). An unchanged
      // hash is a no-op (user tabbed out without editing the dep) → no refetch
      // / no flicker.
      //
      // R1A-BUG2 — a pending request whose deps have been EMPTIED between
      // fire and now gets its field reset to idle (state='idle', requestId
      // cleared) so (a) the chip stops reading `[fetching…]` forever and
      // (b) the in-flight fetch's resolved reply is dropped by the
      // requestId guard when it lands.
      const blurredPort = f.fields[f.focusIdx] && f.fields[f.focusIdx].port;
      const refetchCmds = [];
      const cancelCmds = [];
      let nextFields = f.fields;
      if (blurredPort) {
        const pending = f.pendingAction;
        const actionKey = pending && pending.actionKey;
        for (let i = 0; i < f.fields.length; i++) {
          const field = f.fields[i];
          if (!field.choicesFnRef) continue;
          if (!(field.dependsOn || []).includes(blurredPort)) continue;
          const dv = _depValuesForField(f.fields, field.dependsOn);
          const allDepsSet = (field.dependsOn || []).every((n) => dv[n] && dv[n] !== '');
          // Dep got emptied: reset the field's computed state so pending
          // doesn't wedge. If an in-flight fetch is running, abort it so a
          // stale resolve can't repopulate items for the now-empty deps.
          if (!allDepsSet) {
            if (field.computed && field.computed.state === 'pending') {
              if (nextFields === f.fields) nextFields = f.fields.slice();
              nextFields[i] = { ...field, computed: {
                ...EMPTY_COMPUTED, state: 'idle', requestId: 0, inputsHash: null,
              }};
              if (actionKey) {
                cancelCmds.push({ type: 'cancel_effect', key: `choices_fn:${actionKey}.${field.port}` });
              }
            }
            continue;
          }
          const h = _depsHash(dv);
          const stored = field.computed ? field.computed.inputsHash : null;
          if (h === stored) continue;
          refetchCmds.push({
            type: 'msg',
            msg: { type: 'fabric_form_choices_request', port: field.port },
          });
        }
      }
      return [withModal(model, { fabricForm: {
        ...f, focusIdx: nextIdx, fields: nextFields,
      } }), [...cancelCmds, ...refetchCmds]];
    }
    case 'fabric_form_reset_default': {
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      const cur = f.fields[f.focusIdx];
      if (!cur) return [model, []];
      const target = cur.default == null ? '' : cur.default;
      const nextFields = _editCurrent(f.fields, f.focusIdx, target);
      if (nextFields === f.fields) return [model, []];
      return [withModal(model, { fabricForm: { ...f, fields: nextFields } }), []];
    }
    case 'fabric_form_clear': {
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      const cur = f.fields[f.focusIdx];
      if (!cur) return [model, []];
      const nextFields = _editCurrent(f.fields, f.focusIdx, '');
      if (nextFields === f.fields) return [model, []];
      return [withModal(model, { fabricForm: { ...f, fields: nextFields } }), []];
    }
    case 'fabric_form_submit': {
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      const pending = f.pendingAction;
      const actionKey = pending && pending.actionKey;
      // R2B-BUG1 — abort any in-flight choices fetches before submitting.
      // Without this, a submit-while-fetching lets the OLD fetch's `.then`
      // dispatch its resolved msg AFTER do_run reopens the form (via
      // _promptMissing — same actionKey, requestSeq reset to 0, fresh
      // requestId 1): actionKey matches, requestId matches, stale items
      // populate the NEW form's field. Symmetric with the slice-1 cancel
      // arm which already emits cancel_effect per pending field.
      const cancelCmds = [];
      if (actionKey) {
        for (const field of f.fields) {
          if (field.computed && field.computed.state === 'pending') {
            cancelCmds.push({ type: 'cancel_effect', key: `choices_fn:${actionKey}.${field.port}` });
          }
        }
      }
      if (!pending || !actionKey) {
        // No pending action is a degenerate state — just close.
        return [withModalMode(model, { fabricFormMode: false }, { fabricForm: { ...CLOSED } }), cancelCmds];
      }
      // Write a one-shot inject for every modified field, in field order. Each
      // applyInject returns a new model; chain them. `_consumeOneShotInjects`
      // in action-runner clears them after a successful spawn.
      //
      // Atomicity (slice-1 pre-release review Fork 1 R4): this is a single
      // reducer arm, so the chained writes land as one logical reduction —
      // the frame emitted after this arm reflects either EVERY one-shot or
      // (if applyInject threw) none, because the exception would unwind the
      // whole arm before `withModalMode` runs. `applyInject` itself is pure
      // (spread + shallow-copy, no I/O, no validation) and cannot throw
      // today; this comment pins the invariant so a future validation layer
      // added to applyInject must preserve "throw-rolls-back-all-N" or move
      // the loop to a cmd. See docs/ports-and-wires.md ("Resolution &
      // readiness").
      //
      // The one-shot "between-write race" is physically impossible under the
      // single-threaded JS event loop: nothing can land between the N
      // applyInject calls and the `do_run` cmd below, because the cmd queue
      // doesn't flush until this arm returns.
      let next = model;
      for (const field of f.fields) {
        if (!field.isModified) continue;
        const addr = `${actionKey}.${field.port}`;
        next = applyInject(next, addr, field.text, { oneShot: true });
      }
      const closed = withModalMode(next, { fabricFormMode: false }, { fabricForm: { ...CLOSED } });
      // cancel_effect Cmds first so inflight entries clear before the
      // do_run → _promptMissing → fabric_form_enter sequence re-fires
      // initial requests under the same keys.
      return [closed, [...cancelCmds, { type: 'do_run', actionKey, action: pending.action }]];
    }
    case 'fabric_form_cancel': {
      if (!model.modes.fabricFormMode) return [model, []];
      // R1B-SMELL1 / R1C-SMELL — abort any in-flight choices fetches before
      // closing. Without this: a slow fn resolves after the modal is gone, a
      // dead `fabric_form_choices_resolved` Msg lands (no-op'd by the mode
      // guard above), the WAL carries garbage, and the Promise closure
      // retains host.applyMsg until the fn settles. One cancel_effect per
      // field with a pending request; keys match the fetch_choices Cmd keys.
      const f = model.modal.fabricForm;
      const pending = f.pendingAction;
      const actionKey = pending && pending.actionKey;
      const cancelCmds = [];
      if (actionKey) {
        for (const field of f.fields) {
          if (field.computed && field.computed.state === 'pending') {
            cancelCmds.push({ type: 'cancel_effect', key: `choices_fn:${actionKey}.${field.port}` });
          }
        }
      }
      // Nothing to undo on injects — submit is atomic, so an open form has
      // written none yet.
      return [withModalMode(model, { fabricFormMode: false }, { fabricForm: { ...CLOSED } }), cancelCmds];
    }
    case 'fabric_form_choices_request': {
      // `{ port, requestId?, inputsHash?, depValues? }` — mark the port's
      // computed slot pending (so the renderer paints [fetching…]) and emit
      // the `fetch_choices` effect. `requestId` / `inputsHash` / `depValues`
      // are all AUTO-COMPUTED from form state when the caller omits them (the
      // production path from action-runner just sends `{port}`); the test
      // path can pass explicit values to pin specific transitions.
      //
      // Early-returns:
      //   - form closed → no-op
      //   - port not found → no-op
      //   - port has no choicesFnRef → no-op (a stale request arm can't drag
      //     an idle port into the computed-choices state machine)
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      const idx = f.fields.findIndex((x) => x.port === msg.port);
      if (idx < 0) return [model, []];
      const cur = f.fields[idx];
      if (!cur.choicesFnRef) return [model, []];
      const depValues = msg.depValues !== undefined
        ? msg.depValues
        : _depValuesForField(f.fields, cur.dependsOn);
      const inputsHash = msg.inputsHash !== undefined
        ? msg.inputsHash
        : _depsHash(depValues);
      const nextSeq = (f.requestSeq || 0) + 1;
      const requestId = msg.requestId !== undefined ? msg.requestId : nextSeq;
      const nextFields = f.fields.slice();
      nextFields[idx] = { ...cur, computed: {
        ...(cur.computed || EMPTY_COMPUTED),
        state: 'pending',
        requestId,
        inputsHash,
        error: null,
      }};
      const pending = f.pendingAction;
      const actionKey = pending && pending.actionKey;
      return [withModal(model, { fabricForm: {
        ...f, fields: nextFields, requestSeq: nextSeq,
      } }), [{
        type: 'fetch_choices',
        key: `choices_fn:${actionKey}.${cur.port}`,
        ref: cur.choicesFnRef,
        port: cur.port,
        values: depValues,
        requestId,
        actionKey,
        group: model.currentGroup || null,
      }]];
    }
    case 'fabric_form_choices_resolved': {
      // `{ port, actionKey?, requestId, items, labels, error, truncated? }` —
      // the fetch_choices Cmd's reply (dispatched by the runtime handler in
      // feature/choices-fn-runtime.js). Three stale-reply guards:
      //   1. form open (modes.fabricFormMode)
      //   2. actionKey matches current pendingAction — stops a prior form's
      //      in-flight fetch from landing into a new form whose port has the
      //      same name (R1C cross-form stale-reply class).
      //   3. requestId still matches the port's current computed.requestId
      //      (defense-in-depth against handler internal-state drift).
      // Also clamps `picking.idx` when the new items array is shorter than
      // the user navigated: a dep-blur refetch that returns fewer items used
      // to render `[reverse]undefined[/]` at the stale idx (R1A-BUG1).
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      // R1C: cross-form actionKey match. msg.actionKey can be absent (older
      // dispatchers / tests built before this guard) — tolerate by skipping
      // the match when it's not present. R2A-SMELL2: when msg.actionKey IS
      // present, a null pendingAction is treated as "any actionKey mismatches"
      // instead of letting the guard silently fall through. Production never
      // writes a null pendingAction (action-runner always passes one), but
      // a hand-built test Msg would bypass the guard — tighten defense.
      if (msg.actionKey && (!f.pendingAction || f.pendingAction.actionKey !== msg.actionKey)) {
        return [model, []];
      }
      const idx = f.fields.findIndex((x) => x.port === msg.port);
      if (idx < 0) return [model, []];
      const cur = f.fields[idx];
      if (!cur.computed || cur.computed.requestId !== msg.requestId) return [model, []];
      const items = Array.isArray(msg.items) ? msg.items.filter((v) => typeof v === 'string') : [];
      const labels = Array.isArray(msg.labels)
        ? msg.labels.slice(0, items.length).map((v) => (typeof v === 'string' ? v : ''))
        : null;
      const error = typeof msg.error === 'string' && msg.error ? msg.error : null;
      const truncated = !!msg.truncated;
      const nextFields = f.fields.slice();
      nextFields[idx] = { ...cur, computed: {
        ...cur.computed,
        state: error ? 'error' : 'ok',
        items, labels, error, truncated,
      }};
      // Clamp picking.idx if the user was navigated past the new list end.
      let nextPicking = f.picking;
      if (f.picking && f.picking.port === msg.port) {
        if (items.length === 0) nextPicking = { ...f.picking, idx: 0 };
        else if (f.picking.idx >= items.length) nextPicking = { ...f.picking, idx: items.length - 1 };
      }
      return [withModal(model, { fabricForm: { ...f, fields: nextFields, picking: nextPicking } }), []];
    }
    case 'fabric_form_choices_pick': {
      // `{ port, value }` — user picked an entry from the choices popover.
      // Writes `value` into the field's text (through `_editCurrent` so the
      // chip classification is recomputed) AND closes the picker so key input
      // flows back to the regular form. Does NOT submit — the user may tweak
      // a sibling field before run.
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      const idx = f.fields.findIndex((x) => x.port === msg.port);
      if (idx < 0) return [model, []];
      const value = typeof msg.value === 'string' ? msg.value : '';
      const nextFields = _editCurrent(f.fields, idx, value);
      // Even when value === current text (no mutation), close the picker so
      // Enter-on-highlighted-value-already-in-field doesn't leave the popover
      // open forever.
      const picking = null;
      if (nextFields === f.fields && f.picking === null) return [model, []];
      return [withModal(model, { fabricForm: { ...f, fields: nextFields, picking } }), []];
    }
    case 'fabric_form_choices_open': {
      // `{ port }` — space pressed on the focused computed-choices field. Only
      // meaningful when the field actually has a choicesFnRef (idle fields are
      // invisible to the picker). The popover starts at idx 0; a later nav
      // msg moves it. If the computed state is still 'pending', the popover
      // opens empty — the renderer paints an "awaiting choices…" row — so
      // the user has a visible affordance that the fetch is in flight.
      //
      // The fabricFormMode guard IS the chain-active check for this Msg —
      // fabricFormMode is itself a chain-active mode, so the open fires only
      // while the form is live. (R1E-SMELL4 raised a chain-active guard; it
      // doesn't apply here because the picker lives INSIDE fabricFormMode,
      // not alongside it.)
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      const idx = f.fields.findIndex((x) => x.port === msg.port);
      if (idx < 0) return [model, []];
      const field = f.fields[idx];
      if (!field.choicesFnRef) return [model, []];
      if (f.picking && f.picking.port === msg.port) return [model, []];   // idempotent
      return [withModal(model, { fabricForm: { ...f, picking: { port: msg.port, idx: 0 } } }), []];
    }
    case 'fabric_form_choices_close': {
      // Esc / blur / any key that closes the popover without committing.
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      if (f.picking === null) return [model, []];
      return [withModal(model, { fabricForm: { ...f, picking: null } }), []];
    }
    case 'fabric_form_choices_nav': {
      // `{ dir: -1 | 1 }` — move the popover's highlighted index. Reads the
      // picking field's current items length so the clamp honors a resolved
      // reply that just landed. No wrap — users expect Up at idx 0 to stop,
      // same as the menu modal.
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      if (f.picking === null) return [model, []];
      const field = f.fields.find((x) => x.port === f.picking.port);
      if (!field || !field.computed || field.computed.state !== 'ok') return [model, []];
      const n = field.computed.items.length;
      if (n === 0) return [model, []];
      const dir = msg.dir < 0 ? -1 : 1;
      const nextIdx = Math.max(0, Math.min(n - 1, f.picking.idx + dir));
      if (nextIdx === f.picking.idx) return [model, []];
      return [withModal(model, { fabricForm: { ...f, picking: { ...f.picking, idx: nextIdx } } }), []];
    }
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update, _depsHash, _depValuesForField };
