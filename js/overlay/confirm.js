/**
 * Confirm overlay — y/N modal gate for actions with `confirm:`.
 *
 * State + behavior now live in the reducer (runtime.update: confirm_enter/
 * accept/reject). The pending effect is staged as a Cmd DESCRIPTOR (data,
 * not a closure) on model.modal.continuation (E14); `y` re-emits it. This
 * module is render-only: renderConfirmOverlay paints model.modal.confirm.message.
 *
 * v0.6.44 Brief 3 — when the staged cmd is `do_run` on an action with
 * declared `ports.in`, append a preview block showing the action's
 * script line and each port's resolution shape (`name=<value>` with a
 * source tag; sensitive ports mask as `name=••••••`). Format at render
 * time from the already-staged cmd — no new Msg carries the formatted
 * text (the brief's "format at render time, don't stamp into a Msg"
 * invariant). The preview reads live model state (injects / defaults /
 * sensitive flags via the parsed port decl); the ports form (if the
 * action also opens one after confirm) later refines any `<pending>`
 * fields through its own compact footer preview.
 */
'use strict';

const { getModel } = require('../model/store');
const { esc } = require('../leaves/text/ansi');
const { renderOverlay } = require('../leaves/render/draw');
const { formatPreview } = require('../leaves/ports/submit-preview');

function renderConfirmOverlay() {
  const model = getModel();
  const c = model.modal.confirm;
  if (!model.modes.confirmMode) return;
  // Split on \n so YAML "|" multi-line confirm: prompts render as
  // multiple lines instead of a single truncated row.
  const promptLines = String(c.message).split('\n').map(l => esc(l));
  const lines = [...promptLines];

  // v0.6.44 Brief 3 — append preview block when the staged cmd is a
  // `do_run` on an action with declared `ports.in`.
  const cont = model.modal.continuation;
  if (cont && cont.type === 'do_run' && cont.action && cont.action.ports && cont.action.ports.in) {
    const injects = (model.fabric && model.fabric.injects) || {};
    const action = cont.action;
    const actionKey = cont.actionKey;
    const boundPorts = [];
    let variadic = null;
    for (const [name, decl] of Object.entries(action.ports.in)) {
      const addr = `${actionKey}.${name}`;
      const inj = injects[addr];
      if (decl && decl.variadic === true) {
        variadic = {
          name, decl,
          items: Array.isArray(inj) ? inj.map(String) : [],
        };
        continue;
      }
      const def = decl && decl.default != null ? String(decl.default) : null;
      const value = inj != null ? String(inj) : def;
      const source = inj != null ? 'inject' : (def != null ? 'default' : null);
      boundPorts.push({ name, decl, value, source });
    }
    const previewLines = formatPreview({
      script: action.script || '',
      boundPorts, variadic,
    });
    if (previewLines.length > 0) {
      lines.push('');
      lines.push('[dim]── preview ──[/]');
      for (const pl of previewLines) lines.push(pl);
    }
  }

  lines.push('');
  lines.push('[dim]\\[y] confirm   \\[n] cancel[/]');
  renderOverlay({ lines, title: 'Confirm', maxWidth: 72 });
}

module.exports = { renderConfirmOverlay };
