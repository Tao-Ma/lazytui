/**
 * Args-prompt modal sub-reducer (#D12). Same Cmd-descriptor pattern as
 * confirm: the caller stages a base do_run Cmd; submit parses args from the
 * typed text and merges them in before emitting. The ghost is seeded by the
 * caller (reading the yank register, which the reducer can't).
 * `update(model, msg) → [model, cmds]`.
 */
'use strict';

const { withModes: _withModes, withModal: _withModal } = require('../model-ops');
// Pending suffix of the autosuggest ghost (Tab/Right accept). Pure leaf —
// shared with the prompt overlay render.
const { ghostSuffix } = require('../../../leaves/render/ghost');

const TYPES = ['prompt_enter', 'prompt_key', 'prompt_submit', 'prompt_cancel'];

function update(model, msg) {
  switch (msg.type) {
    case 'prompt_enter':
      return [{
        ..._withModes(model, { promptMode: true }),
        modal: { ...model.modal, prompt: {
          label: msg.label || 'Input', spec: msg.spec || '',
          text: typeof msg.text === 'string' ? msg.text : '',
          ghost: msg.ghost || '', cmd: msg.cmd || null,
        } },
      }, []];
    case 'prompt_key': {
      const p = model.modal.prompt;
      let text = p.text;
      if (msg.seq === '\x09' || msg.key === 'right') {       // accept ghost suffix
        const tail = ghostSuffix(text, p.ghost);
        if (tail) text += tail;
      } else if (msg.seq === '\x7f') { text = text.slice(0, -1); }      // backspace
      else if (msg.seq === '\x15')   { text = ''; }                     // Ctrl+U
      // T26 — paste: bracketed-paste content arrives as key='paste',
      // seq=<full content>. Append (single-line modal: collapse line
      // breaks to single spaces so a multi-line paste doesn't break
      // the single-line UX).
      else if (msg.key === 'paste' && typeof msg.seq === 'string') {
        text += msg.seq.replace(/[\r\n]+/g, ' ');
      }
      else if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32 && msg.seq.charCodeAt(0) < 127) {
        text += msg.seq;
      }
      if (text === p.text) return [model, []];
      return [_withModal(model, { prompt: { ...p, text } }), []];
    }
    case 'prompt_submit': {
      if (!model.modes.promptMode) return [model, []];
      const p = model.modal.prompt;
      const text = p.text;
      const cmd = p.cmd;
      const next = {
        ..._withModes(model, { promptMode: false }),
        modal: { ...model.modal, prompt: { label: '', spec: '', text: '', ghost: '', cmd: null } },
      };
      const args = text.trim() ? text.trim().split(/\s+/) : [];
      return [next, cmd ? [{ ...cmd, args }] : []];
    }
    case 'prompt_cancel':
      if (!model.modes.promptMode) return [model, []];
      return [{
        ..._withModes(model, { promptMode: false }),
        modal: { ...model.modal, prompt: { label: '', spec: '', text: '', ghost: '', cmd: null } },
      }, []];
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
