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

const CLOSED = { paneId: null, addr: null, text: '' };

function update(model, msg) {
  switch (msg.type) {
    case 'fabric_field_enter': {
      // Flat modals — don't open over a live modal (would stomp its staged
      // state); mirrors prompt_enter / confirm_enter.
      if (isChainActive(model.modes)) return [model, []];
      if (typeof msg.addr !== 'string' || !msg.addr) return [model, []];
      return [withModalMode(model, { fabricFieldMode: true }, {
        fabricField: {
          paneId: msg.paneId || null,
          addr: msg.addr,
          text: typeof msg.text === 'string' ? msg.text : '',
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
      if (text === f.text) return [model, []];
      return [withModal(model, { fabricField: { ...f, text } }), []];
    }
    case 'fabric_field_submit': {
      if (!model.modes.fabricFieldMode) return [model, []];
      const f = model.modal.fabricField;
      // Commit the raw text as a sticky inject (never re-parsed), then close —
      // one atomic reduction (the inject write + mode close), no handler cascade.
      // Empty text injects "" (a real, honoured value); use clear to remove one.
      const injected = applyInject(model, f.addr, f.text);
      return [withModalMode(injected, { fabricFieldMode: false }, { fabricField: { ...CLOSED } }), []];
    }
    case 'fabric_field_cancel':
      if (!model.modes.fabricFieldMode) return [model, []];
      return [withModalMode(model, { fabricFieldMode: false }, { fabricField: { ...CLOSED } }), []];
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
