/**
 * Register history popup — state-only unit test (no terminal output).
 *
 * The popup folded onto the TEA spine: `"` → register_popup_enter, and each
 * key routes through the registerPopupMode modeChain handler
 * (dispatch.handleRegisterPopupKey → register_popup_* Msgs → update). The
 * register history mutations + OSC52 ride out as register_* Cmds. So this
 * drives `enter` via applyMsg and keys via _dispatchActiveMode — the real
 * input path — rather than calling the (now removed) module handlers.
 *
 * Run: node js/test/test-register-popup.js
 */
'use strict';

// Mute OSC52 writes — register.push/promote emit them.
const term = require('../io/term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

const { getModel } = require('../app/runtime');
const dispatch = require('../dispatch/dispatch');
const reg = require('../feature/register');
const { describe, it, eq, report } = require('./test-runner');

function setUp(entries) {
  reg.init({ cap: 100 });
  reg.clear();
  // push in reverse order so entries[0] ends up at top
  for (let i = entries.length - 1; i >= 0; i--) reg.push(entries[i]);
}

// Open the popup the way `"` does (the enter Msg through the real spine).
function enter() { dispatch.applyMsg({ type: 'register_popup_enter' }); }
// Drive a key through the active mode handler (the registerPopup modeChain entry).
function press(key, seq) { dispatch._dispatchActiveMode(getModel(), key, seq); }

describe('[1] enter / exit', () => {
  it('enter flips mode, exit clears it', () => {
    setUp(['a', 'b']);
    enter();
    eq(getModel().modes.registerPopupMode, true);
    press('escape', '');
    eq(getModel().modes.registerPopupMode, false);
  });
});

describe('[2] navigation', () => {
  it('j moves down, k moves up; clamps at ends', () => {
    setUp(['a', 'b', 'c']);
    enter();
    press('', 'j');           // 0 → 1
    press('', 'j');           // 1 → 2
    press('', 'j');           // 2 → clamp
    // Inspect via Enter: promoting from idx 2 surfaces 'c' to top
    press('return', '');
    eq(reg.top(), 'c', 'idx 2 was promoted');
  });
  it('G jumps to bottom', () => {
    setUp(['a', 'b', 'c', 'd']);
    enter();
    press('', 'G');
    press('return', '');
    eq(reg.top(), 'd', 'last entry promoted');
  });
  it('g jumps to top', () => {
    setUp(['a', 'b']);
    enter();
    press('', 'G');
    press('', 'g');
    press('return', '');
    eq(reg.top(), 'a', 'still top');
  });
});

describe('[3] drop', () => {
  it('d removes highlighted entry; index stays on next-older row', () => {
    setUp(['a', 'b', 'c']);
    enter();
    press('', 'j');           // idx=1 (entry "b")
    press('', 'd');           // drop "b"
    eq(reg.historyLen(), 2);
    eq(reg.at(0), 'a');
    eq(reg.at(1), 'c');
    // idx stayed at 1, which now is "c"; Enter promotes it
    press('return', '');
    eq(reg.top(), 'c');
  });
  it('d on last entry closes popup when history empties', () => {
    setUp(['only']);
    enter();
    press('', 'd');
    eq(getModel().modes.registerPopupMode, false, 'auto-exit on empty');
  });
});

describe('[4] promote on Enter', () => {
  it('Enter on a non-top entry moves it to top', () => {
    setUp(['a', 'b', 'c']);
    enter();
    press('', 'j');
    press('', 'j');
    press('return', '');
    eq(reg.top(), 'c');
    eq(reg.at(1), 'a');
    eq(reg.at(2), 'b');
    eq(getModel().modes.registerPopupMode, false, 'closes on Enter');
  });
  it('Enter on top entry is a no-op (closes; top unchanged)', () => {
    setUp(['a', 'b']);
    enter();
    press('return', '');
    eq(reg.top(), 'a');
    eq(getModel().modes.registerPopupMode, false);
  });
});

describe('[5] empty history', () => {
  it('opening with empty history still works; Esc closes', () => {
    reg.init({ cap: 5 });
    reg.clear();
    enter();
    eq(getModel().modes.registerPopupMode, true);
    press('escape', '');
    eq(getModel().modes.registerPopupMode, false);
  });
  it('Enter on empty history closes without throwing', () => {
    reg.init({ cap: 5 });
    reg.clear();
    enter();
    press('return', '');
    eq(getModel().modes.registerPopupMode, false);
    eq(reg.historyLen(), 0);
  });
});

report();
