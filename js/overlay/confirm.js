/**
 * Confirm overlay — y/N modal gate for actions with `confirm:`.
 *
 * State + behavior now live in the reducer (runtime.update: confirm_enter/
 * accept/reject). The pending effect is staged as a Cmd DESCRIPTOR (data,
 * not a closure) in model.modal.confirm.cmd; `y` re-emits it. This module is
 * render-only: renderConfirmOverlay paints model.modal.confirm.message.
 */
'use strict';

const { getModel } = require('../app/runtime');
const { esc } = require('../io/ansi');
const { renderOverlay } = require('../render/panel');

function renderConfirmOverlay() {
  const c = getModel().modal.confirm;
  if (!getModel().modes.confirmMode) return;
  // Split on \n so YAML "|" multi-line confirm: prompts render as
  // multiple lines instead of a single truncated row.
  const promptLines = String(c.message).split('\n').map(l => esc(l));
  const lines = [...promptLines, '', '[dim]\\[y] confirm   \\[n] cancel[/]'];
  renderOverlay({ lines, title: 'Confirm', maxWidth: 60 });
}

module.exports = { renderConfirmOverlay };
