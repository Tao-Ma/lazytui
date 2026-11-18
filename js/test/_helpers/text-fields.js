/**
 * The one-line text fields, driven the way a terminal drives them: raw bytes
 * through the real stdin handler (`_makeDataHandler`) and each mode's dispatch
 * handler — never a reducer call, which would bypass the key normalizer.
 *
 *   const tf = require('./_helpers/text-fields');
 *   const { type, paste } = tf.keys();            // sm.capture'd (frames muted)
 *   const { type, paste } = tf.keys({ capture: false });   // a host-screen test
 *   for (const [name, f] of Object.entries(tf.FIELDS)) { f.open(); type('ab'); f.read(); }
 *
 * FIELDS: each field's `open()` (a fresh boot, then the field opened) and
 * `read()` (its text). open() types with the CAPTURING keys (frames muted) — a
 * test that reads the host screen opens its fields itself, or the frames it
 * needs never reach the screen and paint's diff runs ahead of it. The free-config rename starts from the pane's title, so
 * its read() is what follows that title; `titleText()` reads all of it.
 *
 * Require `../test-runner` (or the smoke helper) BEFORE this — component
 * registration order matters.
 */
'use strict';

const { EventEmitter } = require('events');
const sm = require('../smoke/_helpers/smoke');
const runtime = require('../../app/runtime');
const store = require('../../model/store');
const { _makeDataHandler } = require('../../dispatch/control/input');

const { getModel } = runtime;

/** `type(bytes)` / `paste(text)` into the real stdin handler. */
function keys({ capture = true } = {}) {
  const stdin = new EventEmitter();
  stdin.on('data', _makeDataHandler(stdin));
  const type = capture ? (bytes) => sm.capture(() => stdin.emit('data', bytes)) : (bytes) => stdin.emit('data', bytes);
  const paste = (text) => type(`\x1b[200~${text}\x1b[201~`);
  return { type, paste };
}

const { type } = keys();
const boot = () => { sm.bootFresh(); sm.resize(120, 30); };
const withModel = (fn) => { let m = store.getModel(); [m] = fn(m); store.setModel(m); };
const FORM_PA = { actionKey: 'greet', action: { label: 'Greet', type: 'run', script: 'echo "$name"',
  ports: { in: { name: { type: 'string' } } } } };
/** The fabric form, one field (`name`), opened over the current boot. */
const openFormOver = () => withModel((m) => runtime.update(m, { type: 'fabric_form_enter', pendingAction: FORM_PA,
  fields: [{ port: 'name', text: '', required: false, default: null, desc: 'name' }] }));
const openForm = () => { boot(); openFormOver(); };
const titleText = () => sm.api.getInstanceSlice('layout').freeConfig.titleEdit.text;
const viewer = () => sm.api.getInstanceSlice(sm.route.resolveTarget('viewer'));

const FIELDS = {
  cmdline: { open: () => { boot(); type(':'); }, read: () => getModel().modal.cmdline.text },
  filter: {
    open: () => { boot(); withModel((m) => runtime.update(m, { type: 'filter_enter', panel: 'actions', text: '', route: null })); },
    read: () => getModel().modal.filter.text,
  },
  palette: { open: () => { boot(); type('p'); }, read: () => getModel().modal.palette.filter },
  'fabric field': {
    open: () => { boot(); withModel((m) => runtime.update(m, { type: 'fabric_field_enter', addr: 'greet.name', text: '', pendingAction: FORM_PA })); },
    read: () => getModel().modal.fabricField.text,
  },
  'fabric form field': { open: openForm, read: () => getModel().modal.fabricForm.fields[0].text },
  'fabric form choices filter': {
    open: () => {
      openForm();
      store.setModel({ ...store.getModel(), modal: { ...store.getModel().modal, fabricForm: {
        ...store.getModel().modal.fabricForm, picking: { port: 'name', idx: 0, filter: '' } } } });
    },
    read: () => (getModel().modal.fabricForm.picking || {}).filter,   // (null: the popover closed)
  },
  'viewer search': {
    // ←→ to the detail viewer, `/` opens its search (the default demo layout).
    open: () => { boot(); type('\x1b[C'); type('\x1b[C'); type('/'); },
    read: () => (viewer().search || {}).typing,
  },
  // The agent prompt: `:agent` mints the pane (focused), agent_enter turns its
  // mode on (no session starts — none is needed to edit the draft).
  'agent prompt': {
    open: () => {
      if (!sm.api.getComponent('agent')) sm.api.registerComponent(require('../../panel/agent/agent'));
      boot();
      type(':'); type('agent'); type('\r');
      sm.applyMsg({ type: 'agent_enter' });
    },
    read: () => {
      let d = null;
      sm.route.eachInstance((i) => { if (i.kind === 'agent') d = i.slice.inputDraft; });
      return d ? d.text : undefined;
    },
  },
  'free-config rename': {
    open: () => {
      boot();
      const layout = (msg) => sm.api.dispatchMsg(sm.api.wrap('layout', msg));
      layout({ type: 'free_config_enter' });
      layout({ type: 'free_config_title_enter' });
      FIELDS['free-config rename'].base = titleText();
    },
    read: () => titleText().slice(FIELDS['free-config rename'].base.length),
  },
};

module.exports = { keys, FIELDS, FORM_PA, boot, withModel, openForm, openFormOver, titleText, viewer };
