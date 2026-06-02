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
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');

const kb = require('../dispatch/keybindings');

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

const dispatch = require('../dispatch/dispatch');

describe('[4] prefix dispatch', () => {
  it('walk descends a subtree then runs the leaf, exiting after', () => {
    kb.clearBindings();
    let ran = null;
    kb.registerKeyBinding('zz', { label: 'z-test', run: () => { ran = 'zz'; } });
    dispatch._enterPrefix();
    assert(getModel().modes.prefixMode === true, 'in prefix mode');
    dispatch._handlePrefixKey('z', 'z');           // descend
    assert(getModel().modes.prefixMode === true, 'still pending after subtree step');
    eq(getModel().prefixSeq.join(''), 'z', 'consumed token recorded');
    dispatch._handlePrefixKey('z', 'z');           // leaf → run
    eq(ran, 'zz', 'leaf ran');
    assert(getModel().modes.prefixMode === false, 'exited prefix mode');
  });
  it('Esc cancels without running', () => {
    kb.clearBindings();
    let ran = false;
    kb.registerKeyBinding('q', { label: 'q', run: () => { ran = true; } });
    dispatch._enterPrefix();
    dispatch._handlePrefixKey('escape', undefined);
    assert(!ran && getModel().modes.prefixMode === false, 'cancelled, nothing ran');
  });
  it('a second leader press cancels', () => {
    dispatch._enterPrefix();
    dispatch._handlePrefixKey(' ', ' ');
    assert(getModel().modes.prefixMode === false, 'double-leader exits');
  });
  it('an unbound key drops out of prefix mode', () => {
    kb.clearBindings();
    dispatch._enterPrefix();
    dispatch._handlePrefixKey('x', 'x');
    assert(getModel().modes.prefixMode === false, 'unbound key exits');
  });
});

// ---- [5] dispatch: list-select gating -----------------------------

const api = require('../panel/api');
// Phase 4a — register as a Component (not a Plugin) so the test's
// list-select multi-toggle reads/writes the new per-Navigator nav slice
// via the helpers. The shared leaves/nav leaf handles set_cursor /
// multisel_*; init seeds the panel's nav entry.
const mnav = require('../leaves/nav');
api.registerComponent({
  name: 'kb-test',
  init: () => ({ nav: { listy: mnav.init() } }),
  update: (msg, slice) => mnav.isNavMsg(msg) ? mnav.apply(slice, msg) : slice,
  panelTypes: {
    listy: {
      render() { return ''; },
      getItems() { return ['a', 'b', 'c']; },
      idOf: (x) => x,
    },
  },
});

describe('[5] v-mode gates space', () => {
  it('space enters prefix in normal mode; v enters select then space toggles', () => {
    kb.clearBindings();
    require('../app/state').setSel('listy', 1);
    require('../app/state').clearMultiSel('listy');
    getInstanceSlice("layout").focus = 'listy';
    getModel().modes.listSelectMode = false;
    getModel().modes.prefixMode = false;

    // Normal mode: space → prefix.
    dispatch._handleNormalKey(' ', ' ');
    assert(getModel().modes.prefixMode === true, 'space is leader outside select mode');
    dispatch._handlePrefixKey('escape', undefined);  // clean up

    // v → enter select mode.
    dispatch._handleNormalKey('v', 'v');
    assert(getModel().modes.listSelectMode === true, 'v enters list-select mode');

    // space → toggle the focused row (no prefix).
    dispatch._handleNormalKey(' ', ' ');
    assert(getModel().modes.prefixMode === false, 'space does not lead inside select mode');
    eq(require('../app/state').multiSelCount('listy'), 1, 'focused row toggled on');

    // v → exit select mode (clears selection).
    dispatch._handleNormalKey('v', 'v');
    assert(getModel().modes.listSelectMode === false, 'second v exits select mode');
    eq(require('../app/state').multiSelCount('listy'), 0, 'selection cleared on exit');
  });

  it('_isListPanel: true for list panels, false for detail', () => {
    eq(dispatch._isListPanel('listy'), true);
    eq(dispatch._isListPanel('detail'), false);
  });
});

// ---- [6] which-key popup lines ------------------------------------

const wk = require('../overlay/which-key');

describe('[6] which-key popup', () => {
  it('lists leaves with their label and subtrees with +name …', () => {
    kb.clearBindings();
    kb.registerKeyBinding('r',  { label: 'refresh', run() {} });
    kb.registerKeyBinding('gg', { label: 'top',     run() {} });
    kb.labelSubtree('g', '+goto');
    const lines = wk.whichKeyLines(kb.rootNode());
    // sorted: g (subtree) before r (leaf)
    assert(/\+goto …/.test(lines[0]), `subtree row shows group + …: ${lines[0]}`);
    assert(/refresh/.test(lines[1]), `leaf row shows label: ${lines[1]}`);
    // descending into g shows its children as leaves
    const gNode = kb.resolve(kb.rootNode(), 'g');
    const sub = wk.whichKeyLines(gNode);
    assert(sub.some(l => /top/.test(l)), 'subtree level lists its leaves');
  });
  it('empty node renders a (no bindings) placeholder', () => {
    kb.clearBindings();
    eq(wk.whichKeyLines(kb.rootNode())[0], '[dim](no bindings)[/]');
  });
  it('_padKey wraps named tokens and pads to a column', () => {
    eq(wk._padKey('g'), 'g    ');
    eq(wk._padKey('up'), '<up> ');
  });
});

// ---- [7] review fixes ---------------------------------------------

describe('[7] prototype-safe tree (Object.create(null) children)', () => {
  it('resolve never returns inherited Object.prototype members', () => {
    kb.clearBindings();
    kb.registerKeyBinding('g', { label: 'g', run() {} });
    eq(kb.resolve(kb.rootNode(), 'constructor'), null, 'constructor → null, not Object');
    eq(kb.resolve(kb.rootNode(), 'toString'), null, 'toString → null, not a function');
    eq(kb.resolve(kb.rootNode(), '__proto__'), null, '__proto__ → null');
  });
  it('a __proto__ token registers as an ordinary own key without polluting', () => {
    kb.clearBindings();
    kb.registerKeyBinding(['__proto__'], { label: 'p', run() {} });
    const n = kb.resolve(kb.rootNode(), '__proto__');
    assert(n && typeof n.run === 'function', 'own leaf stored');
    eq(({}).polluted, undefined, 'Object.prototype not polluted');
  });
});

describe('[8] overridable built-ins', () => {
  it('a user leaf overrides a built-in leaf (last-write-wins, no throw)', () => {
    kb.clearBindings();
    let which = '';
    kb.registerKeyBinding('r', { label: 'builtin', run: () => { which = 'builtin'; } }, { builtin: true });
    kb.registerKeyBinding('r', { label: 'user',    run: () => { which = 'user'; } });
    kb.resolve(kb.rootNode(), 'r').run();
    eq(which, 'user', 'user binding wins');
  });
  it('a user leaf overrides a built-in subtree (replaces it)', () => {
    kb.clearBindings();
    kb.registerKeyBinding('gg', { label: 'top', run() {} }, { builtin: true });   // g is a builtin subtree
    let ran = false;
    kb.registerKeyBinding('g', { label: 'mine', run: () => { ran = true; } });     // override whole subtree
    const g = kb.resolve(kb.rootNode(), 'g');
    assert(g && typeof g.run === 'function' && !g.children, 'g is now a leaf');
    g.run(); assert(ran, 'user leaf runs');
  });
  it('a user leaf promotes a built-in leaf to a subtree', () => {
    kb.clearBindings();
    kb.registerKeyBinding('r', { label: 'refresh', run() {} }, { builtin: true });
    kb.registerKeyBinding('rx', { label: 'mine', run() {} });   // nest under former builtin leaf
    const r = kb.resolve(kb.rootNode(), 'r');
    assert(r && r.children && r.children.x, 'r became a subtree with x');
  });
  it('two NON-builtin conflicting bindings still throw', () => {
    kb.clearBindings();
    kb.registerKeyBinding('a', { label: 'a', run() {} });
    let threw = false;
    try { kb.registerKeyBinding('ab', { label: 'ab', run() {} }); } catch { threw = true; }
    assert(threw, 'user-vs-user conflict preserved');
  });
});

describe('[9] space gate + group-switch reset', () => {
  const { resetGroupContext } = require('../app/state');
  it('space leads when select mode is armed but focus is a non-list panel', () => {
    kb.clearBindings();
    getInstanceSlice("layout").focus = 'detail';
    getModel().modes.listSelectMode = true;
    getModel().modes.prefixMode = false;
    getInstanceSlice('detail').lines = []; getInstanceSlice('detail').scroll = 0;
    getInstanceSlice('layout').panelHeights = { detail: 10 };
    getInstanceSlice('detail').search = { active: false };
    getInstanceSlice('detail').cursor = { line: 0, col: 0 };
    dispatch._handleNormalKey(' ', ' ');
    assert(getModel().modes.prefixMode === true, 'space is the leader on detail even with listSelectMode armed');
    dispatch._handlePrefixKey('escape', undefined);
  });
  it('resetGroupContext clears listSelectMode', () => {
    getModel().modes.listSelectMode = true;
    resetGroupContext();
    eq(getModel().modes.listSelectMode, false, 'select mode dropped on group switch');
  });
});

describe('[10] leader run() error is surfaced, not swallowed', () => {
  it('a throwing binding logs instead of vanishing silently', () => {
    kb.clearBindings();
    kb.registerKeyBinding('z', { label: 'boom', run: () => { throw new Error('kaboom'); } });
    const origErr = console.error;
    let logged = '';
    console.error = (...a) => { logged = a.join(' '); };
    try {
      dispatch._enterPrefix();
      dispatch._handlePrefixKey('z', 'z');
    } finally { console.error = origErr; }
    assert(/leader/.test(logged) && /kaboom/.test(logged), `error surfaced: ${logged}`);
    assert(getModel().modes.prefixMode === false, 'still exits prefix mode after a throwing binding');
  });
});

report();
