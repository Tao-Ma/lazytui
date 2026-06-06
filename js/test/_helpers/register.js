/**
 * Test-only register helpers.
 *
 * Wraps the pure leaves/register transforms with model writes, so test
 * setup can seed the register without ceremony. Production code paths
 * write the register through reducer arms (register_push / register_popup_*
 * Msgs); these wrappers exist solely for test fixtures.
 *
 * The boot-time BLESSED init lives in state.js; the rest of the surface
 * (top / at / historyLen, all pure readers) lives on leaves/register.
 */
'use strict';

const { getModel } = require('../../app/runtime');
const mreg = require('../../leaves/register');
const { emitOSC52 } = require('../../io/term');

function init(opts) {
  getModel().register = mreg.init(opts);
}

function push(text) {
  const m = getModel();
  const [next, v] = mreg.push(m.register, text);
  m.register = next;
  if (v) emitOSC52(v);
}

function top() { return mreg.top(getModel().register); }
function at(i) { return mreg.at(getModel().register, i); }
function historyLen() { return mreg.historyLen(getModel().register); }

function drop(i) {
  const m = getModel();
  const [next, removed] = mreg.drop(m.register, i);
  m.register = next;
  return removed;
}

function promote(i) {
  const m = getModel();
  const [next, v] = mreg.promote(m.register, i);
  m.register = next;
  if (v != null) { emitOSC52(v); return true; }
  return false;
}

function clear() {
  const m = getModel();
  m.register = mreg.clear(m.register);
}

module.exports = { init, push, top, at, historyLen, drop, promote, clear };
