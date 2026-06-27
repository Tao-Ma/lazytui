/**
 * Copy-menu modal sub-reducer (#D12). The content thunks stay module-held
 * (overlay/copy.js), resolved by the copy_commit Cmd carrying the chosen idx
 * (decision-A copy-split). `update(model, msg) → [model, cmds]`.
 */
'use strict';

const { withModalMode: _withModalMode, withModal: _withModal } = require('../model-ops');

const TYPES = ['copy_enter', 'copy_nav', 'copy_select', 'copy_cancel'];

function update(model, msg) {
  switch (msg.type) {
    case 'copy_enter':
      return [_withModalMode(model, { copyMode: true },
        { copy: { options: msg.options || [], idx: 0 } }), []];
    case 'copy_nav': {
      const c = model.modal.copy;
      if (!c.options.length) return [model, []];
      const idx = (c.idx + msg.dir + c.options.length) % c.options.length;
      if (idx === c.idx) return [model, []];
      return [_withModal(model, { copy: { ...c, idx } }), []];
    }
    case 'copy_select': {
      if (!model.modes.copyMode) return [model, []];
      const idx = model.modal.copy.idx;
      // #F4.4 — carry the chosen option's `label` on the Cmd so the use-site
      // alignment guard compares against what the user saw. Captured HERE
      // (reduce time) because `next` clears `options`, so the effect can no
      // longer read it back from the model.
      const chosen = model.modal.copy.options[idx];
      const next = _withModalMode(model, { copyMode: false }, { copy: { options: [], idx: 0 } });
      return [next, [{ type: 'copy_commit', idx, label: chosen ? chosen.label : undefined }]];
    }
    case 'copy_cancel':
      if (!model.modes.copyMode) return [model, []];
      return [_withModalMode(model, { copyMode: false }, { copy: { options: [], idx: 0 } }),
        [{ type: 'copy_commit', idx: -1 }]];  // -1 = clear, no copy
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
