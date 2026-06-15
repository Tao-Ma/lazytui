/**
 * Which-key popup — a centered overlay listing the available
 * continuations from the current point in the leader binding tree.
 *
 * Pure paint over getModel().prefixNode / getModel().prefixSeq (set by dispatch's prefix
 * mode). Reused for every level: after the bare leader it shows the
 * root's children; after descending into a subtree (e.g. `g`) it shows
 * that subtree's children. Subtrees render with a `+` and a trailing
 * `…` so the user knows another keystroke follows.
 *
 * Mirrors menu.js: the mode flag lives on model.modes.prefixMode, the
 * item content is derived fresh each paint from the registry, and
 * dispatch.js owns the render() call.
 */
'use strict';

const { esc } = require('../io/ansi');
const { renderOverlay } = require('../render/panel');
const { getModel } = require('../model/store');
const kb = require('../dispatch/keybindings');

/** Build the popup body lines for a binding node (markup strings). */
function whichKeyLines(node) {
  const conts = kb.continuations(node);
  if (conts.length === 0) return ['[dim](no bindings)[/]'];
  return conts.map(([tok, child]) => {
    const isSub = !!child.children;
    // Subtrees: show the group label (already `+name`) + a `…` hint
    // that more keys follow. Leaves: show their action label.
    const label = isSub
      ? `${esc(child.label || ('+' + tok))} …`
      : esc(child.label || tok);
    return `  [bold]${_padKey(tok)}[/] ${label}`;
  });
}

function renderWhichKey() {
  const node = getModel().prefixNode || kb.rootNode();
  // Title shows the pending path so nested levels are legible:
  //   "leader"  →  "leader g"
  const seq = (getModel().prefixSeq && getModel().prefixSeq.length)
    ? 'leader ' + getModel().prefixSeq.join(' ')
    : 'leader';
  renderOverlay({ lines: whichKeyLines(node), title: `\\[${seq}]`, count: null });
}

/**
 * Right-pad a key token to a small fixed column so labels line up.
 * Named tokens (`up`, `esc`) are wrapped in <> for clarity.
 */
function _padKey(tok) {
  const shown = tok.length === 1 ? tok : `<${tok}>`;
  const pad = Math.max(0, 5 - shown.length);
  return shown + ' '.repeat(pad);
}

module.exports = { renderWhichKey, whichKeyLines, _padKey };
