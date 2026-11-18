/**
 * Text fields edit one CELL at a time — Backspace, Delete, ← and → step over a
 * glyph the host draws as one (❤️ 👍🏽 a flag, é as e + combining acute), and
 * a length cap never cuts one in half (char-width cellFloor / cellCeil,
 * field-window withoutLastCell / appendCapped).
 *
 * Grapheme-cluster arc (2026-11-15). Backspace was implemented per field, three
 * ways: per UTF-16 unit (the filter, the palette, the fabric field and form,
 * text-view search typing, the free-config title edit — half an emoji's
 * surrogate pair left behind), per codepoint (the cmdline, the agent prompt —
 * ❤️ became ❤, 👍🏽 became 👍), and the caps kept a surrogate guard of their own.
 *
 *   [1] cellFloor / cellCeil / withoutLastCell — the boundaries
 *   [2] every one-line field: a pasted X❤️👍🏽 goes one glyph per Backspace
 *       (raw bytes, all nine fields)
 *   [3] the palette's and the fabric form's caps cut before ❤️, not through it
 *   [4] agent prompt: ← → Backspace Delete step one glyph; an edit that JOINS
 *       the text either side of the cursor leaves it after the glyph, never inside
 *   [5] at a field's cap, a keystroke that joins the last glyph (a skin tone
 *       after 👍, a combining mark, a flag's second half) is dropped — it never
 *       takes the glyph already there with it
 *
 * Run: node js/test/test-cell-edit.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const runtime = require('../app/runtime');
const { getModel } = runtime;
const { cellFloor, cellCeil } = require('../leaves/text/char-width');
const { withoutLastCell, appendCapped } = require('../leaves/text/field-window');

const HEART = '❤️';               // ❤ + VS16
const THUMB = '\u{1F44D}\u{1F3FD}';         // 👍 + skin tone
const FLAG = '\u{1F1FA}\u{1F1F8}';          // 🇺🇸
const PASTED = `X${HEART}${THUMB}`;
const BS = '\x7f';

// The real stdin handler: raw bytes in, the way a terminal sends them; the
// nine fields (test helper text-fields).
const tf = require('./_helpers/text-fields');
const { type, paste } = tf.keys();
const { FIELDS, openForm } = tf;

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

describe('[2] every field: one glyph per Backspace (raw bytes)', () => {
  // The nine one-line fields, each opened and driven through the real stdin
  // handler (test helper text-fields).
  for (const [name, f] of Object.entries(FIELDS)) {
    it(`${name}: a pasted X❤️👍🏽`, () => {
      f.open();
      eq(backspaces(f.read), ONE_GLYPH_EACH);
    });
  }
});

describe('[3] the caps cut before a sequence they would split', () => {
  it('action palette (128): a paste past the cap stops before ❤️', () => {
    FIELDS.palette.open();
    paste('a'.repeat(127) + HEART);                // the cap (128) lands between ❤ and VS16
    eq(FIELDS.palette.read(), 'a'.repeat(127));
  });
  it('fabric form field (8192): a paste past the cap stops before ❤️', () => {
    FIELDS['fabric form field'].open();
    paste('a'.repeat(8191) + HEART);
    eq(FIELDS['fabric form field'].read(), 'a'.repeat(8191));
  });
});

describe('[4] agent prompt: ← → Backspace Delete step one glyph', () => {
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

describe('[5] at a cap, a keystroke that joins the last glyph is dropped', () => {
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
