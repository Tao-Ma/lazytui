/**
 * What a single-line text field accepts — every field's key arm goes through
 * printable.fieldInput, and ^H is Backspace at the input ladder. Raw bytes in,
 * the way a terminal sends them (the real stdin handler), wherever the field
 * has a key path a test can drive.
 *
 * 2026-11-15 (after the grapheme-cluster arc). Seven fields gated typed input
 * with an ASCII check (`charCodeAt(0) >= 32 && < 127`, or `length === 1`), so
 * an IME commit (你好), an emoji picker or a compose key typed nothing — and the
 * filter's `length === 1` gate kept only the ZWJs of a typed 👨‍👩‍👧. ^H (0x08,
 * what PuTTY / `stty erase ^H` send for Backspace) only worked in the
 * free-config rename. A paste kept its tabs and escape sequences: the row
 * (esc) expanded / interpreted them while the caret math counted them as text
 * — the palette and the choices filter dropped such a paste whole.
 *
 *   [1] fieldText — a paste as a one-line field holds it
 *   [2] fieldInput — typed text vs a paste vs a key
 *   [3] typed non-ASCII lands in every field (raw UTF-8: 你好 👍🏽 👨‍👩‍👧)
 *   [4] ^H is Backspace in every field (and a kitty-protocol Ctrl+H)
 *   [5] a paste lands as the field shows it, in every field
 *
 * Run: node js/test/test-text-field-input.js
 */
'use strict';

const { EventEmitter } = require('events');
const { describe, it, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const runtime = require('../app/runtime');
const store = require('../model/store');
const { getModel } = runtime;
const { _makeDataHandler } = require('../dispatch/control/input');
const { fieldText, fieldInput } = require('../leaves/text/printable');

const THUMB = '\u{1F44D}\u{1F3FD}';                       // 👍 + skin tone
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';            // 👨 ZWJ 👩 ZWJ 👧
const TYPED = `你好${THUMB}${FAMILY}`;
const DIRTY = 'a\tb\r\nc\x1b[31md\x1b[0m\x07e';           // a tab, CRLF, SGR, BEL
const CLEAN = 'a b cde';

const stdin = new EventEmitter();
stdin.on('data', _makeDataHandler(stdin));
const type = (bytes) => sm.capture(() => stdin.emit('data', bytes));
const paste = (text) => type(`\x1b[200~${text}\x1b[201~`);

// Each field: open it (fresh boot) and read its text. Every one is driven by
// raw bytes through the real stdin handler and the mode's dispatch handler.
const boot = () => { sm.bootFresh(); sm.resize(120, 30); };
const withModel = (fn) => { let m = store.getModel(); [m] = fn(m); store.setModel(m); };
const FORM_PA = { actionKey: 'greet', action: { label: 'Greet', type: 'run', script: 'echo "$name"',
  ports: { in: { name: { type: 'string' } } } } };
const openForm = () => {
  boot();
  withModel((m) => runtime.update(m, { type: 'fabric_form_enter', pendingAction: FORM_PA,
    fields: [{ port: 'name', text: '', required: false, default: null, desc: 'name' }] }));
};
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
  'free-config rename': {
    // The rename starts from the pane's title: read what follows it.
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

describe('[1] fieldText: a paste as a one-line field holds it', () => {
  it('line breaks and tabs become one space each', () => {
    eq(fieldText('a\r\n\r\nb\tc\t\td\re'), 'a b c  d e');
  });
  it('control sequences go — SGR, CSI, OSC, a lone ESC, BEL, NUL, DEL', () => {
    eq(fieldText('a\x1b[1;31mb\x1b[0m'), 'ab', 'SGR (the row would show it as colour)');
    eq(fieldText('a\x1b[2Jb\x1b]52;c;aGk=\x07c\x1b'), 'abc', 'CSI clear, OSC 52, orphan ESC');
    eq(fieldText('a\x07\x00\x7fb'), 'ab', 'BEL NUL DEL');
  });
  it('bidi overrides go (trojan source — esc strips them from the row too)', () => {
    eq(fieldText('a‮b⁦c'), 'abc');
  });
  it('text in any script stays as it is', () => {
    eq(fieldText(`x${TYPED}é❤️`), `x${TYPED}é❤️`);
  });
});

describe('[2] fieldInput: what one keystroke Msg adds', () => {
  it('typed text in any script, a lone joiner, a skin tone', () => {
    eq(['a', '你', '\u{1F44D}', '‍', '\u{1F3FD}', '́'].map((seq) => fieldInput({ key: seq, seq })),
      ['a', '你', '\u{1F44D}', '‍', '\u{1F3FD}', '́']);
  });
  it('a control byte or a named key adds nothing', () => {
    eq(['\x7f', '\t', '\x15', '\x1b', '\r'].map((seq) => fieldInput({ key: seq, seq })), [null, null, null, null, null]);
    eq(fieldInput({ key: 'up' }), null);
  });
  it('a paste is made single-line and control-free', () => {
    eq(fieldInput({ key: 'paste', seq: DIRTY }), CLEAN);
    eq(fieldInput({ key: 'paste', seq: '\t' }), ' ', 'a lone pasted tab is a space');
  });
});

describe('[3] typed non-ASCII lands in every field (raw UTF-8, one chunk per commit)', () => {
  for (const [name, f] of Object.entries(FIELDS)) {
    it(name, () => {
      f.open();
      type('你好');               // an IME commit
      type(THUMB);                // an emoji picker: 👍 then 🏽 (one token each)
      type(FAMILY);               // 👨 ZWJ 👩 ZWJ 👧 (five tokens)
      eq(f.read(), TYPED);
    });
  }
  it('agent prompt (its mode handler forwards every key; the reducer decides)', () => {
    const agent = require('../panel/agent/agent');
    const { tokenizeInput } = require('../leaves/input/tokenize');
    let s = agent.init('p1', null);
    for (const tok of tokenizeInput(TYPED).tokens) s = agent.update({ type: 'agent_input', key: tok, seq: tok, selfId: 'a1' }, s);
    eq([s.inputDraft.text, s.inputDraft.cursor], [TYPED, TYPED.length]);
  });
});

describe('[4] ^H is Backspace in every field', () => {
  for (const [name, f] of Object.entries(FIELDS)) {
    it(name, () => {
      f.open();
      type(`ab${THUMB}`);
      type('\x08');
      eq(f.read(), 'ab', '^H takes 👍🏽 whole');
      type('\x08');
      eq(f.read(), 'a');
    });
  }
  it('a kitty-protocol Ctrl+H / BS event (CSI-u) is Backspace too', () => {
    FIELDS.cmdline.open();
    type('abc');
    type('\x1b[104;5u');          // Ctrl+h
    type('\x1b[8u');              // BS
    eq(getModel().modal.cmdline.text, 'a');
  });
});

describe('[5] a paste lands as the field shows it, in every field', () => {
  for (const [name, f] of Object.entries(FIELDS)) {
    it(name, () => {
      f.open();
      paste(DIRTY);
      eq(f.read(), CLEAN);
    });
  }
  it('agent prompt', () => {
    const agent = require('../panel/agent/agent');
    const s = agent.update({ type: 'agent_input', key: 'paste', seq: DIRTY, selfId: 'a1' }, agent.init('p1', null));
    eq([s.inputDraft.text, s.inputDraft.cursor], [CLEAN, CLEAN.length]);
  });
  it('cmdline: a pasted lone tab is text, not Tab completion', () => {
    FIELDS.cmdline.open();
    type('qu');
    paste('\t');
    eq(getModel().modal.cmdline.text, 'qu ');
  });
});

report();
