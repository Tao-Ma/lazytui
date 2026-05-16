/**
 * Confirm overlay — y/N modal gate for actions with `confirm:`.
 *
 * Pattern mirrors copy.js: one S flag (S.confirmMode) so the render
 * conductor + modeChain can detect "an overlay is active"; transient
 * buffers (prompt text, the proceed callback) live module-private.
 *
 * Flow: caller stages a callback via enterConfirm(prompt, onProceed);
 * dispatch.js routes keys here while S.confirmMode is true; 'y' fires
 * onProceed and exits, 'n'/Esc exits without firing.
 */
'use strict';

const { S } = require('./state');
const { esc } = require('./ansi');
const { renderOverlay } = require('./panel');

let _prompt = '';
let _onProceed = null;

function enterConfirm(prompt, onProceed) {
  _prompt = prompt || 'Are you sure?';
  _onProceed = typeof onProceed === 'function' ? onProceed : null;
  S.confirmMode = true;
}

function exitConfirm(commit) {
  const fn = _onProceed;
  S.confirmMode = false;
  _prompt = '';
  _onProceed = null;
  // Defer the proceed callback so the input pump's trailing render()
  // paints the overlay-gone frame BEFORE doRun() blocks on spawn(). Without
  // this, a 20–50ms fork/exec sits between the keypress and the visible
  // dismissal — perceived as lag vs the x-menu (which only mutates state).
  if (commit && fn) setImmediate(fn);
}

function handleConfirmKey(key, seq) {
  if (key === 'escape' || seq === 'n' || seq === 'N') { exitConfirm(false); return; }
  if (seq === 'y' || seq === 'Y' || key === 'return')  { exitConfirm(true);  return; }
  // Anything else is swallowed — keeps stray keystrokes from leaking
  // into the underlying panel and accidentally triggering work.
}

function renderConfirmOverlay() {
  if (!S.confirmMode) return;
  // Split on \n so YAML "|" multi-line confirm: prompts render as
  // multiple lines instead of a single truncated row.
  const promptLines = String(_prompt).split('\n').map(l => esc(l));
  const lines = [...promptLines, '', '[dim]\\[y] confirm   \\[n] cancel[/]'];
  renderOverlay({ lines, title: 'Confirm', maxWidth: 60 });
}

module.exports = { enterConfirm, exitConfirm, handleConfirmKey, renderConfirmOverlay };
