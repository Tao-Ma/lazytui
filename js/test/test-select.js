/**
 * Selection state machine smoke test — anchor/cursor normalization,
 * char vs line mode, multi-line text resolution, register integration.
 *
 * Run: node js/test/test-select.js
 */
'use strict';

// Filter OSC52 emits — register.push will fire one on commit().
const term = require('../io/term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

const reg = require('../feature/register');
const sel = require('../panel/viewer/select');
const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { getInstanceSlice, dispatchKeyToFocused } = require('../panel/api');

// (c)-era key-claim adapter: the keyboard visual-mode state machine
// lives in the detail Component's update now, not in panel/viewer/select.
// `dispatchKeyToFocused` returns true when the focused Component
// returned the `_claimed` sentinel — the same semantic the retired
// `detailKey` exposed. Used by the visual-mode test section
// below to drive the state machine through the production path.
function detailKey(key, seq) { return dispatchKeyToFocused(key, seq); }


function setUp(lines) {
  reg.init({ cap: 10 });
  reg.clear();
  getInstanceSlice('detail').lines = lines.slice();
  getInstanceSlice('detail').scroll = 0;
  // Force re-init of getInstanceSlice('detail').select.
  getInstanceSlice('detail').select = undefined;
  sel.cancel();
}

describe('[1] char mode — same line', () => {
  it('selects substring inclusive of endCol', () => {
    setUp(['hello world']);
    sel.beginAt(0, 6, 'char');
    sel.extendTo(0, 10);
    eq(sel.selectedText(), 'world', 'cols 6..10 inclusive');
  });
  it('reversed anchor/cursor normalizes', () => {
    setUp(['hello world']);
    sel.beginAt(0, 10, 'char');
    sel.extendTo(0, 6);
    eq(sel.selectedText(), 'world', 'normalizes regardless of drag direction');
  });
  it('single-char selection (anchor == cursor)', () => {
    setUp(['abc']);
    sel.beginAt(0, 1, 'char');
    eq(sel.selectedText(), 'b', 'one char picked');
  });
});

describe('[2] char mode — multi-line', () => {
  it('first line from startCol to end, middle full, last 0..endCol', () => {
    setUp(['alpha', 'bravo', 'charlie']);
    sel.beginAt(0, 2, 'char');     // start at 'p'
    sel.extendTo(2, 2);            // end at 'a' of charlie
    eq(sel.selectedText(), 'pha\nbravo\ncha', 'joined with \\n');
  });
});

describe('[3] line mode', () => {
  it('V selects whole lines regardless of col', () => {
    setUp(['alpha', 'bravo', 'charlie']);
    sel.beginAt(0, 3, 'line');
    sel.extendTo(2, 1);
    eq(sel.selectedText(), 'alpha\nbravo\ncharlie', 'all 3 lines');
  });
  it('line mode commits even when cursor cols out of range', () => {
    setUp(['x', 'yy']);
    sel.beginAt(0, 999, 'line');
    sel.extendTo(1, 999);
    eq(sel.selectedText(), 'x\nyy', 'cols ignored');
  });
});

describe('[4] commit + register', () => {
  it('commit pushes selected text and clears active', () => {
    setUp(['hello', 'world']);
    sel.beginAt(0, 0, 'char');
    sel.extendTo(1, 4);
    const text = sel.commit();
    eq(text, 'hello\nworld', 'commit returns the text');
    eq(sel.isActive(), false, 'selection cleared');
    eq(reg.top(), 'hello\nworld', 'register top');
  });
  it('commit of empty string is a no-op on the register', () => {
    setUp(['']);
    sel.beginAt(0, 0, 'char');
    sel.extendTo(0, 0);
    sel.commit();
    eq(reg.historyLen(), 0, 'no entry pushed for empty selection');
  });
});

describe('[5] markup stripped during resolve', () => {
  it('highlight markup in detailLines does not leak into selection', () => {
    setUp(['plain [bold]bold[/] tail']);
    // plain text projection: "plain bold tail" (15 chars).
    // Select cols 6..9 → "bold"
    sel.beginAt(0, 6, 'char');
    sel.extendTo(0, 9);
    eq(sel.selectedText(), 'bold', 'markup stripped from yanked text');
  });
});

describe('[6] display-col → char index (CJK)', () => {
  it('clicking either cell of a 2-wide CJK char selects that char', () => {
    // "你好" = 2 chars, displayed cols [0,1] = 你, [2,3] = 好
    setUp(['你好']);
    sel.beginAt(0, 0, 'char');
    sel.extendTo(0, 0);
    eq(sel.selectedText(), '你', 'cell 0 selects first char');
    sel.beginAt(0, 1, 'char');
    sel.extendTo(0, 1);
    eq(sel.selectedText(), '你', 'cell 1 (right half of 你) selects first char too');
    sel.beginAt(0, 2, 'char');
    sel.extendTo(0, 3);
    eq(sel.selectedText(), '好', 'cells 2-3 select second char');
  });
});

describe('[7] line clamping', () => {
  it('beginAt past detailLines clamps to last line', () => {
    setUp(['only']);
    sel.beginAt(99, 0, 'char');
    sel.extendTo(99, 3);
    eq(sel.selectedText(), 'only', 'clamps to line 0 (last & only)');
  });
});

describe('[9] highlightLine — visual transform', () => {
  it('plain line gets [reverse]...[/]', () => {
    setUp(['hello world']);
    eq(sel.highlightLine('hello world', 0, 4), '[reverse]hello[/] world');
  });
  it('partial highlight in the middle', () => {
    eq(sel.highlightLine('hello world', 6, 10), 'hello [reverse]world[/]');
  });
  it('endCol past line width clamps', () => {
    eq(sel.highlightLine('abc', 0, 99), '[reverse]abc[/]');
  });
  it('startCol past line width returns line as-is', () => {
    eq(sel.highlightLine('abc', 10, 20), 'abc');
  });
  it('existing markup is dropped inside line (acceptable v1 tradeoff)', () => {
    // Source markup stripped; output is plain text with reverse over selection
    eq(sel.highlightLine('[bold]hello[/] world', 6, 10), 'hello [reverse]world[/]');
  });
  it("literal '[' chars re-escaped so richToAnsi doesn't mis-parse", () => {
    // \[ in the source markup decodes to a literal '[' in the plain
    // projection. After highlighting, we MUST re-escape so the output
    // can be re-fed into richToAnsi without those brackets being
    // mis-parsed as markup tags.
    const out = sel.highlightLine('a \\[escaped\\] b', 0, 99);
    eq(out, '[reverse]a \\[escaped\\] b[/]');
  });
});

describe('[10] decorateLines — multi-line render integration', () => {
  it('lines outside selection pass through unchanged', () => {
    setUp(['before', 'sel-line', 'after']);
    sel.beginAt(1, 0, 'char');
    sel.extendTo(1, 99);
    const out = sel.decorateLines(getInstanceSlice('detail').lines);
    eq(out[0], 'before', 'untouched');
    eq(out[2], 'after',  'untouched');
    assert(out[1].includes('[reverse]'), 'sel line carries [reverse]');
  });
  it('no-op when no active selection (reading mode = no cursor)', () => {
    setUp(['x']);
    getInstanceSlice("layout").focus = 'detail';
    sel.cancel();
    const out = sel.decorateLines(getInstanceSlice('detail').lines);
    eq(out, getInstanceSlice('detail').lines, 'pass-through; reading mode shows no cursor');
  });
});

describe('[8] cancel', () => {
  it('cancel drops active flag without registering', () => {
    setUp(['abc']);
    sel.beginAt(0, 0, 'char');
    sel.extendTo(0, 2);
    sel.cancel();
    eq(sel.isActive(), false);
    assert(reg.historyLen() === 0, 'nothing pushed');
  });
});

describe('[11] keyboard visual-mode — claim via detail Component update', () => {
  function withDetail(lines) {
    setUp(lines);
    getInstanceSlice("layout").focus = 'detail';
    getModel().modes.terminalMode = false;
    getInstanceSlice('detail').cursor = { line: 0, col: 0 };
    // viewer.update reads slice.innerH directly (set by render's R4.9
    // direct write; tests seed it to drive selection geometry without
    // rendering). panelHeights left the slice in the API-abstraction
    // arc — was a legacy co-seed here, dropped.
    getInstanceSlice('detail').innerH = 8;
    getInstanceSlice('detail').scroll = 0;
  }
  it('claims keys only when focus=detail', () => {
    withDetail(['abc']);
    getInstanceSlice("layout").focus = 'groups';
    eq(detailKey('v', 'v'), false, 'returns false when focus != detail');
    getInstanceSlice("layout").focus = 'detail';
    eq(detailKey('v', 'v'), true, 'returns true when focus = detail');
  });
  it('v lands cursor at top of current viewport', () => {
    withDetail(Array.from({ length: 10 }, (_, i) => `line${i}`));
    getInstanceSlice('detail').scroll = 3;
    detailKey('v', 'v');
    eq(sel.isActive(), true);
    eq(getInstanceSlice('detail').select.kind, 'char');
    eq(getInstanceSlice('detail').select.anchor.line, 3, 'anchor at viewport top, not line 0');
    eq(getInstanceSlice('detail').select.anchor.col, 0);
  });
  it('V starts line mode at viewport top', () => {
    withDetail(['a', 'b', 'c']);
    getInstanceSlice('detail').scroll = 1;
    detailKey('V', 'V');
    eq(getInstanceSlice('detail').select.kind, 'line');
    eq(getInstanceSlice('detail').select.anchor.line, 1);
  });
  it('reading-mode j/k scrolls the view, cursor not used', () => {
    withDetail(Array.from({ length: 20 }, (_, i) => `line${i}`));
    getInstanceSlice('detail').innerH = 3;
    eq(getInstanceSlice('detail').scroll, 0, 'starts at top');
    eq(sel.isActive(), false, 'reading mode (no select)');
    detailKey('j', 'j');
    eq(getInstanceSlice('detail').scroll, 1, 'scroll advanced by 1');
    detailKey('j', 'j');
    detailKey('j', 'j');
    eq(getInstanceSlice('detail').scroll, 3, 'scrolled 3 lines');
    detailKey('k', 'k');
    eq(getInstanceSlice('detail').scroll, 2, 'k scrolls back');
  });
  it('reading-mode j/k clamps at top and bottom', () => {
    withDetail(Array.from({ length: 10 }, (_, i) => `line${i}`));
    getInstanceSlice('detail').innerH = 3;  // maxScroll = 7
    for (let i = 0; i < 20; i++) detailKey('j', 'j');
    eq(getInstanceSlice('detail').scroll, 7, 'clamped to maxScroll');
    for (let i = 0; i < 20; i++) detailKey('k', 'k');
    eq(getInstanceSlice('detail').scroll, 0, 'clamped to 0');
  });
  it('visual-mode j/k moves cursor and extends selection', () => {
    withDetail(['line0', 'line1', 'line2', 'line3']);
    detailKey('v', 'v');
    detailKey('j', 'j');
    eq(getInstanceSlice('detail').cursor.line, 1);
    eq(getInstanceSlice('detail').select.cursor.line, 1, 'selection extended');
    detailKey('j', 'j');
    eq(getInstanceSlice('detail').cursor.line, 2);
  });
  it('visual-mode j scrolls when cursor leaves viewport', () => {
    withDetail(Array.from({ length: 20 }, (_, i) => `line${i}`));
    getInstanceSlice('detail').innerH = 3;
    detailKey('v', 'v');
    for (let i = 0; i < 5; i++) detailKey('j', 'j');
    assert(getInstanceSlice('detail').scroll > 0, `scroll auto-advanced (got ${getInstanceSlice('detail').scroll})`);
  });
  it('h/l only claimed while selection active', () => {
    withDetail(['abc']);
    eq(detailKey('h', 'h'), false, 'h passes through when no sel');
    detailKey('v', 'v');
    eq(detailKey('l', 'l'), true, 'l claimed in visual mode');
    eq(getInstanceSlice('detail').cursor.col, 1, 'cursor moved right');
  });
  it('y commits + pushes; selection cleared', () => {
    withDetail(['hello']);
    detailKey('v', 'v');
    detailKey('l', 'l');
    detailKey('l', 'l');
    detailKey('l', 'l');
    detailKey('l', 'l');
    detailKey('y', 'y');
    eq(reg.top(), 'hello', 'full word yanked');
    eq(sel.isActive(), false, 'sel cleared');
  });
  it('Esc cancels without yanking', () => {
    withDetail(['abc']);
    detailKey('v', 'v');
    detailKey('l', 'l');
    detailKey('escape', '');
    eq(sel.isActive(), false);
    eq(reg.historyLen(), 0, 'nothing pushed');
  });
});

report();
