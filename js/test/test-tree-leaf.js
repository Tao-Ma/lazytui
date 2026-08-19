/**
 * tree leaf — the generic tree model. Proven against BOTH consumer shapes:
 * parent-pointer (procs `ppid`) and explicit-children (groups), plus orphans,
 * cycles, the visibility predicate (both set conventions), and glyph output.
 * (The groups-tree state tests live in test-tree.js — a different subject.)
 *
 * Run: node js/test/test-tree-leaf.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const T = require('../leaves/tree/tree');

// A procs-like parent-pointer forest:
//   1(ppid 0=root) → 100 → 300 ; 1 → 200 ; 400(ppid 999 = orphan → root)
const PPID = { '1': '0', '100': '1', '200': '1', '300': '100', '400': '999' };
const PIDS = ['1', '100', '200', '300', '400'];
const procForest = () => T.buildForestByParent(PIDS, id => PPID[id]);

describe('[tree] buildForestByParent', () => {
  it('roots = parent absent/zero/self/orphan; children grouped in order', () => {
    const f = procForest();
    eq(f.roots, ['1', '400'], 'init (ppid 0) + orphan (ppid 999) are roots');
    eq(f.children.get('1'), ['100', '200'], 'sibling order preserved');
    eq(f.children.get('100'), ['300']);
    eq(f.parent.get('300'), '100');
    eq(f.parent.get('1'), null);
  });
  it('self-parent → root', () => {
    const f = T.buildForestByParent(['x'], () => 'x');
    eq(f.roots, ['x']);
  });
  it('a cycle is broken (no infinite loop): a↔b becomes a rooted chain', () => {
    const f = T.buildForestByParent(['a', 'b'], id => ({ a: 'b', b: 'a' }[id]));
    eq(f.roots, ['a'], 'first cycle node (by order) promoted to root');
    // every node reachable, exactly once
    eq(T.orderDfs(f).sort(), ['a', 'b']);
  });
});

describe('[tree] buildForestByChildren (groups shape)', () => {
  it('walks explicit children into the same Forest shape', () => {
    const kids = { a: ['b', 'c'], b: ['d'], c: [], d: [] };
    const f = T.buildForestByChildren(['a'], id => kids[id]);
    eq(f.roots, ['a']);
    eq(f.children.get('a'), ['b', 'c']);
    eq(f.parent.get('d'), 'b');
    eq(T.orderDfs(f), ['a', 'b', 'd', 'c']);
  });
});

describe('[tree] orderDfs + descendants', () => {
  it('DFS pre-order: parent before children, children in order', () => {
    eq(T.orderDfs(procForest()), ['1', '100', '300', '200', '400']);
  });
  it('descendants = whole subtree (pre-order)', () => {
    eq(T.descendants(procForest(), '1'), ['100', '300', '200']);
    eq(T.descendants(procForest(), '200'), []);
  });
});

describe('[tree] isVisible / flatten — predicate-based, both conventions', () => {
  it('procs convention (collapsed set, default EXPANDED): all visible', () => {
    const f = procForest();
    const collapsed = new Set();
    const rows = T.flatten(f, T.orderDfs(f), id => !collapsed.has(id));
    eq(rows.map(r => r.id), ['1', '100', '300', '200', '400'], 'DFS order, nothing hidden');
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    eq(byId['1'].depth, 0); eq(byId['300'].depth, 2);
    eq(byId['300'].ancestorsLast, [false], 'root excluded; one gutter for parent 100 (not last sib) → │');
    eq(byId['200'].lastChild, true); eq(byId['100'].lastChild, false);
  });
  it('procs convention: collapsing a node hides its subtree', () => {
    const f = procForest();
    const collapsed = new Set(['100']);
    const rows = T.flatten(f, T.orderDfs(f), id => !collapsed.has(id));
    eq(rows.map(r => r.id), ['1', '100', '200', '400'], '300 (child of collapsed 100) hidden');
    eq(rows.find(r => r.id === '100').expanded, false, 'a collapsed parent reports expanded:false');
  });
  it('groups convention (expanded set, default COLLAPSED): only roots, config order', () => {
    const f = procForest();
    const expanded = new Set();
    // groups passes CONFIG order (here PIDS), not DFS — order-preserving filter.
    const rows = T.flatten(f, PIDS, id => expanded.has(id));
    eq(rows.map(r => r.id), ['1', '400'], 'nothing expanded → only roots');
  });
  it('groups convention: expanding a node reveals its direct children (config order)', () => {
    const f = procForest();
    const expanded = new Set(['1']);
    const rows = T.flatten(f, PIDS, id => expanded.has(id));
    eq(rows.map(r => r.id), ['1', '100', '200', '400'], '1 expanded → 100/200 show; 300 still hidden (100 collapsed)');
  });
  it('isVisible matches: a node shows iff every ancestor is expanded', () => {
    const f = procForest();
    assert(T.isVisible(f, '300', id => id === '1' || id === '100'), '300 visible when 1 AND 100 expanded');
    assert(!T.isVisible(f, '300', id => id === '1'), '300 hidden when 100 collapsed');
    assert(T.isVisible(f, '1', () => false), 'a root is always visible');
  });
});

describe('[tree] treePrefix — indent + branch glyphs + markers', () => {
  const f = procForest();
  const rows = T.flatten(f, T.orderDfs(f), () => true);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  it('root parent shows a ▾ open marker, no indent', () => {
    eq(T.treePrefix(byId['1']), '▾ ', 'expanded parent, depth 0');
  });
  it('a middle child: branch glyph', () => {
    eq(T.treePrefix(byId['100']), '├─ ▾ ', '├─ (not last) + ▾ (has kids, expanded)');
  });
  it('a last child leaf: └─ , no marker', () => {
    eq(T.treePrefix(byId['200']), '└─ ', 'last sibling, leaf');
  });
  it('a deep node carries the ancestor gutters', () => {
    eq(T.treePrefix(byId['300']), '│  └─ ', 'one │ gutter (parent 100 not last) + └─ (300 last child)');
  });
  it('a collapsed parent shows ▸', () => {
    const collapsed = new Set(['1']);
    const rr = T.flatten(f, T.orderDfs(f), id => !collapsed.has(id));
    eq(T.treePrefix(rr.find(r => r.id === '1')), '▸ ', 'collapsed → ▸');
  });
});

report();
