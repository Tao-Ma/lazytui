/**
 * Prompt overlay smoke test — typing buffer, args parsing, autosuggest ghost.
 *
 * Prompt now flows through update: prompt_enter stages a base run_action Cmd;
 * prompt_key edits model.modal.prompt.text (incl. Tab/→ ghost accept);
 * prompt_submit parses args from the text and RETURNS the run_action Cmd with
 * args merged. So these tests drive runtime.update directly and assert on the
 * emitted Cmd's args — synchronous, no spawn, no setImmediate.
 *
 * The autosuggest ghost is seeded by the CALLER (dispatch reads the yank
 * register); ghostFor() replicates that seeding here.
 *
 * Run: node js/test/test-prompt.js
 */
'use strict';

// Mute OSC52 — register.push() can print clipboard escapes.
const term = require('../io/term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

const runtime = require('../app/runtime');
const register = require('./_helpers/register');
const { describe, it, eq, assert, report } = require('./test-runner');

// Phase 4 — runtime.update is pure (returns a new model); thread the model
// through a mutable handle so each step sees the previous step's writes.
let m = runtime.getModel();

function emptyReg() { register.init({ cap: 10 }); register.clear(); }
// Replicate dispatch's ghost seeding: first line of the register top,
// suppressed when it already equals the initial text.
function ghostFor(initial) {
  const g = String(register.top() || '').split('\n')[0];
  return (g && g !== initial) ? g : '';
}
function apply(msg) { const [next] = runtime.update(m, msg); m = next; runtime.setModel(next); }
function applyCmds(msg) { const [next, cmds] = runtime.update(m, msg); m = next; runtime.setModel(next); return cmds; }
function stage(initial) {
  apply({
    type: 'prompt_enter', label: 'X', spec: '',
    text: initial || '', ghost: ghostFor(initial || ''),
    cmd: { type: 'run_action', actionKey: 'a', action: {} },
  });
}
const seq  = (s) => apply({ type: 'prompt_key', seq: s });
const keyk = (k) => apply({ type: 'prompt_key', key: k });
function type(str) { for (const ch of str) seq(ch); }
// Submit → the run_action Cmd carries the parsed args (or null if no Cmd).
function submitArgs() {
  const cmds = applyCmds({ type: 'prompt_submit' });
  return cmds.length ? cmds[0].args : null;
}

describe('[1] enter sets mode; typing + backspace; Esc cancels', () => {
  it('promptMode on; edits build text; cancel emits no Cmd', () => {
    emptyReg();
    stage('');
    eq(m.modes.promptMode, true, 'mode active');
    type('ls /tmp');
    seq('\x7f');  // backspace
    eq(m.modal.prompt.text, 'ls /tm', 'typing + backspace');
    const cmds = applyCmds({ type: 'prompt_cancel' });
    eq(m.modes.promptMode, false, 'mode cleared on cancel');
    eq(cmds.length, 0, 'cancel emits no Cmd');
  });
});

describe('[3] stray non-printable swallowed', () => {
  it('arrows + control chars do not extend the buffer', () => {
    emptyReg();
    stage('');
    keyk('up');     // arrow ignored
    seq('\x01');    // Ctrl+A — outside printable range
    seq('a');
    eq(m.modal.prompt.text, 'a', 'only the printable char landed');
  });
});

describe('[2] Enter submits parsed args (whitespace-split)', () => {
  it('three args parsed', () => {
    emptyReg();
    stage('');
    type('tail 50 -f');
    const args = submitArgs();
    eq(args.join(','), 'tail,50,-f', 'parsed');
    eq(m.modes.promptMode, false, 'mode cleared on submit');
  });
});

describe('[4] empty input → empty args array', () => {
  it('array delivered, no args', () => {
    emptyReg(); stage('');
    const args = submitArgs();
    assert(Array.isArray(args) && args.length === 0, 'empty array');
  });
});

describe('[5] extra whitespace collapses', () => {
  it('two args', () => {
    emptyReg(); stage('');
    type('  ls    /tmp   ');
    eq(submitArgs().join(','), 'ls,/tmp', 'collapsed');
  });
});

describe('[6] pre-filled initialText submits verbatim', () => {
  it('one arg from pre-fill', () => {
    emptyReg(); stage('dev9.ddns.net');
    eq(submitArgs().join(','), 'dev9.ddns.net', 'pre-fill carried');
  });
});

describe('[7] Ctrl+U clears the pre-fill', () => {
  it('empty args after clear', () => {
    emptyReg(); stage('dev9.ddns.net');
    seq('\x15');  // Ctrl+U
    eq(submitArgs().length, 0, 'wiped');
  });
});

describe('[8] pre-fill is editable', () => {
  it('backspace + type produces a new value', () => {
    emptyReg(); stage('foo.com');
    seq('\x7f'); seq('\x7f'); seq('\x7f');  // strip 'com'
    type('net');
    eq(submitArgs().join(','), 'foo.net', 'edit applied');
  });
});

// --- Autosuggest ghost (register-backed) ---

describe('[9] Enter submits the typed prefix only (not the ghost)', () => {
  it('does not auto-accept', () => {
    emptyReg(); register.push('web-1');
    stage(''); type('we');
    eq(submitArgs().join(','), 'we', 'ghost NOT auto-accepted on Enter');
  });
});

describe('[10] Tab accepts the ghost suffix', () => {
  it('completes to the full ghost', () => {
    emptyReg(); register.push('web-1');
    stage(''); seq('w'); seq('\x09');
    eq(submitArgs().join(','), 'web-1', 'Tab completed');
  });
});

describe('[11] Right-arrow also accepts the ghost', () => {
  it('completes from empty', () => {
    emptyReg(); register.push('host-42');
    stage(''); keyk('right');
    eq(submitArgs().join(','), 'host-42', 'Right completed');
  });
});

describe('[12] typing past the prefix hides the ghost; backspace restores', () => {
  it('Tab no-op when not a prefix; works again after backspace', () => {
    emptyReg(); register.push('web-1');
    stage(''); seq('w'); seq('x');   // 'wx' — not a prefix
    seq('\x09');                     // Tab — no-op (suffix empty)
    eq(m.modal.prompt.text, 'wx', 'ghost hidden, Tab did nothing');
    seq('\x7f');                     // → 'w' — prefix restored
    seq('\x09');                     // Tab — accept
    eq(submitArgs().join(','), 'web-1', 'ghost re-appeared + accepted');
  });
});

describe('[13] ghost suppressed when initialText already equals it', () => {
  it('Tab is a no-op; pre-fill submits', () => {
    emptyReg(); register.push('echo');
    stage('echo'); seq('\x09');
    eq(submitArgs().join(','), 'echo', 'pre-fill submits, Tab no-op');
  });
});

describe('[14] multi-line register top: only the first line becomes ghost', () => {
  it('newlines do not leak into the prompt', () => {
    emptyReg(); register.push('first\nsecond\nthird');
    stage(''); seq('\x09');
    eq(submitArgs().join(','), 'first', 'first line only');
  });
});

report();
