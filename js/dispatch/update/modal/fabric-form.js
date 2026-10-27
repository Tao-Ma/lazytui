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
const { isPrintableSeq: _isPrintableSeq } = require('../../../leaves/text/printable');
// Brief 3 — variadic fields tokenize `text` → argv items at submit using the
// same leaf compileCommand uses, so form text and `run:` string templates
// agree on quoting semantics (no second splitter).
const { tokenize } = require('../../../fabric/command');
const sharedKey = require('../../../leaves/ports/choices-cache-key');
const { declHasChoices } = require('../../../leaves/ports/has-choices');
const { filterChoices } = require('../../../leaves/ports/choices-filter');

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
  // Brief 2 (v0.6.43) — type-to-filter in the popover. `_filter` appends
  // one printable `seq` (or pops the last char when `seq === '\x7f'`);
  // `_filter_clear` resets to '' (first Esc press when the filter is
  // non-empty, so a second Esc still closes). Both reset picking.idx to 0
  // (filter change → highlight resets to the first filtered row).
  'fabric_form_choices_filter', 'fabric_form_choices_filter_clear',
];

const CLOSED = { fields: [], focusIdx: 0, pendingAction: null, picking: null,
                 requestSeq: 0 };

// Deterministic hash of a port's depended-on values — delegated to the
// shared leaf (js/leaves/ports/choices-cache-key.js) so this cache's keys
// stay byte-identical to the completion helper's on-disk cache keys. The
// two caches hash different value sets (TUI: depends_on only; completion:
// all earlier positionals) but share the format so the two caches can't
// drift. See the leaf's header for the full rationale.
const _depsHash = sharedKey.depsHash;
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

// Cancel-effect key for an in-flight fetch tied to a field. Mirrors the key
// the request arm attached when it emitted the fetch Cmd — different prefix
// per channel so the two keyed-effect registries don't collide, and so the
// right handler's AbortController fires.
//
// INVARIANT: this fn and the `fabric_form_choices_request` arm must tie-break
// identically on fields that somehow carry BOTH channel keys (parser rejects
// this at config load, but a hand-built Msg could bypass). Both pick cmd when
// present; if you edit one branch, edit the other.
function _cancelKeyForField(field, actionKey) {
  const prefix = field.choicesCmd ? 'choices_cmd' : 'choices_fn';
  return `${prefix}:${actionKey}.${field.port}`;
}

// --- Brief 3 — stale-while-refetch cache -------------------------------
//
// Cache key encodes the ONLY things that could change the fetch result:
// which action's which port, which SOURCE (fn ref or cmd string), and what
// the depended-on values are at request time. Same-port fetches with
// different deps (worktree.branch for repo A vs repo B) hash to different
// keys so one tree's branches can't surface in the other's popover. Fields
// with no choices channel hash to null (uncacheable — caller skips).
function _cacheKeyFor(actionKey, field, depValues) {
  if (!field) return null;
  const source = field.choicesCmd
    ? `cmd:${field.choicesCmd}`
    : (field.choicesFnRef ? `fn:${field.choicesFnRef}` : null);
  if (!source) return null;
  return sharedKey.cacheKey(actionKey, field.port, source, depValues);
}

// Pure lookup: returns the stored payload shape {items, labels, truncated}
// or null on miss. Order is NOT mutated here — promotion to MRU happens on
// put only (seed-on-request is a read; a successful fetch is the write that
// moves the key to the top). This keeps reads cheap and the LRU behavior
// predictable from WAL alone.
function _cacheGet(cache, key) {
  if (!cache || !key) return null;
  const entry = cache.entries && cache.entries[key];
  return entry || null;
}

// Pure put — returns a NEW cache object (never mutates the input, so a
// reducer arm that calls this stays replayable). LRU bound: when a put
// would exceed `cap`, drop the LRU-most key (order[0]). An update to an
// existing key moves it to MRU; a brand-new key appends.
function _cachePut(cache, key, payload) {
  if (!cache || !key || !payload) return cache;
  const cap = cache.cap || 64;
  const prevEntries = cache.entries || {};
  const prevOrder = (cache.order || []).filter((k) => k !== key);
  prevOrder.push(key);                                   // MRU at the tail
  const entries = { ...prevEntries, [key]: payload };
  // Evict LRU-most until size ≤ cap. Multiple evictions can happen if cap
  // shrank between puts (not a real case, but safe).
  while (prevOrder.length > cap) {
    const evicted = prevOrder.shift();
    delete entries[evicted];
  }
  return { entries, order: prevOrder, cap };
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

// Brief 2 — hard upper bound on picking.filter length. Filter is a popover
// needle, not a field value; 128 code units is already past any plausible
// label a port could expose, and the cap stops a paste or a stuck key from
// inflating the WAL (every char rides the WAL as a fabric_form_choices_filter
// Msg). Enforced POST-concat so a multi-char seq can't bypass a pre-check.
const MAX_FILTER_LEN = 128;

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
                         items: [], labels: null, error: null, truncated: false,
                         // Brief 3 — stale-while-refetch cache markers:
                         //   stale    → `⟳` chip suffix, cleared on fresh ok settle
                         //   cacheKey → the (actionKey|port|source|deps) key for THIS
                         //              in-flight request, so the resolved arm knows
                         //              which cache slot to write without recomputing
                         //              a deps hash from (now possibly stale) form state.
                         stale: false, cacheKey: null };

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
  // args→ports slice 3 — `choices_cmd:` sibling. Mutually exclusive with
  // `choicesFnRef` at the parser level (hard parse error if both set); the
  // reducer treats either as "this field has a choices mechanism" via the
  // `computed` slot.
  const choicesCmd = raw && typeof raw.choicesCmd === 'string' && raw.choicesCmd
    ? raw.choicesCmd : null;
  const choicesLabeled = !!(raw && raw.choicesLabeled);
  const choicesTimeout = raw && typeof raw.choicesTimeout === 'number'
    && Number.isFinite(raw.choicesTimeout) && raw.choicesTimeout > 0
    ? Math.floor(raw.choicesTimeout) : null;        // null → runtime default (5000)
  const dependsOn = raw && Array.isArray(raw.dependsOn)
    ? raw.dependsOn.filter((n) => typeof n === 'string' && n) : [];
  // args→ports slice 3+1 — literal `choices:` normalized by the parser to
  // {items:[], labels:[]|null, truncated:bool}. For literal, we seed the
  // field.computed slot DIRECTLY at form_enter — no fetch effect, no
  // [fetching…] chip. The data is already here; the renderer paints
  // `[N choices]` from the first frame.
  const literal = raw && raw.choices && typeof raw.choices === 'object'
                  && Array.isArray(raw.choices.items)
    ? raw.choices : null;
  let computed;
  if (literal) {
    const litItems = literal.items.filter((v) => typeof v === 'string');
    const litLabels = Array.isArray(literal.labels)
      ? literal.labels.slice(0, litItems.length).map((v) => (typeof v === 'string' ? v : ''))
      : null;
    computed = { state: 'ok', requestId: 0, inputsHash: null,
                 items: litItems, labels: litLabels,
                 error: null, truncated: !!literal.truncated,
                 // Literal data has no cache dimension — there's no fetch
                 // that could grow stale. Both flags stay inert.
                 stale: false, cacheKey: null };
  } else if (choicesFnRef || choicesCmd) {
    computed = { ...EMPTY_COMPUTED };
  } else {
    computed = null;
  }
  // Brief 3 — variadic flag: field.text is a one-line "command + args", and
  // the submit arm tokenizes it via the shared fabric/command.tokenize leaf
  // before injecting the ARRAY. Carry-through only; the chip renderer may
  // read it later to paint `[N items]`.
  const variadic = !!(raw && raw.variadic === true);
  // Single-source "field has a choices affordance" flag — carried on the
  // normalized field so the reducer's `fabric_form_choices_open` guard and
  // dispatch.js's SPACE branch don't need to re-derive it from the per-
  // channel refs. Pre-fix those two sites checked only choicesFnRef /
  // choicesCmd and silently dropped literal `choices:` fields; see
  // js/leaves/ports/has-choices.js for the drift postmortem.
  const hasChoices = !!(choicesFnRef || choicesCmd || literal);
  // Brief 3 (v0.6.43) — history flags. `isLast` means the text was seeded
  // from model.formHistory and the user has not edited it this session (so
  // the chip renderer paints `[last]`); `_editCurrent` clears it on any
  // text change. `remember` is the per-port opt-out carried through so the
  // submit arm can skip writing without re-reading the action decl. Default
  // remember=true (brief: "default is remember ON for everything else").
  const isLast = !!(raw && raw.isLast === true);
  const remember = !(raw && raw.remember === false);
  return { port, text, required, default: def, desc, choicesFnRef,
           choicesCmd, choicesLabeled, choicesTimeout, dependsOn,
           variadic, hasChoices, isLast, remember, computed, ..._chip(text, def) };
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
  // Brief 3 (v0.6.43) — any text change clears the `[last]` chip (the field
  // is no longer "the remembered value verbatim"). Explicit `isLast: false`
  // AFTER the spread so a field normalized with isLast=true doesn't carry
  // the flag past the edit it triggered.
  next[idx] = { ...cur, text: nextText, isLast: false, ...chips };
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
        if (!field.choicesFnRef && !field.choicesCmd) continue;
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
      } else if (_isPrintableSeq(msg.seq)) {
        // R3C-BUG1 — non-ASCII keystrokes (CJK IME, Cyrillic, Arabic, emoji
        // surrogate pairs) are legitimate text content. The pre-fix gate
        // `charCodeAt(0) >= 32 && < 127` rejected them silently, so an author
        // adding `choices_fn:` on a port that holds Japanese section names
        // couldn't free-type (and the "free-type wins" guarantee failed for
        // every non-ASCII user). Shared predicate with fabric-field.
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
          if (!field.choicesFnRef && !field.choicesCmd) continue;
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
                cancelCmds.push({ type: 'cancel_effect', key: _cancelKeyForField(field, actionKey) });
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
            cancelCmds.push({ type: 'cancel_effect', key: _cancelKeyForField(field, actionKey) });
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
        // Brief 3 (v0.6.43) — inject predicate is "differs from default", which
        // `isModified` already encodes (text !== default, OR non-empty with no
        // default). A [last]-seeded field untouched this session has
        // isModified=true (seed value differs from default — that's exactly
        // what made it worth remembering), so it STILL injects without the
        // user re-typing. The user sees the remembered text and the run
        // actually uses it. Without this, the form would show the memory
        // but the spawn would silently fall back to the decl default — the
        // chip would lie.
        if (!field.isModified) continue;
        const addr = `${actionKey}.${field.port}`;
        // Brief 3 — a variadic field's `text` is one line of "command + args";
        // tokenize it via the shared fabric/command.tokenize leaf (same splitter
        // compileCommand already uses) and inject the ARRAY. Zero items → skip
        // the inject entirely, so a required-missing re-prompts cleanly (same
        // outcome as an unmodified field). Scalar fields keep the string value
        // path unchanged.
        if (field.variadic) {
          const items = tokenize(field.text || '');
          if (items.length === 0) continue;
          next = applyInject(next, addr, items, { oneShot: true });
          continue;
        }
        next = applyInject(next, addr, field.text, { oneShot: true });
      }
      // Brief 3 (v0.6.43) — write per-port history for this submit. Each
      // field contributes iff:
      //   (a) `remember !== false`  (opt-out port never seeded, never
      //       written — passphrases, must-be-unique names, --force style
      //       typed-confirmation ports whose friction is the contract);
      //   (b) field.isModified OR field.text is non-empty — i.e. the user
      //       meaningfully filled it, either overriding the default or
      //       filling an unset slot. A field left at its decl default is
      //       NOT written (the default already carries the information;
      //       writing would just pin the current default against a future
      //       decl change).
      // One LRU entry per (group, actionKey) — reopening another action
      // does not evict this one until the cap of 64 entries is reached.
      // _cachePut is pure (returns a new object), so the formHistory write
      // stays replay-safe (same reason the choicesCache LRU does).
      //
      // Pre-release review (code fork) — key is `${group}.${actionKey}` to
      // match the openPortsForm read side. Group comes off `pending.group`
      // (stamped at open time) so the submit writes the same key the open
      // read from, even if currentGroup churns between the two.
      const perActionEntry = {};
      for (const field of f.fields) {
        if (field.remember === false) continue;
        if (!field.isModified && !field.text) continue;
        perActionEntry[field.port] = field.text || '';
      }
      const histGroup = (pending && typeof pending.group === 'string') ? pending.group : '';
      const histKey = `${histGroup}.${actionKey}`;
      if (Object.keys(perActionEntry).length > 0) {
        next = { ...next, formHistory: _cachePut(next.formHistory, histKey, perActionEntry) };
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
            cancelCmds.push({ type: 'cancel_effect', key: _cancelKeyForField(field, actionKey) });
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
      if (!cur.choicesFnRef && !cur.choicesCmd) return [model, []];
      const depValues = msg.depValues !== undefined
        ? msg.depValues
        : _depValuesForField(f.fields, cur.dependsOn);
      const inputsHash = msg.inputsHash !== undefined
        ? msg.inputsHash
        : _depsHash(depValues);
      const nextSeq = (f.requestSeq || 0) + 1;
      const requestId = msg.requestId !== undefined ? msg.requestId : nextSeq;
      // Brief 3 — stale-while-refetch cache. Look up by
      // (actionKey, port, source, deps). On a hit, seed computed.state='ok'
      // with the cached items IMMEDIATELY — the popover opens populated with
      // the stale list while the fresh fetch runs in parallel. On settle,
      // the resolved arm either replaces (ok) or keeps stale items visible
      // (error / timeout). The `stale: true` flag drives the `⟳` chip
      // marker; it clears on a clean ok resolve. The `cacheKey` field is
      // persisted on computed so the resolved arm knows which cache slot
      // to update without recomputing the deps hash from (now possibly
      // stale) form state.
      const actionKey = f.pendingAction && f.pendingAction.actionKey;
      const cacheKey = _cacheKeyFor(actionKey, cur, depValues);
      const cached = cacheKey ? _cacheGet(model.choicesCache, cacheKey) : null;
      const nextFields = f.fields.slice();
      if (cached) {
        // Hit — pre-fill items/labels; mark state 'ok' with stale:true so the
        // user sees content immediately. The fetch still fires below (we
        // don't short-circuit — the whole point is the cache is a HINT, not
        // the source of truth).
        nextFields[idx] = { ...cur, computed: {
          ...(cur.computed || EMPTY_COMPUTED),
          state: 'ok',
          requestId,
          inputsHash,
          items: cached.items.slice(),
          labels: cached.labels ? cached.labels.slice() : null,
          truncated: !!cached.truncated,
          error: null,
          stale: true,
          cacheKey,
        }};
      } else {
        nextFields[idx] = { ...cur, computed: {
          ...(cur.computed || EMPTY_COMPUTED),
          state: 'pending',
          requestId,
          inputsHash,
          error: null,
          stale: false,
          cacheKey,
        }};
      }
      // Branch on the channel the port declared. The two Cmds use different
      // keyed-effect prefixes so same-port fetches on different channels
      // don't collide, and `_cancelKeyForField` reads the same discriminator.
      const fetchCmd = cur.choicesCmd ? {
        type: 'fetch_choices_cmd',
        key: `choices_cmd:${actionKey}.${cur.port}`,
        cmd: cur.choicesCmd,
        labeled: !!cur.choicesLabeled,
        timeout: cur.choicesTimeout,            // null → runtime default
        env: depValues,                         // port name → value, bound verbatim
        cwd: model.projectDir || null,          // parity with script: (stream.js spawnOpts / action-runner bg)
        port: cur.port,
        requestId,
        actionKey,
        group: model.currentGroup || null,
      } : {
        type: 'fetch_choices',
        key: `choices_fn:${actionKey}.${cur.port}`,
        ref: cur.choicesFnRef,
        port: cur.port,
        values: depValues,
        requestId,
        actionKey,
        group: model.currentGroup || null,
      };
      return [withModal(model, { fabricForm: {
        ...f, fields: nextFields, requestSeq: nextSeq,
      } }), [fetchCmd]];
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
      let items = Array.isArray(msg.items) ? msg.items.filter((v) => typeof v === 'string') : [];
      let labels = Array.isArray(msg.labels)
        ? msg.labels.slice(0, items.length).map((v) => (typeof v === 'string' ? v : ''))
        : null;
      const error = typeof msg.error === 'string' && msg.error ? msg.error : null;
      let truncated = !!msg.truncated;
      // R3F-BUG1 — belt-and-suspenders items cap. The MAX_CHOICES cap in
      // choices-fn-runtime.js / choices-cmd-runtime.js fires only for live
      // fetches; a resolved Msg can reach this arm from THREE other paths that
      // bypass the runtime: (1) replay fold of a pre-R1 WAL where the recorded
      // payload is un-capped; (2) a future Component dispatching the Msg
      // directly with its own items; (3) tests building hand-crafted payloads.
      // Re-apply the cap here so the model NEVER holds more items than the UX
      // invariant for the port's channel allows — single invariant to reason
      // about on paint + replay.
      //
      // Slice-3 (choices_cmd:) tightens the cap to 32 per the "humans scan ≤32,
      // past that the author must narrow at the shell" rationale (see guide).
      // Slice-2 (choices_fn:) stays at 1024 for backcompat. Alignment is on a
      // separate ticket.
      const MAX_CHOICES_ARM = cur.choicesCmd ? 32 : 1024;
      if (items.length > MAX_CHOICES_ARM) {
        items = items.slice(0, MAX_CHOICES_ARM);
        if (labels) labels = labels.slice(0, MAX_CHOICES_ARM);
        truncated = true;
      }
      // Brief 3 — stale-while-refetch handling on settle:
      //   - OK settle: replace items/labels, clear stale, WRITE CACHE (so the
      //     next form-open for the same key hits).
      //   - ERROR/timeout settle WITH stale items present (seeded from cache
      //     on request): keep the stale items visible, flip state to 'error',
      //     keep stale:true. "An old list beats an empty popover" (brief).
      //     Free-typing still always wins — the chip is informational.
      //   - ERROR/timeout settle WITHOUT stale items: existing behavior,
      //     computed.items becomes []. No cache write.
      const hadStale = !!(cur.computed && cur.computed.stale
                          && Array.isArray(cur.computed.items) && cur.computed.items.length > 0);
      let nextState, nextItems, nextLabels, nextTruncated, nextStale;
      let cacheUpdate = null;                            // {key, payload} on ok settle
      if (error) {
        if (hadStale) {
          // Keep the stale items visible under the error chip.
          nextState = 'error';
          nextItems = cur.computed.items;
          nextLabels = cur.computed.labels;
          nextTruncated = !!cur.computed.truncated;
          nextStale = true;
        } else {
          nextState = 'error';
          nextItems = items; nextLabels = labels; nextTruncated = truncated;
          nextStale = false;
        }
      } else {
        nextState = 'ok';
        nextItems = items; nextLabels = labels; nextTruncated = truncated;
        nextStale = false;                               // fresh data clears the marker
        if (cur.computed && cur.computed.cacheKey) {
          cacheUpdate = { key: cur.computed.cacheKey,
                          payload: { items: items.slice(),
                                     labels: labels ? labels.slice() : null,
                                     truncated } };
        }
      }
      const nextFields = f.fields.slice();
      nextFields[idx] = { ...cur, computed: {
        ...cur.computed,
        state: nextState,
        items: nextItems,
        labels: nextLabels,
        error,
        truncated: nextTruncated,
        stale: nextStale,
      }};
      // Clamp picking.idx if the user was navigated past the new list end.
      // Uses nextItems (not msg.items) so the stale-keep path doesn't clamp
      // against an empty error payload while the stale list is still shown.
      // Brief 2 — clamp against the FILTERED view (what the user sees); a
      // mid-filter resolved reply with fewer matches must keep idx inside
      // the filtered rows, not inside the raw list.
      let nextPicking = f.picking;
      if (f.picking && f.picking.port === msg.port) {
        const filterStr = typeof f.picking.filter === 'string' ? f.picking.filter : '';
        const view = filterChoices(nextItems, nextLabels || null, filterStr);
        const vn = view.items.length;
        if (vn === 0) nextPicking = { ...f.picking, idx: 0 };
        else if (f.picking.idx >= vn) nextPicking = { ...f.picking, idx: vn - 1 };
      }
      const nextChoicesCache = cacheUpdate
        ? _cachePut(model.choicesCache, cacheUpdate.key, cacheUpdate.payload)
        : model.choicesCache;
      return [{
        ...withModal(model, { fabricForm: { ...f, fields: nextFields, picking: nextPicking } }),
        choicesCache: nextChoicesCache,
      }, []];
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
      // Any of the three choices channels (fn, cmd, literal) opens the
      // popover. The flag is stamped by _normalize via the shared leaf.
      if (!field.hasChoices) return [model, []];
      if (f.picking && f.picking.port === msg.port) return [model, []];   // idempotent
      // Brief 2 — filter resets to '' on every open. Reopening the SAME
      // field (after a close) starts fresh; a prior filter should not
      // persist across popover lifecycles (confusing + unobservable
      // from outside the picker).
      return [withModal(model, { fabricForm: {
        ...f, picking: { port: msg.port, idx: 0, filter: '' },
      } }), []];
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
      // Brief 2 — nav operates on the FILTERED view (the user sees filtered
      // rows and expects Up/Down to walk them). Shared leaf keeps dispatch.js's
      // Enter-picks-value lookup, the renderer's row-painting loop and this
      // clamp all reading the same list.
      const view = filterChoices(field.computed.items, field.computed.labels || null, (f.picking.filter || ''));
      const n = view.items.length;
      if (n === 0) return [model, []];
      const dir = msg.dir < 0 ? -1 : 1;
      const nextIdx = Math.max(0, Math.min(n - 1, f.picking.idx + dir));
      if (nextIdx === f.picking.idx) return [model, []];
      return [withModal(model, { fabricForm: { ...f, picking: { ...f.picking, idx: nextIdx } } }), []];
    }
    case 'fabric_form_choices_filter': {
      // `{ seq }` — append one printable code-unit to picking.filter, or pop
      // the last code-unit when seq === '\x7f' (backspace). Any other control
      // seq is a no-op (dispatch.js only sends printables + \x7f here; this
      // defense-in-depth stops a hand-built Msg from pushing a Tab byte into
      // the filter string). idx RESETS TO 0 on any filter change so a
      // narrowing refilter doesn't leave the highlight past the end of the
      // new filtered view (its clamp runs on the next nav / resolved reply,
      // but resetting here keeps the first visible row highlighted the frame
      // the filter changes). WAL-safe: filter lives in picking (not computed),
      // so a replay reproduces the typed state exactly.
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      if (f.picking === null) return [model, []];
      const cur = typeof f.picking.filter === 'string' ? f.picking.filter : '';
      let next;
      if (msg.seq === '\x7f') {
        if (cur.length === 0) return [model, []];
        next = cur.slice(0, -1);
      } else if (typeof msg.seq === 'string' && msg.seq.length > 0 && !/[\x00-\x1f\x7f]/.test(msg.seq)) {
        // Cap the filter at MAX_FILTER_LEN code units — anything past that
        // is a stuck key or an accidental paste, not a reasonable needle.
        // Pre-release review (code fork): the pre-concat guard was bypassable
        // by a long paste (seq is a multi-char string on `key:'paste'`), so
        // cur=127 + a 100-char paste yielded next=227. CLAMP POST-CONCAT so
        // the cap is enforced regardless of per-event seq length, and apply
        // the same surrogate-split guard the field-key arm uses so a cap
        // landing on a HIGH surrogate steps back one unit (fabric_form_key
        // L400 — same hazard class).
        next = (cur + msg.seq).slice(0, MAX_FILTER_LEN);
        if (next.length > 0) {
          const lastCU = next.charCodeAt(next.length - 1);
          if (lastCU >= 0xD800 && lastCU <= 0xDBFF) next = next.slice(0, -1);
        }
      } else {
        return [model, []];
      }
      if (next === cur) return [model, []];
      return [withModal(model, { fabricForm: {
        ...f, picking: { ...f.picking, filter: next, idx: 0 },
      } }), []];
    }
    case 'fabric_form_choices_filter_clear': {
      // Esc with a non-empty filter clears the filter FIRST; a second Esc
      // closes the popover (dispatch.js reads picking.filter.length to
      // decide which to dispatch). idx resets to 0 — the view just widened
      // back to the full list, highlight should land on the first row.
      if (!model.modes.fabricFormMode) return [model, []];
      const f = model.modal.fabricForm;
      if (f.picking === null) return [model, []];
      if (!f.picking.filter) return [model, []];
      return [withModal(model, { fabricForm: {
        ...f, picking: { ...f.picking, filter: '', idx: 0 },
      } }), []];
    }
    default:
      return [model, []];
  }
}

// CLOSED is the full initial-state shape — exported so model/store.js (initial
// model) and reducer.js (config_swap reset) spread it instead of hand-copying
// the keys. Pre-fix those two sites were missing `picking` + `requestSeq`,
// which was a latent drift risk whenever a new field was added here (R3B-SMELL1).
// _cancelKeyForField is exported for the root set_config arm, which also needs
// to emit cancel_effect per in-flight fetch when it closes a live form
// (pre-release round-2 WAL review).
module.exports = { TYPES, update, CLOSED, _cancelKeyForField };
