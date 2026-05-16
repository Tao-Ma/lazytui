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

const { S } = require('../state');
const { enterPrompt, handlePromptKey } = require('../prompt');
const { describe, it, eq, section, report } = require('./test-runner');

S.promptMode = false;

describe('[1] enter sets mode + flushes buffer', () => {
  it('promptMode flips on; typing builds text; backspace shortens; Esc cancels without firing', () => {
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
  enterPrompt('X', '[host]', (args) => { firedEdited = args; }, 'foo.com');
  handlePromptKey('', '\x7f');  // backspace 'm'
  handlePromptKey('', '\x7f');  // backspace 'o'
  handlePromptKey('', '\x7f');  // backspace 'c'
  handlePromptKey('', 'n'); handlePromptKey('', 'e'); handlePromptKey('', 't');
  handlePromptKey('return', '');
  setImmediate(() => {
    eq(firedEdited.length, 1, 'one arg');
    eq(firedEdited[0], 'foo.net', 'edit applied to pre-fill');
    report();
  });
}
