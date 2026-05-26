/**
 * Selection state machine smoke test — anchor/cursor normalization,
 * char vs line mode, multi-line text resolution, register integration.
 *
 * Run: node js/test/test-select.js
 */
'use strict';

// Filter OSC52 emits — register.push will fire one on commit().
const term = require('../term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

const { S } = require('../state');
const reg = require('../register');
const sel = require('../select');
const { describe, it, eq, assert, report } = require('./test-runner');

function setUp(lines) {
  reg.init({ cap: 10 });
  reg.clear();
  S.detailLines = lines.slice();
  S.detailScroll = 0;
  // Force re-init of S.select.
  S.select = undefined;
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
    const out = sel.decorateLines(S.detailLines);
    eq(out[0], 'before', 'untouched');
    eq(out[2], 'after',  'untouched');
    assert(out[1].includes('[reverse]'), 'sel line carries [reverse]');
  });
  it('no-op when no active selection', () => {
    setUp(['x']);
    sel.cancel();
    const out = sel.decorateLines(S.detailLines);
    eq(out, S.detailLines, 'returns input ref/equal');
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
    S.focus = 'detail';
    S.terminalMode = false;
    S.detailCursor = { line: 0, col: 0 };
    S.panelHeights.detail = 10;
    S.detailScroll = 0;
  }
  it('claims keys only when focus=detail', () => {
    withDetail(['abc']);
    S.focus = 'groups';
    eq(sel.onDetailKey('v', 'v'), false, 'returns false when focus != detail');
    S.focus = 'detail';
    eq(sel.onDetailKey('v', 'v'), true, 'returns true when focus = detail');
  });
  it('v toggles char select on/off; cursor anchors', () => {
    withDetail(['hello']);
    S.detailCursor = { line: 0, col: 2 };
    sel.onDetailKey('v', 'v');
    eq(sel.isActive(), true);
    eq(S.select.kind, 'char');
    eq(S.select.anchor.col, 2);
    sel.onDetailKey('v', 'v');
    eq(sel.isActive(), false, 'second v cancels');
  });
  it('V switches to line mode (even while char already active)', () => {
    withDetail(['hello']);
    sel.onDetailKey('v', 'v');
    sel.onDetailKey('V', 'V');
    eq(S.select.kind, 'line', 'line mode now');
  });
  it('j/k move cursor; sel extends when active', () => {
    withDetail(['line0', 'line1', 'line2']);
    sel.onDetailKey('v', 'v');
    sel.onDetailKey('j', 'j');
    eq(S.detailCursor.line, 1);
    eq(S.select.cursor.line, 1, 'selection extended');
  });
  it('h/l only claimed while selection active', () => {
    withDetail(['abc']);
    eq(sel.onDetailKey('h', 'h'), false, 'h passes through when no sel');
    sel.onDetailKey('v', 'v');
    eq(sel.onDetailKey('l', 'l'), true, 'l claimed in visual mode');
    eq(S.detailCursor.col, 1, 'cursor moved right');
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
  it('cursor scroll-into-view when moving below viewport', () => {
    withDetail(Array.from({ length: 20 }, (_, i) => `line${i}`));
    S.panelHeights.detail = 5;  // innerH = 3
    for (let i = 0; i < 5; i++) sel.onDetailKey('j', 'j');
    assert(S.detailScroll > 0, `scroll advanced (got ${S.detailScroll})`);
  });
  it('clamping: cursor never escapes detailLines bounds', () => {
    withDetail(['only']);
    for (let i = 0; i < 10; i++) sel.onDetailKey('j', 'j');
    eq(S.detailCursor.line, 0, 'still on the only line');
    for (let i = 0; i < 10; i++) sel.onDetailKey('l', 'l');
    // Need active sel to claim l; without it cursor.col stays put.
    eq(S.detailCursor.col, 0);
  });
});

report();
