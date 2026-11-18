/**
 * Text fields edit one CELL at a time — Backspace, Delete, ← and → step over a
 * glyph the host draws as one (❤️ 👍🏽 a flag, é as e + combining acute), and
 * a length cap never cuts one in half (char-width cellFloor / cellCeil /
 * withoutLastCell).
 *
 * Grapheme-cluster arc (2026-11-15). Backspace was implemented per field, three
 * ways: per UTF-16 unit (the filter, the palette, the fabric field and form,
 * text-view search typing, the free-config title edit — half an emoji's
 * surrogate pair left behind), per codepoint (the cmdline, the agent prompt —
 * ❤️ became ❤, 👍🏽 became 👍), and the caps kept a surrogate guard of their own.
 *
 *   [1] cellFloor / cellCeil / withoutLastCell — the boundaries
 *   [2] cmdline: a pasted ❤️ 👍🏽 goes one glyph per Backspace (raw bytes)
 *   [3] action palette: the same (raw bytes); its paste cap cuts before ❤️
 *   [4] fabric form field: the same (raw bytes); its cap cuts before ❤️
 *   [5] filter: the same (raw bytes)
 *   [6] fabric field, fabric-form choices filter, search typing, free-config
 *       title edit: one glyph per Backspace
 *   [7] agent prompt: ← → Backspace Delete step one glyph; an edit that JOINS
 *       the text either side of the cursor leaves it after the glyph, never inside
 *   [8] at a field's cap, a keystroke that joins the last glyph (a skin tone
 *       after 👍, a combining mark, a flag's second half) is dropped — it never
 *       takes the glyph already there with it
 *
 * Run: node js/test/test-edit-cells.js
 */
'use strict';

const { EventEmitter } = require('events');
const { describe, it, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const runtime = require('../app/runtime');
const store = require('../model/store');
const { getModel } = runtime;
const { _makeDataHandler } = require('../dispatch/control/input');
const { cellFloor, cellCeil } = require('../leaves/text/char-width');
const { withoutLastCell, appendCapped } = require('../leaves/text/field-window');

const HEART = '❤️';               // ❤ + VS16
const THUMB = '\u{1F44D}\u{1F3FD}';         // 👍 + skin tone
const FLAG = '\u{1F1FA}\u{1F1F8}';          // 🇺🇸
const PASTED = `X${HEART}${THUMB}`;
const BS = '\x7f';

// The real stdin handler: raw bytes in, the way a terminal sends them.
const stdin = new EventEmitter();
stdin.on('data', _makeDataHandler(stdin));
const type = (bytes) => sm.capture(() => stdin.emit('data', bytes));
const paste = (text) => type(`\x1b[200~${text}\x1b[201~`);

// Paste PASTED, then Backspace three times: one glyph each.
function backspaces(read) {
  paste(PASTED);
  const seen = [read()];
  for (let k = 0; k < 3; k++) { type(BS); seen.push(read()); }
  return seen;
}
const ONE_GLYPH_EACH = [PASTED, `X${HEART}`, 'X', ''];

describe('[1] cell boundaries', () => {
  const t = `a${HEART}${THUMB}${FLAG}é`;   // boundaries 0 1 3 7 11 13
  it('cellFloor: the last boundary at or before i', () => {
    eq([...Array(t.length + 1).keys()].map((i) => cellFloor(t, i)),
      [0, 1, 1, 3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 13]);
  });
  it('cellCeil: the first boundary at or after i', () => {
    eq([...Array(t.length + 1).keys()].map((i) => cellCeil(t, i)),
      [0, 1, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 13, 13]);
  });
  it('withoutLastCell drops one glyph, however many codepoints', () => {
    eq([HEART, THUMB, FLAG, 'é', 'ab', ''].map((s) => withoutLastCell(`x${s}`)),
      ['x', 'x', 'x', 'x', 'xa', '']);
  });
  it('a walk into a long text starts near the cut (a char below U+0300 starts a cell)', () => {
    const long = 'a'.repeat(100000) + HEART;
    eq(cellFloor(long, 100001), 100000, 'cut inside ❤️ → before it');
  });
});

describe('[2] cmdline: one glyph per Backspace (raw bytes)', () => {
  it('a pasted X❤️👍🏽', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    type(':');
    eq(backspaces(() => getModel().modal.cmdline.text), ONE_GLYPH_EACH);
  });
});

describe('[3] action palette: one glyph per Backspace (raw bytes); the cap cuts before ❤️', () => {
  it('a pasted X❤️👍🏽', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    type('p');
    eq(getModel().modes.paletteMode, true, 'precondition: the palette is open');
    eq(backspaces(() => getModel().modal.palette.filter), ONE_GLYPH_EACH);
  });
  it('a paste past the cap stops before a sequence it would cut', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    type('p');
    paste('a'.repeat(127) + HEART);                // the cap (128) lands between ❤ and VS16
    eq(getModel().modal.palette.filter, 'a'.repeat(127));
  });
});

function openForm() {
  sm.bootFresh();
  sm.resize(120, 30);
  let m = store.getModel();
  [m] = runtime.update(m, {
    type: 'fabric_form_enter',
    fields: [{ port: 'name', text: '', required: false, default: null, desc: 'name' }],
    pendingAction: { actionKey: 'greet', action: { label: 'Greet', type: 'run', script: 'echo "$name"',
      ports: { in: { name: { type: 'string' } } } } },
  });
  store.setModel(m);
}

describe('[4] fabric form field: one glyph per Backspace (raw bytes); the cap cuts before ❤️', () => {
  it('a pasted X❤️👍🏽', () => {
    openForm();
    eq(backspaces(() => getModel().modal.fabricForm.fields[0].text), ONE_GLYPH_EACH);
  });
  it('a paste past the cap (8192) stops before a sequence it would cut', () => {
    openForm();
    paste('a'.repeat(8191) + HEART);
    eq(getModel().modal.fabricForm.fields[0].text, 'a'.repeat(8191));
  });
});

describe('[5] filter: one glyph per Backspace (raw bytes)', () => {
  it('a pasted X❤️👍🏽', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    let m = store.getModel();
    [m] = runtime.update(m, { type: 'filter_enter', panel: 'actions', text: '', route: null });
    store.setModel(m);
    eq(backspaces(() => getModel().modal.filter.text), ONE_GLYPH_EACH);
  });
});

describe('[6] the other fields: one glyph per Backspace', () => {
  it('fabric field (raw bytes)', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    let m = store.getModel();
    [m] = runtime.update(m, { type: 'fabric_field_enter', addr: 'greet.name', text: '' });
    store.setModel(m);
    eq(getModel().modes.fabricFieldMode, true, 'precondition: the field is open');
    eq(backspaces(() => getModel().modal.fabricField.text), ONE_GLYPH_EACH);
  });
  it('fabric-form choices filter', () => {
    openForm();
    let m = store.getModel();
    m = { ...m, modal: { ...m.modal, fabricForm: { ...m.modal.fabricForm,
      picking: { fieldIdx: 0, items: ['a'], idx: 0, filter: PASTED } } } };
    const seen = [];
    for (let k = 0; k < 3; k++) {
      [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: BS });
      seen.push(m.modal.fabricForm.picking.filter);
    }
    eq(seen, ONE_GLYPH_EACH.slice(1));
  });
  it('text-view search typing', () => {
    const search = require('../leaves/text/search');
    let s = { search: { typing: PASTED, idx: 0 } };
    const seen = [];
    for (let k = 0; k < 3; k++) { s = search.keystroke(s, BS); seen.push(s.search.typing); }
    eq(seen, ONE_GLYPH_EACH.slice(1));
  });
  it('free-config title edit', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    const layout = (msg) => sm.api.dispatchMsg(sm.api.wrap('layout', msg));
    const L = () => sm.api.getInstanceSlice('layout');
    layout({ type: 'free_config_enter' });
    layout({ type: 'free_config_title_enter' });
    L().freeConfig.titleEdit.text = PASTED;
    const seen = [];
    for (let k = 0; k < 3; k++) {
      layout({ type: 'free_config_title_key', seq: BS });
      seen.push(L().freeConfig.titleEdit.text);
    }
    eq(seen, ONE_GLYPH_EACH.slice(1));
  });
});

describe('[7] agent prompt: ← → Backspace Delete step one glyph', () => {
  const agent = require('../panel/agent/agent');
  const inp = (s, key, seq) => agent.update({ type: 'agent_input', key, seq: seq === undefined ? key : seq, selfId: 'a1' }, s);
  const draft = (s) => [s.inputDraft.text, s.inputDraft.cursor];
  it('moves and deletes over ❤️ and 👍🏽 whole', () => {
    let s = inp(agent.init('p1', null), 'paste', PASTED);      // cursor at the end (7)
    s = inp(s, 'left');
    eq(draft(s), [PASTED, 3], '← from the end: before 👍🏽');
    s = inp(s, 'left');
    eq(draft(s), [PASTED, 1], '← again: before ❤️');
    s = inp(s, 'right');
    eq(draft(s), [PASTED, 3], '→: past ❤️');
    s = inp(s, 'delete');
    eq(draft(s), [`X${HEART}`, 3], 'Delete: 👍🏽 whole');
    s = inp(s, 'backspace', BS);
    eq(draft(s), ['X', 1], 'Backspace: ❤️ whole');
  });
  it('an edit that joins the text either side of the cursor leaves it after the glyph', () => {
    const TONE = '\u{1F3FD}';
    const at = (text, cursor) => ({ ...agent.init('p1', null), inputDraft: { text, cursor } });
    let s = inp(at(`\u{1F44D}X${TONE}`, 3), 'backspace', BS);        // 👍X🏽, delete the X
    eq(draft(s), [THUMB, 4], '👍X🏽 − X = 👍🏽, cursor after it');
    s = inp(s, 'backspace', BS);
    eq(draft(s), ['', 0], 'the next Backspace takes 👍🏽 whole');
    s = inp(at(TONE, 0), 'paste', '\u{1F44D}');                          // 👍 pasted before a lone 🏽
    eq(draft(s), [THUMB, 4], '👍 before 🏽 = 👍🏽, cursor after it');
    s = inp(at('\u0301x', 0), 'e');                                      // e before a lone combining acute
    eq(draft(s), ['e\u0301x', 2], 'e before ́ = é, cursor after it');
    s = inp(at('\u{1F1E7}\u{1F1E8}', 0), 'paste', '\u{1F1E6}');         // 🇦 before the flag 🇧🇨
    eq(draft(s), ['\u{1F1E6}\u{1F1E7}\u{1F1E8}', 4], '🇦 + 🇧🇨 = 🇦🇧 + 🇨, cursor after 🇦🇧');
  });
});

describe('[8] at a cap, a keystroke that joins the last glyph is dropped', () => {
  it('appendCapped never cuts into the text already there', () => {
    eq(appendCapped('a'.repeat(126) + '\u{1F44D}', '\u{1F3FD}', 128), 'a'.repeat(126) + '\u{1F44D}', 'a tone after 👍 at the cap');
    eq(appendCapped('a'.repeat(128), '\u0301', 128), 'a'.repeat(128), 'a combining mark after the last a');
    eq(appendCapped('a'.repeat(126) + '\u{1F1FA}', '\u{1F1F8}', 128), 'a'.repeat(126) + '\u{1F1FA}', 'a flag\'s second half');
    eq(appendCapped('a'.repeat(126), 'bc' + HEART, 128), 'a'.repeat(126) + 'bc', 'a paste: what fits whole');
  });
  it('raw bytes: the palette (128) and a form field (8192) keep their text', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    type('p');
    paste('a'.repeat(126) + '\u{1F44D}');
    paste('\u{1F3FD}');
    eq(getModel().modal.palette.filter, 'a'.repeat(126) + '\u{1F44D}', 'palette: 👍 stays');
    openForm();
    paste('a'.repeat(8190) + '\u{1F44D}');
    paste('\u{1F3FD}');
    eq(getModel().modal.fabricForm.fields[0].text, 'a'.repeat(8190) + '\u{1F44D}', 'form field: 👍 stays');
  });
});

report();
