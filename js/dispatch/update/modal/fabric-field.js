/**
 * Fabric field-edit modal sub-reducer (#D12) — the component-ports pane's in-grid
 * input editor (docs/ports-and-wires.md, "P1.5 — Component-ports pane": "Manual
 * field input = an inject"). Same shape as the cmdline / prompt editors, but the
 * buffer edits ONE input port's value and commits it as a sticky inject.
 *
 * The pane's `fabric_field_open` effect resolves the selected input row to a
 * `component.port` address (it needs model/focus access the pure pane update
 * lacks) and dispatches `fabric_field_enter`. Keys route here via the
 * `fabricFieldMode` mode handler (dispatch.js). Submit commits the RAW typed text
 * as a value — never re-parsed, honouring the fabric's bind-parameter model.
 *
 * `update(model, msg) → [model, cmds]`.
 */
'use strict';

const { withModalMode, withModal } = require('../model-ops');
const { isChainActive } = require('../../../leaves/input/modes');
const { applyInject } = require('../fabric');

const TYPES = ['fabric_field_enter', 'fabric_field_key', 'fabric_field_submit', 'fabric_field_cancel'];

const CLOSED = { paneId: null, addr: null, text: '', pendingAction: null };

// Mirror of fabric-form.js's MAX_FIELD_TEXT — same reason, same behavior.
// 8192 JS String code units (UTF-16; not bytes). See fabric-form.js's cap
// comment for the full rationale, incl. the mid-surrogate-split behavior.
// (slice-1 pre-release review Fork 2 Finding 6; shared class.)
const MAX_FIELD_TEXT = 8192;

function update(model, msg) {
  switch (msg.type) {
    case 'fabric_field_enter': {
      // Flat modals — don't open over a live modal (would stomp its staged
      // state); mirrors prompt_enter / confirm_enter.
      if (isChainActive(model.modes)) return [model, []];
      if (typeof msg.addr !== 'string' || !msg.addr) return [model, []];
      // P2 (docs/ports-and-wires.md) — an invoke-time popup opened by the
      // action-runner carries a `pendingAction` ({actionKey, action}) so submit
      // can re-dispatch the deferred run (which loops to the next missing port
      // or finally runs). ports-pane manual edits leave it null → sticky inject,
      // no cmd on submit (the atomic ports-pane behavior stays unchanged).
      return [withModalMode(model, { fabricFieldMode: true }, {
        fabricField: {
          paneId: msg.paneId || null,
          addr: msg.addr,
          text: typeof msg.text === 'string' ? msg.text : '',
          pendingAction: msg.pendingAction || null,
        },
      }), []];
    }
    case 'fabric_field_key': {
      if (!model.modes.fabricFieldMode) return [model, []];
      const f = model.modal.fabricField;
      let text = f.text;
      if (msg.seq === '\x7f') text = text.slice(0, -1);            // backspace
      else if (msg.seq === '\x15') text = '';                      // Ctrl+U — clear
      else if (msg.key === 'paste' && typeof msg.seq === 'string') {
        text += msg.seq.replace(/[\r\n]+/g, ' ');                  // single-line: collapse breaks
      } else if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32 && msg.seq.charCodeAt(0) < 127) {
        text += msg.seq;
      }
      if (text.length > MAX_FIELD_TEXT) text = text.slice(0, MAX_FIELD_TEXT);
      if (text === f.text) return [model, []];
      return [withModal(model, { fabricField: { ...f, text } }), []];
    }
    case 'fabric_field_submit': {
      if (!model.modes.fabricFieldMode) return [model, []];
      const f = model.modal.fabricField;
      // Commit the raw text as an inject (never re-parsed), then close.
      // P2 — an invoke-time popup (pendingAction set) writes ONE-SHOT so the
      // next port_consume_oneshot removes it; ports-pane manual edits (no
      // pendingAction) stay sticky as before. Empty text injects "" (a real,
      // honoured value); use clear to remove one.
      const pending = f.pendingAction;
      const injected = applyInject(model, f.addr, f.text, pending ? { oneShot: true } : null);
      const closed = withModalMode(injected, { fabricFieldMode: false }, { fabricField: { ...CLOSED } });
      // Pending → re-dispatch the deferred run via a do_run cmd (action-runner
      // re-resolves ports; if more required inputs are still missing, it opens
      // fabric-field for the next one — the loop. If ready, it runs).
      if (pending) {
        return [closed, [{ type: 'do_run', actionKey: pending.actionKey, action: pending.action }]];
      }
      return [closed, []];
    }
    case 'fabric_field_cancel':
      if (!model.modes.fabricFieldMode) return [model, []];
      return [withModalMode(model, { fabricFieldMode: false }, { fabricField: { ...CLOSED } }), []];
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
