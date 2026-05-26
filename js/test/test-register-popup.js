/**
 * Register history popup — state-only unit test (no terminal output).
 *
 * Run: node js/test/test-register-popup.js
 */
'use strict';

// Mute OSC52 writes — register.push/promote emit them.
const term = require('../term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

const { S } = require('../state');
const reg = require('../register');
const popup = require('../register-popup');
const { describe, it, eq, report } = require('./test-runner');

function setUp(entries) {
  reg.init({ cap: 100 });
  reg.clear();
  // push in reverse order so entries[0] ends up at top
  for (let i = entries.length - 1; i >= 0; i--) reg.push(entries[i]);
}

describe('[1] enter / exit', () => {
  it('enter flips mode, exit clears it', () => {
    setUp(['a', 'b']);
    popup.enter();
    eq(S.registerPopupMode, true);
    popup.handleKey('escape', '');
    eq(S.registerPopupMode, false);
  });
});

describe('[2] navigation', () => {
  it('j moves down, k moves up; clamps at ends', () => {
    setUp(['a', 'b', 'c']);
    popup.enter();
    popup.handleKey('', 'j');           // 0 → 1
    popup.handleKey('', 'j');           // 1 → 2
    popup.handleKey('', 'j');           // 2 → clamp
    // Inspect via Enter: promoting from idx 2 surfaces 'c' to top
    popup.handleKey('return', '');
    eq(reg.top(), 'c', 'idx 2 was promoted');
  });
  it('G jumps to bottom', () => {
    setUp(['a', 'b', 'c', 'd']);
    popup.enter();
    popup.handleKey('', 'G');
    popup.handleKey('return', '');
    eq(reg.top(), 'd', 'last entry promoted');
  });
  it('g jumps to top', () => {
    setUp(['a', 'b']);
    popup.enter();
    popup.handleKey('', 'G');
    popup.handleKey('', 'g');
    popup.handleKey('return', '');
    eq(reg.top(), 'a', 'still top');
  });
});

describe('[3] drop', () => {
  it('d removes highlighted entry; index stays on next-older row', () => {
    setUp(['a', 'b', 'c']);
    popup.enter();
    popup.handleKey('', 'j');           // idx=1 (entry "b")
    popup.handleKey('', 'd');           // drop "b"
    eq(reg.historyLen(), 2);
    eq(reg.at(0), 'a');
    eq(reg.at(1), 'c');
    // idx stayed at 1, which now is "c"; Enter promotes it
    popup.handleKey('return', '');
    eq(reg.top(), 'c');
  });
  it('d on last entry closes popup when history empties', () => {
    setUp(['only']);
    popup.enter();
    popup.handleKey('', 'd');
    eq(S.registerPopupMode, false, 'auto-exit on empty');
  });
});

describe('[4] promote on Enter', () => {
  it('Enter on a non-top entry moves it to top', () => {
    setUp(['a', 'b', 'c']);
    popup.enter();
    popup.handleKey('', 'j');
    popup.handleKey('', 'j');
    popup.handleKey('return', '');
    eq(reg.top(), 'c');
    eq(reg.at(1), 'a');
    eq(reg.at(2), 'b');
    eq(S.registerPopupMode, false, 'closes on Enter');
  });
  it('Enter on top entry is a no-op (closes; top unchanged)', () => {
    setUp(['a', 'b']);
    popup.enter();
    popup.handleKey('return', '');
    eq(reg.top(), 'a');
    eq(S.registerPopupMode, false);
  });
});

describe('[5] empty history', () => {
  it('opening with empty history still works; Esc closes', () => {
    reg.init({ cap: 5 });
    reg.clear();
    popup.enter();
    eq(S.registerPopupMode, true);
    popup.handleKey('escape', '');
    eq(S.registerPopupMode, false);
  });
  it('Enter on empty history closes without throwing', () => {
    reg.init({ cap: 5 });
    reg.clear();
    popup.enter();
    popup.handleKey('return', '');
    eq(S.registerPopupMode, false);
    eq(reg.historyLen(), 0);
  });
});

report();
