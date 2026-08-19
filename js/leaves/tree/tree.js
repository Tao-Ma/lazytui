/**
 * Pure leaf — the generic TREE MODEL.
 *
 * The reusable core behind every hierarchy in the app: the process tree (parent
 * pointer / `ppid`), the groups navigator (explicit children), config-status
 * (tree/flat), and a future file tree (paths). Owns the three concerns that are
 * identical regardless of WHAT is being treed; the only source-specific part — how
 * you derive parent↔child — is a pluggable builder.
 *
 * A **Forest** is source-agnostic:
 *   { roots: [id], children: Map<id,[id]>, parent: Map<id,id|null> }
 *
 * Two design choices keep it serving consumers with opposite conventions:
 *   - **Predicate-based visibility.** `flatten` takes `isExpanded(id)`, not a set,
 *     so a consumer tracking an `expanded` set (groups: default COLLAPSED) and one
 *     tracking a `collapsed` set (procs: default EXPANDED) both fit — `id =>
 *     expanded.has(id)` vs `id => !collapsed.has(id)`.
 *   - **Order separate from visibility.** The caller supplies the base id order;
 *     `flatten` filters it by ancestor-visibility + annotates depth. groups passes
 *     its config-key order (byte-identical to its bespoke recomputeList); procs
 *     passes `orderDfs(forest)`.
 *
 * Dependency-free — pure, no requires.
 */
'use strict';

// --- derivation (pluggable) --------------------------------------------------

/**
 * Build a forest from PARENT-POINTER data (procs `ppid`, any table with a parent
 * column). `orderedIds` is the base order (kept as sibling order); `parentOf(id)`
 * yields the parent id — a parent that is null/absent/self/not-in-the-set makes a
 * root. Cycle-safe: any node unreachable from a root (a cycle) is promoted to a
 * root, deterministically by `orderedIds` order.
 */
function buildForestByParent(orderedIds, parentOf) {
  const idset = new Set(orderedIds);
  const children = new Map();
  const parent = new Map();
  const roots = [];
  for (const id of orderedIds) children.set(id, []);
  for (const id of orderedIds) {
    const p = parentOf(id);
    if (p == null || p === id || !idset.has(p)) { parent.set(id, null); roots.push(id); }
    else { parent.set(id, p); children.get(p).push(id); }
  }
  _breakCycles({ roots, children, parent }, orderedIds);
  return { roots, children, parent };
}

/**
 * Build a forest from EXPLICIT-CHILDREN data (groups). `rootIds` are the top-level
 * ids; `childrenOf(id)` yields each node's child ids. Walks the declared shape.
 */
function buildForestByChildren(rootIds, childrenOf) {
  const children = new Map();
  const parent = new Map();
  const roots = [];
  const seen = new Set();
  const visit = (id, par) => {
    if (seen.has(id)) return;          // guard against a malformed shared/cyclic child
    seen.add(id);
    parent.set(id, par);
    const kids = (childrenOf(id) || []).slice();
    children.set(id, kids);
    for (const c of kids) visit(c, id);
  };
  for (const r of rootIds) { roots.push(r); visit(r, null); }
  return { roots, children, parent };
}

// Promote cycle members (unreachable from any root) to roots, detaching them from
// the parent that closed the cycle. Mutates the forest in place.
function _breakCycles(forest, orderedIds) {
  const { roots, children, parent } = forest;
  const reachable = new Set();
  const mark = (n) => {
    const st = [n];
    while (st.length) {
      const x = st.pop();
      if (reachable.has(x)) continue;
      reachable.add(x);
      for (const c of children.get(x) || []) st.push(c);
    }
  };
  for (const r of roots) mark(r);
  for (const id of orderedIds) {
    if (reachable.has(id)) continue;
    const p = parent.get(id);
    if (p != null && children.has(p)) {
      const arr = children.get(p);
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
    }
    parent.set(id, null);
    roots.push(id);
    mark(id);
  }
}

// --- traversal / visibility --------------------------------------------------

/** DFS pre-order (parent before children; children in forest order). */
function orderDfs(forest) {
  const out = [];
  const st = [];
  for (let i = forest.roots.length - 1; i >= 0; i--) st.push(forest.roots[i]);
  while (st.length) {
    const id = st.pop();
    out.push(id);
    const ch = forest.children.get(id) || [];
    for (let i = ch.length - 1; i >= 0; i--) st.push(ch[i]);
  }
  return out;
}

/** Visible iff EVERY ancestor is expanded (roots are always visible). Generalizes
 *  groups.isVisible; `isExpanded(id)` is the caller's convention. */
function isVisible(forest, id, isExpanded) {
  let p = forest.parent.get(id);
  while (p != null) {
    if (!isExpanded(p)) return false;
    p = forest.parent.get(p);
  }
  return true;
}

/** All descendants of `id` (pre-order), for recursive expand/collapse. */
function descendants(forest, id) {
  const out = [];
  const st = [...(forest.children.get(id) || [])].reverse();
  while (st.length) {
    const x = st.pop();
    out.push(x);
    const ch = forest.children.get(x) || [];
    for (let i = ch.length - 1; i >= 0; i--) st.push(ch[i]);
  }
  return out;
}

function _isLastChild(forest, id) {
  const p = forest.parent.get(id);
  const sibs = p == null ? forest.roots : (forest.children.get(p) || []);
  return sibs[sibs.length - 1] === id;
}

/**
 * Filter `orderedIds` to the visible nodes and annotate each for rendering:
 *   { id, depth, hasChildren, expanded, lastChild, ancestorsLast: bool[] }
 * `ancestorsLast[k]` — was the depth-k ancestor the last of its siblings (→ draw a
 * blank gutter, else a `│` continuation). Order-preserving: the row sequence is
 * exactly `orderedIds` minus hidden nodes (so groups keeps config order, procs DFS).
 */
function flatten(forest, orderedIds, isExpanded) {
  const out = [];
  for (const id of orderedIds) {
    if (!isVisible(forest, id, isExpanded)) continue;
    const chain = [];
    let p = forest.parent.get(id);
    while (p != null) { chain.push(p); p = forest.parent.get(p); }   // [parent … root]
    // Gutter columns are the ancestors STRICTLY BETWEEN the root and this node
    // (root excluded): a flush root draws no vertical line — its children start at
    // column 0 with the branch glyph, and only intermediate ancestors draw `│`.
    // So skip chain's last element (the root, whose parent is null).
    const ancestorsLast = [];
    for (let i = chain.length - 2; i >= 0; i--) ancestorsLast.push(_isLastChild(forest, chain[i]));
    const hasChildren = (forest.children.get(id) || []).length > 0;
    out.push({
      id,
      depth: chain.length,
      hasChildren,
      expanded: hasChildren ? !!isExpanded(id) : false,
      lastChild: _isLastChild(forest, id),
      ancestorsLast,
    });
  }
  return out;
}

// --- render helper -----------------------------------------------------------

const GLYPHS = { branch: '├─ ', last: '└─ ', pipe: '│  ', blank: '   ', open: '▾ ', closed: '▸ ', leafPad: '' };

/**
 * The indent + branch-glyph prefix for an annotated node (from `flatten`):
 *   "│  ├─ ▾ "  — a continuation gutter per ancestor, a branch for this node, then
 * an expand marker (▾ open / ▸ closed) for a parent. Pure fn of the annotation, so
 * paint and any hit-test on the marker agree. A leaf gets no marker.
 */
function treePrefix(node, glyphs = GLYPHS) {
  let s = '';
  for (const anc of node.ancestorsLast) s += anc ? glyphs.blank : glyphs.pipe;
  if (node.depth > 0) s += node.lastChild ? glyphs.last : glyphs.branch;
  if (node.hasChildren) s += node.expanded ? glyphs.open : glyphs.closed;
  return s;
}

module.exports = {
  buildForestByParent, buildForestByChildren,
  orderDfs, isVisible, descendants, flatten,
  treePrefix,   // GLYPHS stays internal (the default arg); pass overrides to treePrefix to customise.
};
