/**
 * Yank register — single unnamed register with a bounded history.
 *
 * Workflow: user selects text in the Detail panel (mouse drag or vim
 * `v`/`V`); on commit, register.push(text) prepends it to the history.
 * The top entry is the "current" register; older entries stay around
 * up to `getModel().register.cap` for the `"` history popup to surface.
 *
 * Mirrored to the OS clipboard via OSC52 on every push and promote, so
 * external paste keeps working in addition to the in-memory register
 * (parity with the `y` copy-menu's existing behavior).
 *
 * State shape on getModel().register:
 *   { history: string[], cap: number }
 *
 * Dedup-on-top: pushing a value equal to the current top is a no-op.
 * Repeated `y` on the same selection should not flood the history with
 * duplicates of the same string.
 */
'use strict';

const { getModel } = require('../app/runtime');
const { stdout } = require('../io/term');
const mreg = require('../leaves/register');

const DEFAULT_CAP = 100;

function init(opts) {
  const cap = (opts && Number.isInteger(opts.cap) && opts.cap > 0) ? opts.cap : DEFAULT_CAP;
  // BLESSED outside-writer (docs/v0.5-layering.md §5): one-shot lazy-init of
  // the register slice. Write-once at first use, no runtime mutation — routing
  // through update would be ceremony for a static init that can't be wrong.
  getModel().register = { history: [], cap };
}

function _ensure() {
  if (!getModel().register) init();
}

function emitOSC52(text) {
  if (typeof text !== 'string' || !text) return;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  stdout.write(`\x1b]52;c;${b64}\x07`);
}

// Writers are thin bridges over the pure leaves/register leaf (the same leaf
// runtime.update uses), plus the OSC52 effect.
//
// Production yank/popup writes flow through `update` (register_push /
// register_popup_* Msgs); the bridges below are the **test-facing setup
// API** — they exist so tests can seed the register without ceremony.
//
// In production, the root model is immutable post-Phase-4 (pure-TEA); the
// `m.register = next` writes here are an intentional, scoped escape hatch
// for test setup only. No production code path calls these writers
// directly. (`init` is the BLESSED outside-writer for the lazy boot-time
// seed — see docs/v0.5-layering.md §5.)
function push(text) {
  _ensure();
  const m = getModel();
  const [next, v] = mreg.push(m.register, text);
  m.register = next;
  if (v) emitOSC52(v);
}

function top() {
  _ensure();
  return getModel().register.history[0] || '';
}

function at(i) {
  _ensure();
  return getModel().register.history[i];
}

function historyLen() {
  _ensure();
  return getModel().register.history.length;
}

function drop(i) {
  _ensure();
  const m = getModel();
  const [next, removed] = mreg.drop(m.register, i);
  m.register = next;
  return removed;
}

function promote(i) {
  _ensure();
  const m = getModel();
  const [next, v] = mreg.promote(m.register, i);
  m.register = next;
  if (v != null) { emitOSC52(v); return true; }
  return false;
}

function clear() {
  _ensure();
  const m = getModel();
  m.register = mreg.clear(m.register);
}

module.exports = {
  init, push, top, at, historyLen, drop, promote, clear, emitOSC52,
  DEFAULT_CAP,
};
