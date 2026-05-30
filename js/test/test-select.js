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
const sel = require('../overlay/select');
const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { getComponentSlice } = require('../panel/api');


function setUp(lines) {
  reg.init({ cap: 10 });
  reg.clear();
  getComponentSlice('detail').lines = lines.slice();
  getComponentSlice('detail').scroll = 0;
  // Force re-init of getComponentSlice('detail').select.
  getComponentSlice('detail').select = undefined;
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
    const out = sel.decorateLines(getComponentSlice('detail').lines);
    eq(out[0], 'before', 'untouched');
    eq(out[2], 'after',  'untouched');
    assert(out[1].includes('[reverse]'), 'sel line carries [reverse]');
  });
  it('no-op when no active selection (reading mode = no cursor)', () => {
    setUp(['x']);
    getComponentSlice("layout").focus = 'detail';
    sel.cancel();
    const out = sel.decorateLines(getComponentSlice('detail').lines);
    eq(out, getComponentSlice('detail').lines, 'pass-through; reading mode shows no cursor');
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

describe('[11] onDetailKey — keyboard visual-mode', () => {
  function withDetail(lines) {
    setUp(lines);
    getComponentSlice("layout").focus = 'detail';
    getModel().modes.terminalMode = false;
    getComponentSlice('detail').cursor = { line: 0, col: 0 };
    getComponentSlice('layout').panelHeights.detail = 10;
    getComponentSlice('detail').scroll = 0;
  }
  it('claims keys only when focus=detail', () => {
    withDetail(['abc']);
    getComponentSlice("layout").focus = 'groups';
    eq(sel.onDetailKey('v', 'v'), false, 'returns false when focus != detail');
    getComponentSlice("layout").focus = 'detail';
    eq(sel.onDetailKey('v', 'v'), true, 'returns true when focus = detail');
  });
  it('v lands cursor at top of current viewport', () => {
    withDetail(Array.from({ length: 10 }, (_, i) => `line${i}`));
    getComponentSlice('detail').scroll = 3;
    sel.onDetailKey('v', 'v');
    eq(sel.isActive(), true);
    eq(getComponentSlice('detail').select.kind, 'char');
    eq(getComponentSlice('detail').select.anchor.line, 3, 'anchor at viewport top, not line 0');
    eq(getComponentSlice('detail').select.anchor.col, 0);
  });
  it('V starts line mode at viewport top', () => {
    withDetail(['a', 'b', 'c']);
    getComponentSlice('detail').scroll = 1;
    sel.onDetailKey('V', 'V');
    eq(getComponentSlice('detail').select.kind, 'line');
    eq(getComponentSlice('detail').select.anchor.line, 1);
  });
  it('reading-mode j/k scrolls the view, cursor not used', () => {
    withDetail(Array.from({ length: 20 }, (_, i) => `line${i}`));
    getComponentSlice('layout').panelHeights.detail = 5;  // innerH = 3
    eq(getComponentSlice('detail').scroll, 0, 'starts at top');
    eq(sel.isActive(), false, 'reading mode (no select)');
    sel.onDetailKey('j', 'j');
    eq(getComponentSlice('detail').scroll, 1, 'scroll advanced by 1');
    sel.onDetailKey('j', 'j');
    sel.onDetailKey('j', 'j');
    eq(getComponentSlice('detail').scroll, 3, 'scrolled 3 lines');
    sel.onDetailKey('k', 'k');
    eq(getComponentSlice('detail').scroll, 2, 'k scrolls back');
  });
  it('reading-mode j/k clamps at top and bottom', () => {
    withDetail(Array.from({ length: 10 }, (_, i) => `line${i}`));
    getComponentSlice('layout').panelHeights.detail = 5;  // innerH = 3, maxScroll = 7
    for (let i = 0; i < 20; i++) sel.onDetailKey('j', 'j');
    eq(getComponentSlice('detail').scroll, 7, 'clamped to maxScroll');
    for (let i = 0; i < 20; i++) sel.onDetailKey('k', 'k');
    eq(getComponentSlice('detail').scroll, 0, 'clamped to 0');
  });
  it('visual-mode j/k moves cursor and extends selection', () => {
    withDetail(['line0', 'line1', 'line2', 'line3']);
    sel.onDetailKey('v', 'v');
    sel.onDetailKey('j', 'j');
    eq(getComponentSlice('detail').cursor.line, 1);
    eq(getComponentSlice('detail').select.cursor.line, 1, 'selection extended');
    sel.onDetailKey('j', 'j');
    eq(getComponentSlice('detail').cursor.line, 2);
  });
  it('visual-mode j scrolls when cursor leaves viewport', () => {
    withDetail(Array.from({ length: 20 }, (_, i) => `line${i}`));
    getComponentSlice('layout').panelHeights.detail = 5;  // innerH = 3
    sel.onDetailKey('v', 'v');
    for (let i = 0; i < 5; i++) sel.onDetailKey('j', 'j');
    assert(getComponentSlice('detail').scroll > 0, `scroll auto-advanced (got ${getComponentSlice('detail').scroll})`);
  });
  it('h/l only claimed while selection active', () => {
    withDetail(['abc']);
    eq(sel.onDetailKey('h', 'h'), false, 'h passes through when no sel');
    sel.onDetailKey('v', 'v');
    eq(sel.onDetailKey('l', 'l'), true, 'l claimed in visual mode');
    eq(getComponentSlice('detail').cursor.col, 1, 'cursor moved right');
  });
  it('y commits + pushes; selection cleared', () => {
    withDetail(['hello']);
    sel.onDetailKey('v', 'v');
    sel.onDetailKey('l', 'l');
    sel.onDetailKey('l', 'l');
    sel.onDetailKey('l', 'l');
    sel.onDetailKey('l', 'l');
    sel.onDetailKey('y', 'y');
    eq(reg.top(), 'hello', 'full word yanked');
    eq(sel.isActive(), false, 'sel cleared');
  });
  it('Esc cancels without yanking', () => {
    withDetail(['abc']);
    sel.onDetailKey('v', 'v');
    sel.onDetailKey('l', 'l');
    sel.onDetailKey('escape', '');
    eq(sel.isActive(), false);
    eq(reg.historyLen(), 0, 'nothing pushed');
  });
});

report();
