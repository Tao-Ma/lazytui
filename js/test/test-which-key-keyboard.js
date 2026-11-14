/**
 * A leader binding on a named key fires from the keyboard.
 *
 * Found in hit-map R1 (reproduced 2026-11-14): bindings on `<tab>`,
 * `<backspace>`, `<home>`, `<end>`, `<delete>`, `<f1>` — and on the vim
 * spellings `<cr>`, `<enter>`, `<bs>`, `<del>` — were listed by the which-key
 * popup and answered a click on their row, but never fired when typed. The
 * keyboard and the sequence parser named keys differently: Tab and Backspace
 * reach the chord as their bytes (`'\t'`, `'\x7f'`), the vim aliases parsed to
 * names nothing produces, and Home/End/Insert/Delete/F-keys were dropped by the
 * input ladder as unknown escapes. Now: one vocabulary (keybindings
 * tokenForEvent + parseSeq aliases) and one decoder (leaves/input/key-decode,
 * shared with terminal mode) for every terminal's encoding of those keys.
 *
 *   [1] each named key, typed as raw host bytes, fires its binding
 *       (key path: input._dispatchToken after the leader)
 *   [2] the same key in every common host encoding (xterm, tmux/VT220, rxvt)
 *   [3] the vim aliases parse to the keyboard's names
 *   [4] a named key outside a chord does nothing visible and inserts nothing
 *   [5] keys: warns at config load for a step no keystroke can produce
 *
 * Run: node js/test/test-which-key-keyboard.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const kb = require('../leaves/input/keybindings');
const { getModel } = require('../app/runtime');
const { _dispatchToken } = require('../dispatch/control/input');

let ran = [];
function chord(seq) {
  sm.bootFresh();
  sm.resize(120, 30);
  kb.clearBindings();
  ran = [];
  kb.registerKeyBinding(seq, { label: 'x', run: () => ran.push(seq) });
}
// Leader, then the raw host bytes of the key — the real key path.
function type(...toks) { sm.capture(() => { _dispatchToken(' '); for (const t of toks) _dispatchToken(t); }); }

describe('[1] each named key, typed, fires its binding', () => {
  const rows = [
    ['<tab>', '\t'], ['<backspace>', '\x7f'], ['<backspace>', '\b'], ['<return>', '\r'],
    ['<home>', '\x1b[H'], ['<end>', '\x1b[F'], ['<insert>', '\x1b[2~'], ['<delete>', '\x1b[3~'],
    ['<pageup>', '\x1b[5~'], ['<pagedown>', '\x1b[6~'], ['<up>', '\x1b[A'], ['<backtab>', '\x1b[Z'],
    ['<f1>', '\x1bOP'], ['<f5>', '\x1b[15~'], ['<f12>', '\x1b[24~'],
  ];
  for (const [seq, bytes] of rows) {
    it(`${seq} ← ${JSON.stringify(bytes)}`, () => {
      chord(`g${seq}`);
      type('g', bytes);
      eq(ran, [`g${seq}`], 'fired');
      assert(!getModel().modes.prefixMode, 'chord closed');
    });
  }
});

describe('[2] every common host encoding of the key', () => {
  for (const [seq, forms] of [
    ['<home>', ['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~']],
    ['<end>', ['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~']],
    ['<f1>', ['\x1bOP', '\x1b[11~', '\x1b[[A']],
    ['<down>', ['\x1b[B', '\x1bOB']],
  ]) {
    for (const bytes of forms) {
      it(`${seq} ← ${JSON.stringify(bytes)}`, () => {
        chord(seq);
        type(bytes);
        eq(ran, [seq]);
      });
    }
  }
  it('a MODIFIED key is not the bare key (Ctrl+Home does not fire <home>)', () => {
    chord('<home>');
    type('\x1b[1;5H');
    eq(ran, []);
  });
});

describe('[3] vim aliases parse to the keyboard\'s names', () => {
  it('<cr> <enter> <esc> <bs> <del> <ins> <s-tab>', () => {
    eq(kb.parseSeq('<cr><enter><esc><bs><del><ins><s-tab><Home><F1>'),
      ['return', 'return', 'escape', 'backspace', 'delete', 'insert', 'backtab', 'home', 'f1']);
  });
  it('<cr> fires on Enter, <bs> on Backspace, <del> on Delete', () => {
    for (const [seq, bytes] of [['<cr>', '\r'], ['<bs>', '\x7f'], ['<del>', '\x1b[3~']]) {
      chord(seq);
      type(bytes);
      eq(ran, [seq], seq);
    }
  });
  it('<constructor> is just an unknown name (null-prototype alias map)', () => {
    eq(kb.parseSeq('<constructor>'), ['constructor']);
  });
});

describe('[4] outside a chord, a named key inserts nothing', () => {
  it('Home / F1 / Delete in the command line leave its text alone', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    sm.capture(() => { _dispatchToken(':'); _dispatchToken('a'); _dispatchToken('\x1b[1~'); _dispatchToken('\x1bOP'); _dispatchToken('\x1b[3~'); _dispatchToken('b'); });
    const m = getModel();
    assert(m.modes.cmdMode, 'precondition: command line open');
    eq(m.modal.cmdline.text, 'ab', 'only the typed characters');
    sm.capture(() => _dispatchToken('\x1b'));
  });
});

describe('[5] keys: warns for a step no keystroke can produce', () => {
  const { validate } = require('../parser/schema');
  const lint = (keys) => {
    const warnings = [];
    validate({ groups: { g: { label: 'G', actions: { a: { label: 'A', script: 'true' } } } }, keys }, 'x', warnings);
    return warnings.filter(w => w.code === 'keys.unreachable_step').map(w => w.message);
  };
  it('<esc> (cancels the chord), <ctrl-a> and a typo are flagged', () => {
    const w = lint({ 'g<esc>': { builtin: 'refresh' }, '<ctrl-a>': { builtin: 'refresh' }, 'g<hom>': { builtin: 'refresh' } });
    eq(w.length, 3);
    assert(/'escape'/.test(w[0]) && /'ctrl-a'/.test(w[1]) && /'hom'/.test(w[2]), 'each names its step');
  });
  it('typeable sequences are not', () => {
    eq(lint({ 'g<home>': { builtin: 'refresh' }, '<tab>x': { builtin: 'refresh' }, 'g<cr>': { builtin: 'refresh' }, gg: { builtin: 'refresh' } }), []);
  });
});

report();
