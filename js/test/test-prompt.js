/**
 * Prompt overlay smoke test — typing buffer, args parsing, deferred submit.
 *
 * Submit is dispatched via setImmediate (same reason as confirm), so
 * any test observing the callback's effects uses section() + setImmediate
 * to assert after the input pump's frame would have painted.
 *
 * Run: node js/test/test-prompt.js
 */
'use strict';

// Mute OSC52 — register.push() inside reg.push() prints clipboard escapes.
const term = require('../term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

const { S } = require('../state');
const { enterPrompt, handlePromptKey } = require('../prompt');
const register = require('../register');
const { describe, it, eq, section, report } = require('./test-runner');

S.promptMode = false;

// Many of the existing tests assume an empty register so they don't
// pick up a ghost from a prior section. Reset before each describe.
function emptyReg() { register.init({ cap: 10 }); register.clear(); }

describe('[1] enter sets mode + flushes buffer', () => {
  it('promptMode flips on; typing builds text; backspace shortens; Esc cancels without firing', () => {
    emptyReg();
    let received = null;
    enterPrompt('Run: Echo', 'command [args...]', (args) => { received = args; });
    eq(S.promptMode, true, 'mode active');
    handlePromptKey('', 'l'); handlePromptKey('', 's');
    handlePromptKey('', ' '); handlePromptKey('', '/'); handlePromptKey('', 't'); handlePromptKey('', 'm'); handlePromptKey('', 'p');
    handlePromptKey('', '\x7f');  // Backspace
    handlePromptKey('', 'p');
    handlePromptKey('escape', '');
    eq(S.promptMode, false, 'mode cleared on Esc');
    eq(received, null, 'cancel does not fire callback');
  });
});

describe('[3] stray non-printable swallowed', () => {
  it('control chars do not extend buffer or fire submit', () => {
    emptyReg();
    enterPrompt('X', '', () => {});
    handlePromptKey('up', '');         // arrow ignored
    handlePromptKey('', '\x01');        // Ctrl+A — outside printable range, ignored
    handlePromptKey('', 'a');           // valid
    eq(S.promptMode, true, 'still active');
    handlePromptKey('escape', '');
  });
});

// --- Async sections — observe deferred-submit effects ---

let _firedArgs = null;
section('[2] Enter submits parsed args (whitespace-split)');
emptyReg();
enterPrompt('Run: Tail', '[lines]', (args) => { _firedArgs = args; });
'tail 50 -f'.split('').forEach(ch => handlePromptKey('', ch));
handlePromptKey('return', '');
eq(S.promptMode, false, 'mode cleared synchronously on Enter');
eq(_firedArgs, null, 'callback NOT yet fired (deferred)');
setImmediate(() => {
  eq(_firedArgs.length, 3, 'three args parsed');
  eq(_firedArgs[0], 'tail', 'first');
  eq(_firedArgs[1], '50', 'second');
  eq(_firedArgs[2], '-f', 'third');
  runStep4();
});

function runStep4() {
  let firedEmpty = null;
  section('[4] Empty input → empty args array');
  emptyReg();
  enterPrompt('X', '', (args) => { firedEmpty = args; });
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(Array.isArray(firedEmpty), true, 'array delivered');
    eq(firedEmpty.length, 0, 'no args');
    runStep5();
  });
}

function runStep5() {
  let firedExtra = null;
  section('[5] Extra whitespace collapses');
  emptyReg();
  enterPrompt('X', '', (args) => { firedExtra = args; });
  '  ls    /tmp   '.split('').forEach(ch => handlePromptKey('', ch));
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(firedExtra.length, 2, 'two args');
    eq(firedExtra[0], 'ls', 'first');
    eq(firedExtra[1], '/tmp', 'second');
    runStep6();
  });
}

function runStep6() {
  let firedDefault = null;
  section('[6] Pre-filled initialText, Enter sends pre-fill as args');
  emptyReg();
  enterPrompt('X', '[host]', (args) => { firedDefault = args; }, 'dev9.ddns.net');
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(firedDefault.length, 1, 'one arg from pre-fill');
    eq(firedDefault[0], 'dev9.ddns.net', 'pre-fill carried verbatim');
    runStep7();
  });
}

function runStep7() {
  let firedCleared = null;
  section('[7] Ctrl+U clears the pre-fill, Enter sends empty args');
  emptyReg();
  enterPrompt('X', '[host]', (args) => { firedCleared = args; }, 'dev9.ddns.net');
  handlePromptKey('', '\x15');  // Ctrl+U
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(Array.isArray(firedCleared), true, 'array delivered');
    eq(firedCleared.length, 0, 'pre-fill wiped, no args');
    runStep8();
  });
}

function runStep8() {
  let firedEdited = null;
  section('[8] Pre-fill is editable — backspace + type produces new value');
  emptyReg();
  enterPrompt('X', '[host]', (args) => { firedEdited = args; }, 'foo.com');
  handlePromptKey('', '\x7f');  // backspace 'm'
  handlePromptKey('', '\x7f');  // backspace 'o'
  handlePromptKey('', '\x7f');  // backspace 'c'
  handlePromptKey('', 'n'); handlePromptKey('', 'e'); handlePromptKey('', 't');
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(firedEdited.length, 1, 'one arg');
    eq(firedEdited[0], 'foo.net', 'edit applied to pre-fill');
    runStep9();
  });
}

// --- Autosuggest ghost (register-backed) ---

function runStep9() {
  let fired = null;
  section('[9] register top suggests as dim ghost; Enter submits typed prefix only');
  register.init({ cap: 10 }); register.clear(); register.push('web-1');
  enterPrompt('X', '[host]', (args) => { fired = args; });
  // User types "we" — prefix of "web-1" — submits "we", NOT "web-1"
  handlePromptKey('', 'w'); handlePromptKey('', 'e');
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(fired.length, 1, 'one arg');
    eq(fired[0], 'we', 'Enter does NOT auto-accept the ghost');
    runStep10();
  });
}

function runStep10() {
  let fired = null;
  section('[10] Tab accepts the ghost suffix');
  register.init({ cap: 10 }); register.clear(); register.push('web-1');
  enterPrompt('X', '[host]', (args) => { fired = args; });
  handlePromptKey('', 'w');
  handlePromptKey('', '\x09');  // Tab — accept suffix "eb-1"
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(fired[0], 'web-1', 'Tab completed to full ghost');
    runStep11();
  });
}

function runStep11() {
  let fired = null;
  section('[11] Right-arrow also accepts the ghost suffix');
  register.init({ cap: 10 }); register.clear(); register.push('host-42');
  enterPrompt('X', '', (args) => { fired = args; });
  handlePromptKey('right', '');
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(fired[0], 'host-42', 'Right-arrow completed full ghost from empty');
    runStep12();
  });
}

function runStep12() {
  let fired = null;
  section('[12] typing past the prefix hides the ghost; backspace brings it back');
  register.init({ cap: 10 }); register.clear(); register.push('web-1');
  enterPrompt('X', '', (args) => { fired = args; });
  handlePromptKey('', 'w'); handlePromptKey('', 'x');  // "wx" — not a prefix
  handlePromptKey('', '\x09');  // Tab — should be a no-op (suffix empty)
  // _text is still "wx" since ghost is hidden
  handlePromptKey('', '\x7f');  // backspace → "w" — prefix restored
  handlePromptKey('', '\x09');  // Tab — accept now
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(fired[0], 'web-1', 'ghost re-appeared after backspace and Tab accepted');
    runStep13();
  });
}

function runStep13() {
  let fired = null;
  section('[13] ghost suppressed when initialText already equals it');
  register.init({ cap: 10 }); register.clear(); register.push('echo');
  enterPrompt('X', '', (args) => { fired = args; }, 'echo');
  // _ghost should be '' because firstLine === _text at entry.
  // Tab is a no-op; Enter submits the pre-fill.
  handlePromptKey('', '\x09');
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(fired[0], 'echo', 'pre-fill submits, Tab was a no-op');
    runStep14();
  });
}

function runStep14() {
  let fired = null;
  section('[14] multi-line register top: only first line becomes ghost');
  register.init({ cap: 10 }); register.clear(); register.push('first\nsecond\nthird');
  enterPrompt('X', '', (args) => { fired = args; });
  handlePromptKey('', '\x09');   // accept ghost — should be just "first"
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(fired.length, 1, 'one arg from first line only');
    eq(fired[0], 'first', 'newlines do not leak into prompt');
    report();
  });
}
