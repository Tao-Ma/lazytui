/**
 * Yank register — single unnamed register with a bounded history.
 *
 * Workflow: user selects text in the Detail panel (mouse drag or vim
 * `v`/`V`); on commit, register.push(text) prepends it to the history.
 * The top entry is the "current" register; older entries stay around
 * up to `S.register.cap` for the `"` history popup to surface.
 *
 * Mirrored to the OS clipboard via OSC52 on every push and promote, so
 * external paste keeps working in addition to the in-memory register
 * (parity with the `y` copy-menu's existing behavior).
 *
 * State shape on S.register:
 *   { history: string[], cap: number }
 *
 * Dedup-on-top: pushing a value equal to the current top is a no-op.
 * Repeated `y` on the same selection should not flood the history with
 * duplicates of the same string.
 */
'use strict';

const { S } = require('./state');
const { stdout } = require('./term');

const DEFAULT_CAP = 100;

function init(opts) {
  const cap = (opts && Number.isInteger(opts.cap) && opts.cap > 0) ? opts.cap : DEFAULT_CAP;
  S.register = { history: [], cap };
}

function _ensure() {
  if (!S.register) init();
}

function emitOSC52(text) {
  if (typeof text !== 'string' || !text) return;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  stdout.write(`\x1b]52;c;${b64}\x07`);
}

function push(text) {
  _ensure();
  if (typeof text !== 'string' || !text) return;
  const h = S.register.history;
  if (h[0] === text) {
    emitOSC52(text);  // still re-emit so the OS clipboard stays in sync
    return;
  }
  h.unshift(text);
  if (h.length > S.register.cap) h.length = S.register.cap;
  emitOSC52(text);
}

function top() {
  _ensure();
  return S.register.history[0] || '';
}

function at(i) {
  _ensure();
  return S.register.history[i];
}

function historyLen() {
  _ensure();
  return S.register.history.length;
}

function drop(i) {
  _ensure();
  if (!Number.isInteger(i) || i < 0 || i >= S.register.history.length) return false;
  S.register.history.splice(i, 1);
  return true;
}

function promote(i) {
  _ensure();
  if (!Number.isInteger(i) || i <= 0 || i >= S.register.history.length) return false;
  const [v] = S.register.history.splice(i, 1);
  S.register.history.unshift(v);
  emitOSC52(v);
  return true;
}

function clear() {
  _ensure();
  S.register.history.length = 0;
}

module.exports = {
  init, push, top, at, historyLen, drop, promote, clear,
  DEFAULT_CAP,
};
