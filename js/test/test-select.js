/**
 * Selection state machine smoke test — anchor/cursor normalization,
 * char vs line mode, multi-line text resolution, register integration.
 *
 * U2e P1b — the content slot's ACTIVE instance is now the `info` instance
 * (kind 'info'), which stores its buffer on `slice.lines` (not the retired
 * `detail.infoLines`). We boot a real seeded content slot (parse-shaped config
 * → initState → per-pane mint) and resolve it via
 * `route.resolveTarget('viewer_info')`. The keyboard visual-mode state machine
 * flows through the SHARED reducer (leaves/text/text-view-update, ownKind
 * 'info') via dispatchKeyToFocused.
 *
 * Stage-3 unification — the viewer facade (panel/content/select) is gone. The
 * `sel` driver below IS the production path minus the mouse: wrapped select_*
 * Msgs to the content slot's active instance (what input.js dispatches), reads
 * through the unified selection service (panel/select-view), and the release
 * arm's settle semantics for commit.
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

const reg = require('./_helpers/register');
const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');
const { dispatchKeyToFocused } = require('../dispatch/runtime/loop');
const route = require('../panel/route');

// --- Boot a real seeded content slot ------------------------------------
// test-runner registers layout/detail/groups but not info/text-view, and
// doesn't boot a config; the info instance is minted only through initState.
const api = require('../panel/api');
if (!api.getComponent('text-view')) api.registerComponent(require('../panel/text-view/text-view'));
if (!api.getComponent('info'))      api.registerComponent(require('../panel/info/info'));
const { initState } = require('../app/state');
getModel().config = {
  theme: 'default',
  register: { cap: 10 },
  groups: { g: { label: 'G', actions: {}, items: [{ name: 'a' }] } },
  warnings: [],
};
initState();

// The content-slot's active `info` instance — resolveTarget('viewer') lands here.
function infoSlice() { return getInstanceSlice(route.resolveTarget('viewer_info')); }

// The unified selection driver (see the header): wrapped select_* dispatch to
// the content slot's active instance + reads via panel/select-view — the same
// seams the mouse pipeline uses.
const selView = require('../panel/select-view');
const core = require('../leaves/text/select-core');
const sel = {
  beginAt(line, col, kind) {
    api.dispatchMsg(api.wrap(route.resolveTarget('viewer'), { type: 'select_begin', line, col, kind }));
  },
  extendTo(line, col) {
    api.dispatchMsg(api.wrap(route.resolveTarget('viewer'), { type: 'select_extend', line, col }));
  },
  cancel() {
    api.dispatchMsg(api.wrap(route.resolveTarget('viewer'), { type: 'select_cancel' }));
  },
  isActive() { return selView.isActive(); },
  selectedText() { return selView.selectedText(); },
  // The release arm's settle: push a non-empty selection to the register, clear.
  commit() {
    const text = selView.selectedText();
    this.cancel();
    if (text) require('../dispatch/control/dispatch').applyMsg({ type: 'register_push', text });
    return text;
  },
  highlightLine: core.highlightLine,
  decorateLines(lines) {
    const s = getInstanceSlice(route.resolveTarget('viewer'));
    return core.decorateWindow(lines, s && s.select, 0);
  },
};

// (c)-era key-claim adapter: the keyboard visual-mode state machine lives in the
// focused Component's update now (the info instance's, via the shared tvu),
// not in panel/content/select. `dispatchKeyToFocused` returns true when the
// focused Component returned the `_claimed` sentinel — the same semantic the
// retired `detailKey` exposed. Used by the visual-mode section below.
function detailKey(key, seq) { return dispatchKeyToFocused(key, seq); }


function setUp(lines) {
  reg.init({ cap: 10 });
  reg.clear();
  // U2e P1b — Info content's canonical home is the info instance's `slice.lines`.
  const s = infoSlice();
  s.lines = lines.slice();
  s.scroll = 0;
  // Force re-init of the info instance's select via a full reset shape.
  s.select = { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } };
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
    const out = sel.decorateLines(infoSlice().lines);
    eq(out[0], 'before', 'untouched');
    eq(out[2], 'after',  'untouched');
    assert(out[1].includes('[reverse]'), 'sel line carries [reverse]');
  });
  it('no-op when no active selection (reading mode = no cursor)', () => {
    setUp(['x']);
    getInstanceSlice('layout').focus = route.resolveViewerPaneId();
    sel.cancel();
    const out = sel.decorateLines(infoSlice().lines);
    eq(out, infoSlice().lines, 'pass-through; reading mode shows no cursor');
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

describe('[11] keyboard visual-mode — claim via the info instance update', () => {
  function withInfo(lines) {
    setUp(lines);
    // Focus the content SLOT so dispatchKeyToFocused routes keys to its active
    // instance (info). getFocus() returns the slot paneId; instanceKind resolves
    // it to the active `info` instance, whose ownKind gate ('info') matches.
    const slot = route.resolveViewerPaneId();
    api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: slot }));
    require('../dispatch/control/dispatch').applyMsg({ type: 'mode_clear', flag: 'terminalMode' });
    const s = infoSlice();
    s.cursor = { line: 0, col: 0 };
    // The shared tvu reducer reads slice.innerH directly (stamped by augmentMsg
    // in production; seeded here to drive selection geometry without rendering).
    s.innerH = 8;
    s.scroll = 0;
  }
  it('claims keys only when the content slot is focused', () => {
    withInfo(['abc']);
    api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: 'groups' }));
    eq(detailKey('v', 'v'), false, 'returns false when focus is a non-content pane');
    api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: route.resolveViewerPaneId() }));
    eq(detailKey('v', 'v'), true, 'returns true when the content slot is focused');
  });
  it('v lands cursor at top of current viewport', () => {
    withInfo(Array.from({ length: 10 }, (_, i) => `line${i}`));
    infoSlice().scroll = 3;
    detailKey('v', 'v');
    const s = infoSlice();
    eq(s.select.active, true);
    eq(s.select.kind, 'char');
    eq(s.select.anchor.line, 3, 'anchor at viewport top, not line 0');
    eq(s.select.anchor.col, 0);
  });
  it('V starts line mode at viewport top', () => {
    withInfo(['a', 'b', 'c']);
    infoSlice().scroll = 1;
    detailKey('V', 'V');
    const s = infoSlice();
    eq(s.select.kind, 'line');
    eq(s.select.anchor.line, 1);
  });
  it('reading-mode j/k scrolls the view, cursor not used', () => {
    withInfo(Array.from({ length: 20 }, (_, i) => `line${i}`));
    infoSlice().innerH = 3;
    eq(infoSlice().scroll, 0, 'starts at top');
    eq(sel.isActive(), false, 'reading mode (no select)');
    detailKey('j', 'j');
    eq(infoSlice().scroll, 1, 'scroll advanced by 1');
    detailKey('j', 'j');
    detailKey('j', 'j');
    eq(infoSlice().scroll, 3, 'scrolled 3 lines');
    detailKey('k', 'k');
    eq(infoSlice().scroll, 2, 'k scrolls back');
  });
  it('reading-mode j/k clamps at top and bottom', () => {
    // The dispatch path re-stamps innerH from real pane geometry (augmentMsg),
    // so a seeded slice.innerH is ignored here. Derive the real viewport height
    // and size the buffer to it so maxScroll is deterministic across terminals.
    const innerH = require('../panel/pane-viewport').paneInnerH(infoSlice()) || 1;
    const nLines = innerH * 3;
    withInfo(Array.from({ length: nLines }, (_, i) => `line${i}`));
    const maxScroll = Math.max(0, nLines - innerH);
    for (let i = 0; i < nLines + 5; i++) detailKey('j', 'j');
    eq(infoSlice().scroll, maxScroll, 'clamped to maxScroll');
    for (let i = 0; i < nLines + 5; i++) detailKey('k', 'k');
    eq(infoSlice().scroll, 0, 'clamped to 0');
  });
  it('visual-mode j/k moves cursor and extends selection', () => {
    withInfo(['line0', 'line1', 'line2', 'line3']);
    detailKey('v', 'v');
    detailKey('j', 'j');
    eq(infoSlice().cursor.line, 1);
    eq(infoSlice().select.cursor.line, 1, 'selection extended');
    detailKey('j', 'j');
    eq(infoSlice().cursor.line, 2);
  });
  it('visual-mode j scrolls when cursor leaves viewport', () => {
    // As above: real innerH drives. Fill past the viewport and step the cursor
    // beyond innerH rows so it must scroll to stay visible.
    const innerH = require('../panel/pane-viewport').paneInnerH(infoSlice()) || 1;
    withInfo(Array.from({ length: innerH * 2 }, (_, i) => `line${i}`));
    detailKey('v', 'v');
    for (let i = 0; i < innerH + 2; i++) detailKey('j', 'j');
    assert(infoSlice().scroll > 0, `scroll auto-advanced (got ${infoSlice().scroll})`);
  });
  it('h/l only claimed while selection active', () => {
    withInfo(['abc']);
    eq(detailKey('h', 'h'), false, 'h passes through when no sel');
    detailKey('v', 'v');
    eq(detailKey('l', 'l'), true, 'l claimed in visual mode');
    eq(infoSlice().cursor.col, 1, 'cursor moved right');
  });
  it('y commits + pushes; selection cleared', () => {
    withInfo(['hello']);
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
    withInfo(['abc']);
    detailKey('v', 'v');
    detailKey('l', 'l');
    detailKey('escape', '');
    eq(sel.isActive(), false);
    eq(reg.historyLen(), 0, 'nothing pushed');
  });
});

report();
