/**
 * Prefix-key (leader) bindings — registry tree + dispatch wiring.
 *
 *   [1] parseSeq tokenizer
 *   [2] registerKeyBinding tree build + conflict detection
 *   [3] resolve / continuations / tokenForEvent
 *   [4] dispatch: leader enters prefix, walk runs leaf, Esc/double-leader cancel
 *   [5] dispatch: list-select mode gates space (v enters, space toggles, v exits)
 *
 * Run: node js/test/test-keybindings.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const kb = require('../keybindings');

// ---- [1] parseSeq -------------------------------------------------

describe('[1] parseSeq', () => {
  it('splits bare chars', () => {
    eq(kb.parseSeq('gg').join(','), 'g,g');
  });
  it('treats spaces as separators ("g g" === "gg")', () => {
    eq(kb.parseSeq('g g').join(','), 'g,g');
  });
  it('strips a <leader> / <space> prefix', () => {
    eq(kb.parseSeq('<leader>gg').join(','), 'g,g');
    eq(kb.parseSeq('<space>r').join(','), 'r');
  });
  it('parses named <…> tokens', () => {
    eq(kb.parseSeq('<leader>g<up>').join(','), 'g,up');
  });
  it('passes arrays through', () => {
    eq(kb.parseSeq(['a', 'b']).join(','), 'a,b');
  });
  it('throws on empty / unterminated', () => {
    let t1 = false, t2 = false;
    try { kb.parseSeq('<leader>'); } catch { t1 = true; }
    try { kb.parseSeq('a<bad'); } catch { t2 = true; }
    assert(t1, 'empty after leader throws');
    assert(t2, 'unterminated <… throws');
  });
});

// ---- [2] registerKeyBinding ---------------------------------------

describe('[2] registerKeyBinding tree', () => {
  it('builds nested subtrees with intermediate placeholder labels', () => {
    kb.clearBindings();
    let ran = '';
    kb.registerKeyBinding('gg', { label: 'top', run: () => { ran = 'top'; } });
    kb.registerKeyBinding('ge', { label: 'end', run: () => { ran = 'end'; } });
    const root = kb.rootNode();
    assert(root.children.g && root.children.g.children, 'g is a subtree');
    eq(root.children.g.label, '+g', 'auto placeholder label');
    eq(root.children.g.children.g.label, 'top');
    root.children.g.children.e.run();
    eq(ran, 'end', 'leaf run() works');
  });
  it('labelSubtree overrides a subtree heading', () => {
    kb.labelSubtree('g', '+goto');
    eq(kb.rootNode().children.g.label, '+goto');
  });
  it('rejects a run-through-leaf conflict', () => {
    kb.clearBindings();
    kb.registerKeyBinding('a', { label: 'a', run() {} });
    let threw = false;
    try { kb.registerKeyBinding('ab', { label: 'ab', run() {} }); } catch { threw = true; }
    assert(threw, 'binding through an existing leaf throws');
  });
  it('rejects a leaf-where-subtree-exists conflict', () => {
    kb.clearBindings();
    kb.registerKeyBinding('ab', { label: 'ab', run() {} });
    let threw = false;
    try { kb.registerKeyBinding('a', { label: 'a', run() {} }); } catch { threw = true; }
    assert(threw, 'leaf landing on an existing subtree throws');
  });
  it('requires a run() function', () => {
    kb.clearBindings();
    let threw = false;
    try { kb.registerKeyBinding('z', { label: 'z' }); } catch { threw = true; }
    assert(threw);
  });
});

// ---- [3] resolve / continuations / tokenForEvent ------------------

describe('[3] resolve helpers', () => {
  it('resolve walks one step; null on miss', () => {
    kb.clearBindings();
    kb.registerKeyBinding('gg', { label: 'top', run() {} });
    const g = kb.resolve(kb.rootNode(), 'g');
    assert(g && g.children, 'g resolves to subtree');
    eq(kb.resolve(kb.rootNode(), 'x'), null, 'miss returns null');
  });
  it('continuations are sorted [token,node] pairs', () => {
    kb.clearBindings();
    kb.registerKeyBinding('r', { label: 'refresh', run() {} });
    kb.registerKeyBinding('a', { label: 'all', run() {} });
    const conts = kb.continuations(kb.rootNode());
    eq(conts.map(c => c[0]).join(','), 'a,r', 'sorted by token');
    eq(conts[1][1].label, 'refresh');
  });
  it('tokenForEvent prefers seq, falls back to key', () => {
    eq(kb.tokenForEvent('g', 'g'), 'g', 'printable from seq');
    eq(kb.tokenForEvent('up', undefined), 'up', 'named from key');
  });
});

// ---- [4] dispatch: prefix walk ------------------------------------

const { S } = require('../state');
const dispatch = require('../dispatch');

describe('[4] prefix dispatch', () => {
  it('walk descends a subtree then runs the leaf, exiting after', () => {
    kb.clearBindings();
    let ran = null;
    kb.registerKeyBinding('zz', { label: 'z-test', run: () => { ran = 'zz'; } });
    dispatch._enterPrefix();
    assert(S.prefixMode === true, 'in prefix mode');
    dispatch._handlePrefixKey('z', 'z');           // descend
    assert(S.prefixMode === true, 'still pending after subtree step');
    eq(S.prefixSeq.join(''), 'z', 'consumed token recorded');
    dispatch._handlePrefixKey('z', 'z');           // leaf → run
    eq(ran, 'zz', 'leaf ran');
    assert(S.prefixMode === false, 'exited prefix mode');
  });
  it('Esc cancels without running', () => {
    kb.clearBindings();
    let ran = false;
    kb.registerKeyBinding('q', { label: 'q', run: () => { ran = true; } });
    dispatch._enterPrefix();
    dispatch._handlePrefixKey('escape', undefined);
    assert(!ran && S.prefixMode === false, 'cancelled, nothing ran');
  });
  it('a second leader press cancels', () => {
    dispatch._enterPrefix();
    dispatch._handlePrefixKey(' ', ' ');
    assert(S.prefixMode === false, 'double-leader exits');
  });
  it('an unbound key drops out of prefix mode', () => {
    kb.clearBindings();
    dispatch._enterPrefix();
    dispatch._handlePrefixKey('x', 'x');
    assert(S.prefixMode === false, 'unbound key exits');
  });
});

// ---- [5] dispatch: list-select gating -----------------------------

const api = require('../plugins/api');
api.registerPlugin({
  name: 'kb-test',
  panelTypes: {
    listy: {
      mode: 'list',
      render() { return ''; },
      getItems() { return ['a', 'b', 'c']; },
      idOf: (x) => x,
    },
  },
});

describe('[5] v-mode gates space', () => {
  it('space enters prefix in normal mode; v enters select then space toggles', () => {
    kb.clearBindings();
    S.multiSel = {};
    S.sel = { listy: 1 };
    S.filters = {};
    S.focus = 'listy';
    S.listSelectMode = false;
    S.prefixMode = false;

    // Normal mode: space → prefix.
    dispatch._handleNormalKey(' ', ' ');
    assert(S.prefixMode === true, 'space is leader outside select mode');
    dispatch._handlePrefixKey('escape', undefined);  // clean up

    // v → enter select mode.
    dispatch._handleNormalKey('v', 'v');
    assert(S.listSelectMode === true, 'v enters list-select mode');

    // space → toggle the focused row (no prefix).
    dispatch._handleNormalKey(' ', ' ');
    assert(S.prefixMode === false, 'space does not lead inside select mode');
    eq(require('../state').multiSelCount('listy'), 1, 'focused row toggled on');

    // v → exit select mode (clears selection).
    dispatch._handleNormalKey('v', 'v');
    assert(S.listSelectMode === false, 'second v exits select mode');
    eq(require('../state').multiSelCount('listy'), 0, 'selection cleared on exit');
  });

  it('_isListPanel: true for list panels, false for detail', () => {
    eq(dispatch._isListPanel('listy'), true);
    eq(dispatch._isListPanel('detail'), false);
  });
});

report();
