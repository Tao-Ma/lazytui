/**
 * Embedded-PTY scrollback arc (v0.6.5 §5(a)) — covers:
 *   - the PURE terminal-mode chunk classifier (_classifyTerminalChunk):
 *     keyboard scrollback gestures, the mouse-mode forward gate, and
 *     wheel→scroll extraction with keystroke residue.
 *   - the scrollback EFFECTS on io/terminal (scrollSession / pages /
 *     toTop / toBottom / sessionScrollInfo / sessionMouseMode) against an
 *     injected headless Terminal — no PTY spawned.
 *
 * Run: node js/test/test-pty-scrollback.js
 */
'use strict';

// Mute OSC52 (register imports pulled transitively by the input module).
const term = require('../io/term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

const { Terminal } = require('@xterm/headless');
const { describe, it, eq, assert, report } = require('./test-runner');
const { _classifyTerminalChunk } = require('../dispatch/control/input');
const terminal = require('../io/terminal');

// --- Pure classifier --------------------------------------------------------

describe('_classifyTerminalChunk — keyboard scrollback gestures', () => {
  it('Shift+PageUp → scroll one page back', () => {
    eq(_classifyTerminalChunk('\x1b[5;2~', 'none'), { kind: 'scroll', pages: -1 });
  });
  it('Shift+PageDown → scroll one page forward', () => {
    eq(_classifyTerminalChunk('\x1b[6;2~', 'none'), { kind: 'scroll', pages: +1 });
  });
  it('Shift+Home → scroll to top', () => {
    eq(_classifyTerminalChunk('\x1b[1;2H', 'none'), { kind: 'scroll', toTop: true });
  });
  it('Shift+End → scroll to bottom', () => {
    eq(_classifyTerminalChunk('\x1b[1;2F', 'none'), { kind: 'scroll', toBottom: true });
  });
  it('the scrollback gestures fire even when the child wants mouse', () => {
    // Shift+Page* are framework gestures, not something a child reads — so
    // they intercept regardless of mouseMode.
    eq(_classifyTerminalChunk('\x1b[5;2~', 'any'), { kind: 'scroll', pages: -1 });
  });
  it('PLAIN PageUp (no Shift) forwards to the child', () => {
    eq(_classifyTerminalChunk('\x1b[5~', 'none'), { kind: 'forward', data: '\x1b[5~', snap: true });
  });
});

describe('_classifyTerminalChunk — mouse-mode forward gate', () => {
  it('child with mouse reporting on → forward raw (incl. mouse bytes)', () => {
    const wheel = '\x1b[<64;5;5M';
    eq(_classifyTerminalChunk(wheel, 'vt200'), { kind: 'forward', data: wheel });
    eq(_classifyTerminalChunk(wheel, 'any'),   { kind: 'forward', data: wheel });
  });
  it('plain keystroke (no mouse) → forward + snap to bottom', () => {
    eq(_classifyTerminalChunk('ls\r', 'none'), { kind: 'forward', data: 'ls\r', snap: true });
  });
});

describe('_classifyTerminalChunk — wheel extraction (mouseMode none)', () => {
  it('wheel-up → +3 lines back (negative), no residue', () => {
    // SGR button 64 = wheel-up (bit6 set, bit0 clear).
    eq(_classifyTerminalChunk('\x1b[<64;5;5M', 'none'), { kind: 'mouse', lines: -3, residue: '' });
  });
  it('wheel-down → +3 lines forward', () => {
    // button 65 = wheel-down (bit6 + bit0).
    eq(_classifyTerminalChunk('\x1b[<65;5;5M', 'none'), { kind: 'mouse', lines: +3, residue: '' });
  });
  it('multiple wheel events in one chunk accumulate', () => {
    eq(_classifyTerminalChunk('\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M', 'none'),
       { kind: 'mouse', lines: -9, residue: '' });
  });
  it('non-wheel mouse (a left press) is dropped, no scroll', () => {
    eq(_classifyTerminalChunk('\x1b[<0;5;5M', 'none'), { kind: 'mouse', lines: 0, residue: '' });
  });
  it('keystroke interleaved with a wheel → scroll + forward the residue', () => {
    eq(_classifyTerminalChunk('\x1b[<64;5;5Mx', 'none'), { kind: 'mouse', lines: -3, residue: 'x' });
  });
});

// --- Scrollback effects against an injected headless Terminal ---------------

function freshSession(id, rows = 4, cols = 20) {
  const xterm = new Terminal({ cols, rows, allowProposedApi: true });
  terminal._setSessionForTest(id, { screen: xterm, exited: false });
  return xterm;
}

// xterm parses writes asynchronously; flush with a write callback.
function writeSync(xterm, data) {
  return new Promise(res => xterm.write(data, res));
}

(async () => {
  // Drive the headless terminals up front (xterm parses asynchronously);
  // capture state at each step, then assert synchronously — the runner's
  // describe/it run inline and can't await.
  const id = 'test_scroll';
  const xterm = freshSession(id);
  for (let i = 1; i <= 20; i++) await writeSync(xterm, `line${i}\r\n`);
  const infoStart       = terminal.sessionScrollInfo(id);
  const movedBack       = terminal.scrollSession(id, -3);
  const infoBack        = terminal.sessionScrollInfo(id);
  await writeSync(xterm, 'NEW\r\n');               // sticky: view should hold
  const infoSticky      = terminal.sessionScrollInfo(id);
  const movedBottom     = terminal.scrollSessionToBottom(id);
  const infoBottom      = terminal.sessionScrollInfo(id);
  const movedTop        = terminal.scrollSessionToTop(id);
  const infoTop         = terminal.sessionScrollInfo(id);
  terminal.scrollSessionToBottom(id);
  const movedPage       = terminal.scrollSessionPages(id, -1);

  const mid = 'test_mouse';
  const mxterm = freshSession(mid);
  const modeStart = terminal.sessionMouseMode(mid);
  await writeSync(mxterm, '\x1b[?1000h');          // child enables mouse reporting
  const modeAfter = terminal.sessionMouseMode(mid);

  describe('scrollback effects — scrollSession / scrollInfo', () => {
    it('starts at the bottom (following live output)', () => {
      assert(infoStart.atBottom, 'should be at bottom after writes');
      eq(infoStart.linesBelow, 0, 'no lines below');
    });
    it('scrollSession(-3) moves the viewport back', () => {
      assert(movedBack, 'viewport should move');
      assert(!infoBack.atBottom, 'no longer at bottom');
      eq(infoBack.linesBelow, 3, '3 lines below the viewport');
    });
    it('writing while scrolled up is sticky (view holds)', () => {
      assert(!infoSticky.atBottom, 'still scrolled up after new output');
      eq(infoSticky.linesBelow, 4, 'now 4 lines below (one more accrued)');
    });
    it('scrollSessionToBottom resumes following', () => {
      assert(movedBottom, 'viewport should snap');
      assert(infoBottom.atBottom, 'back at bottom');
    });
    it('scrollSessionToTop / scrollSessionPages move the viewport', () => {
      assert(movedTop, 'to-top moves');
      eq(infoTop.atBottom, false, 'top is not bottom');
      assert(movedPage, 'page-back moves');
    });
    it('effects no-op on an unknown session id', () => {
      eq(terminal.scrollSession('nope', -3), false);
      eq(terminal.sessionScrollInfo('nope'), { atBottom: true, linesBelow: 0 });
    });
  });

  describe('sessionMouseMode reflects the child DEC mode', () => {
    it("defaults to 'none'", () => eq(modeStart, 'none'));
    it('flips when the child enables mouse reporting', () => eq(modeAfter, 'vt200'));
    it("unknown session → 'none'", () => eq(terminal.sessionMouseMode('nope'), 'none'));
  });

  report();
})();
