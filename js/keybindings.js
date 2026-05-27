/**
 * Prefix-key (leader) binding registry.
 *
 * A single key — the leader, default `<space>` — opens a fresh
 * namespace of multi-key sequences. Bindings form a TREE so a sequence
 * like `<leader>g g` nests under a `g` subtree; the which-key popup
 * (stage 2) walks the same tree to show continuations.
 *
 * Node shapes:
 *   leaf:    { label, run }              — a terminal binding
 *   subtree: { label?, children: {…} }  — has continuations
 *
 * The root is a subtree whose `children` are keyed by the FIRST token
 * after the leader. Tokens are lazytui key names: a single printable
 * char (`g`, `?`) or a named key (`up`, `escape`). Sequence strings use
 * `<name>` for named tokens, bare chars otherwise:
 *
 *   "<leader>gg"    → ['g', 'g']
 *   "<leader>g<up>" → ['g', 'up']
 *   "<leader>?"     → ['?']
 *
 * Registration is order-independent but conflict-checked: you cannot
 * bind a sequence that runs THROUGH an existing leaf (its prefix is
 * already terminal), nor land a leaf where a subtree already lives.
 */
'use strict';

const _root = { children: {} };

function rootNode() { return _root; }

function clearBindings() { _root.children = {}; }

/**
 * Tokenize a sequence string into an array of key-name tokens.
 * A leading leader token (`<leader>` or `<space>`) is stripped — every
 * binding is implicitly under the leader, so the prefix is optional in
 * the source string.
 */
function parseSeq(str) {
  if (Array.isArray(str)) return str.slice();
  if (typeof str !== 'string') throw new Error('key sequence must be a string or array');
  let s = str.trim();
  // Strip an explicit leader prefix if present (case-insensitive).
  s = s.replace(/^<(leader|space)>/i, '');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '<') {
      const close = s.indexOf('>', i + 1);
      if (close === -1) throw new Error(`unterminated <…> token in "${str}"`);
      const name = s.slice(i + 1, close).toLowerCase();
      if (!name) throw new Error(`empty <> token in "${str}"`);
      tokens.push(name);
      i = close + 1;
    } else if (/\s/.test(ch)) {
      i += 1;  // allow spaces as visual separators: "g g" === "gg"
    } else {
      tokens.push(ch);
      i += 1;
    }
  }
  if (tokens.length === 0) throw new Error(`empty key sequence "${str}"`);
  return tokens;
}

/**
 * Insert a binding. `seq` is a sequence string or token array; `def`
 * is `{ label, run }`. Intermediate nodes are auto-created with a
 * `+<token>` placeholder label unless one is supplied later.
 */
function registerKeyBinding(seq, def) {
  const steps = parseSeq(seq);
  if (!def || typeof def.run !== 'function') {
    throw new Error(`binding "${steps.join(' ')}" needs a run() function`);
  }
  let node = _root;
  for (let i = 0; i < steps.length; i++) {
    const tok = steps[i];
    const last = i === steps.length - 1;
    if (node.run) {
      // The path passes through an existing leaf.
      throw new Error(`key conflict: "${steps.slice(0, i).join(' ')}" is already a terminal binding`);
    }
    if (!node.children) node.children = {};
    if (last) {
      const existing = node.children[tok];
      if (existing && existing.children) {
        throw new Error(`key conflict: "${steps.join(' ')}" already has sub-bindings`);
      }
      node.children[tok] = { label: def.label || steps.join(' '), run: def.run };
    } else {
      if (!node.children[tok]) {
        node.children[tok] = { label: `+${tok}`, children: {} };
      }
      node = node.children[tok];
    }
  }
}

/** Set / override a subtree's group label (for the popup heading). */
function labelSubtree(seq, label) {
  const steps = parseSeq(seq);
  let node = _root;
  for (const tok of steps) {
    if (!node.children || !node.children[tok]) return false;
    node = node.children[tok];
  }
  if (node.children) { node.label = label; return true; }
  return false;
}

/** Resolve one step from `node`; returns the child node or null. */
function resolve(node, token) {
  if (!node || !node.children) return null;
  return node.children[token] || null;
}

/**
 * The token a key event maps to. Printable single chars come through
 * `seq`; named keys (arrows, escape) arrive only in `key`.
 */
function tokenForEvent(key, seq) {
  return (seq != null && seq.length > 0) ? seq : key;
}

/** Sorted [token, node] pairs for popup rendering. */
function continuations(node) {
  if (!node || !node.children) return [];
  return Object.keys(node.children)
    .sort((a, b) => a.localeCompare(b))
    .map(tok => [tok, node.children[tok]]);
}

module.exports = {
  rootNode, clearBindings, parseSeq, registerKeyBinding,
  labelSubtree, resolve, tokenForEvent, continuations,
};
