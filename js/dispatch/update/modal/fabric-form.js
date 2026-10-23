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
];

const CLOSED = { fields: [], focusIdx: 0, pendingAction: null };

// Classify a (text, default) pair into the chip flags the submit path reads.
// `def` is the declared default (string or null); `text` is the current value.
function _chip(text, def) {
  if (def != null && text === def) return { isDefault: true,  isModified: false };
  if (text === '' && def == null)  return { isDefault: false, isModified: false };
  return                                 { isDefault: false, isModified: true  };
}

// Normalize an incoming raw field decl into the slot shape the reducer stores.
// Caller sends { port, text, required, default, desc }; the chip flags are
// recomputed here from (text, default) so a caller-provided chip can never
// drift from the text/default actually passed.
function _normalize(raw) {
  const port = String(raw && raw.port || '');
  const text = raw && typeof raw.text === 'string' ? raw.text : '';
  const required = raw && raw.required !== false;                 // default true
  const def = raw && typeof raw.default === 'string' ? raw.default : null;
  const desc = raw && typeof raw.desc === 'string' ? raw.desc : '';
  return { port, text, required, default: def, desc, ..._chip(text, def) };
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
      if (!Array.isArray(msg.fields) || msg.fields.length === 0) return [model, []];
      const fields = _partition(msg.fields.map(_normalize));
      return [withModalMode(model, { fabricFormMode: true }, {
        fabricForm: {
          fields,
          focusIdx: 0,
          pendingAction: msg.pendingAction || null,
        },
      }), []];
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
      return [withModal(model, { fabricForm: { ...f, focusIdx: nextIdx } }), []];
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
      if (!pending || !actionKey) {
        // No pending action is a degenerate state — just close.
        return [withModalMode(model, { fabricFormMode: false }, { fabricForm: { ...CLOSED } }), []];
      }
      // Write a one-shot inject for every modified field, in field order. Each
      // applyInject returns a new model; chain them. `_consumeOneShotInjects`
      // in action-runner clears them after a successful spawn.
      let next = model;
      for (const field of f.fields) {
        if (!field.isModified) continue;
        const addr = `${actionKey}.${field.port}`;
        next = applyInject(next, addr, field.text, { oneShot: true });
      }
      const closed = withModalMode(next, { fabricFormMode: false }, { fabricForm: { ...CLOSED } });
      return [closed, [{ type: 'do_run', actionKey, action: pending.action }]];
    }
    case 'fabric_form_cancel':
      if (!model.modes.fabricFormMode) return [model, []];
      // Nothing to undo — submit is atomic, so an open form has written no injects yet.
      return [withModalMode(model, { fabricFormMode: false }, { fabricForm: { ...CLOSED } }), []];
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
