/**
 * Diagnostics-window sub-reducer (leader e, #D12). Mirrors jobs_*: open/close
 * flip the mode + reset cursor; nav clamps against the handler-supplied count
 * (the diag-log buffer is out-of-TEA, read renderer-side, so the count is
 * threaded in like jobs). clear / save are effects.
 * `update(model, msg) → [model, cmds]`.
 */
'use strict';

const { withModes: _withModes, withModal: _withModal } = require('../model-ops');

const TYPES = ['diag_log_open', 'diag_log_close', 'diag_log_nav', 'diag_log_clear', 'diag_log_save'];

function update(model, msg) {
  switch (msg.type) {
    case 'diag_log_open':
      if (model.modes.diagLogMode) return [model, []];
      // `now` stamped by the handler; the frame clock ticks via the
      // model-conditional `clock` interval Sub (FIX-3 Phase 6).
      return [{
        ..._withModes(model, { diagLogMode: true }),
        modal: { ...model.modal, diagLog: { cursor: 0, scroll: 0 } },
        now: msg.now || model.now,
      }, []];
    case 'diag_log_close':
      if (!model.modes.diagLogMode) return [model, []];
      return [_withModes(model, { diagLogMode: false }), []];
    case 'diag_log_nav': {
      const d = model.modal.diagLog;
      const count = msg.count | 0;
      const vh = Math.max(1, msg.vh | 0);
      if (count <= 0) return [model, []];
      let next = d.cursor;
      if (msg.to === 'top')           next = 0;
      else if (msg.to === 'bottom')    next = count - 1;
      else if (msg.to === 'pageup')    next = d.cursor - vh;
      else if (msg.to === 'pagedown')  next = d.cursor + vh;
      else                              next = d.cursor + ((msg.dir | 0) || 0);
      next = Math.max(0, Math.min(count - 1, next));
      let scroll = d.scroll | 0;
      if (next < scroll)            scroll = next;
      else if (next >= scroll + vh) scroll = next - vh + 1;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, count - vh)));
      if (next === d.cursor && scroll === d.scroll) return [model, []];
      return [_withModal(model, { diagLog: { cursor: next, scroll } }), []];
    }
    case 'diag_log_clear':
      // Buffer mutation is a side-effect → Cmd. Reset the cursor here.
      return [_withModal(model, { diagLog: { cursor: 0, scroll: 0 } }), [{ type: 'diag_clear' }]];
    case 'diag_log_save':
      return [model, [{ type: 'diag_save' }]];
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
