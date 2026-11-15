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

const { KEY_NAMES } = require('./key-decode');

// children maps use a null prototype so token strings like `constructor`,
// `toString`, or `__proto__` (reachable via `<…>` tokens or plugin
// registration) can't resolve to inherited Object.prototype members or
// pollute the prototype chain.
const _root = { children: Object.create(null) };

function rootNode() { return _root; }

function clearBindings() { _root.children = Object.create(null); }

// --- One key-name vocabulary -------------------------------------------------
// A chord step is matched by NAME. The keyboard side (tokenForEvent) and the
// sequence side (parseSeq) must land on the same names, or a binding the popup
// lists can never be typed (it still answers a click on its popup row, which
// sends the name). Names the input pipeline produces: a printable char, or
// up down left right pageup pagedown home end insert delete f1…f12 backtab
// return tab backspace ctrl-r (input._dispatchToken / leaves/input/key-decode).

// Keys that reach handleKey as their raw BYTE (normal-mode handlers test
// `seq === '\x7f'`, so the byte stays the event) — named for chord matching.
// (^H never arrives here: the input ladder turns it into \x7f.)
const _BYTE_NAMES = Object.assign(Object.create(null), { '\t': 'tab', '\x7f': 'backspace' });

// `<name>` spellings people write (vim's, mostly) → the name the keyboard side
// produces. Without these, `<cr>` / `<esc>` / `<bs>` / `<del>` parsed fine and
// matched nothing. (Null prototype, like the tree: `<constructor>` must not
// resolve to an inherited member.)
const _ALIASES = Object.assign(Object.create(null), {
  cr: 'return', enter: 'return', esc: 'escape', bs: 'backspace',
  del: 'delete', ins: 'insert', 's-tab': 'backtab',
  pgup: 'pageup', pgdn: 'pagedown', pgdown: 'pagedown',
});

// Named tokens a keystroke can produce inside a chord: every special key the
// input layer decodes (leaves/input/key-decode — one table, so a key it learns
// is a chord step at once) plus the ones its ladder names itself (return, the
// byte-named tab / backspace, ctrl-r). `escape` and the leader (space) are not
// here: both CANCEL the chord (reducer prefix_key).
const _PRODUCIBLE = new Set([...KEY_NAMES, 'return', 'tab', 'backspace', 'ctrl-r']);

/** The steps of `seq` no keystroke can produce inside a chord (so the binding
 *  is reachable only by clicking its which-key row): a named token outside the
 *  vocabulary, `escape`, or a space (both cancel the chord) — each AS WRITTEN
 *  (`<esc>`, not the `escape` it names). [] when every step is typeable; null
 *  when `seq` doesn't parse (parseSeq reports that). */
function unreachableSteps(seq) {
  let steps;
  try { steps = _steps(seq); } catch (_) { return null; }
  const oneKey = (n) => [...n].length === 1;           // a typed character (an emoji too)
  return steps.filter(({ name }) => (oneKey(name) ? name === ' ' : !_PRODUCIBLE.has(name)))
    .map(({ written }) => written);
}

/** The named keys a chord step can be typed as, and the alias spellings that
 *  name one of them — the vocabulary the config warning lists (an alias of an
 *  untypeable key, `<esc>`, is not one). */
function typeableKeyNames() {
  return {
    names: [..._PRODUCIBLE],
    aliases: Object.keys(_ALIASES).filter(a => _PRODUCIBLE.has(_ALIASES[a])),
  };
}

/**
 * Tokenize a sequence string into an array of key-name tokens.
 * A leading leader token (`<leader>` or `<space>`) is stripped — every
 * binding is implicitly under the leader, so the prefix is optional in
 * the source string.
 */
function parseSeq(str) {
  if (Array.isArray(str)) return str.slice();
  return _steps(str).map(t => t.name);
}

// The steps of a sequence string: `{ name, written }` — the key name it matches
// by, and how the config wrote it (`<esc>` names `escape`).
function _steps(str) {
  if (typeof str !== 'string') throw new Error('key sequence must be a string or array');
  let s = str.trim();
  // Strip an explicit leader prefix if present (case-insensitive).
  s = s.replace(/^<(leader|space)>/i, '');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    // One CODEPOINT per step: an emoji is two UTF-16 units, and splitting it
    // made two steps no keystroke produces (the input layer delivers it whole).
    const ch = String.fromCodePoint(s.codePointAt(i));
    if (ch === '<') {
      const close = s.indexOf('>', i + 1);
      if (close === -1) throw new Error(`unterminated <…> token in "${str}"`);
      const name = s.slice(i + 1, close).toLowerCase();
      if (!name) throw new Error(`empty <> token in "${str}"`);
      tokens.push({ name: _ALIASES[name] || name, written: s.slice(i, close + 1) });
      i = close + 1;
    } else if (/\s/.test(ch)) {
      i += 1;  // allow spaces as visual separators: "g g" === "gg"
    } else {
      tokens.push({ name: ch, written: ch });
      i += ch.length;
    }
  }
  if (tokens.length === 0) throw new Error(`empty key sequence "${str}"`);
  return tokens;
}

/**
 * Insert a binding. `seq` is a sequence string or token array; `def`
 * is `{ label, run }`. Intermediate nodes are auto-created with a
 * `+<token>` placeholder label unless one is supplied later.
 *
 * `opts.builtin` marks every node this call creates as a default. A
 * later non-builtin registration (user YAML, plugin) is allowed to
 * OVERRIDE a built-in node — replace a default leaf with a subtree or
 * vice versa — so users can rebind `g` / `r` / `?` etc. Conflicts
 * between two NON-builtin bindings still throw, so genuine config
 * mistakes (binding both `g` and `gg`) are still caught.
 */
function registerKeyBinding(seq, def, opts = {}) {
  const steps = parseSeq(seq);
  if (!def || typeof def.run !== 'function') {
    throw new Error(`binding "${steps.join(' ')}" needs a run() function`);
  }
  const builtin = !!opts.builtin;
  let node = _root;
  for (let i = 0; i < steps.length; i++) {
    const tok = steps[i];
    const last = i === steps.length - 1;
    if (!node.children) node.children = Object.create(null);
    const existing = node.children[tok];
    if (last) {
      if (existing && existing.children && !existing._builtin) {
        throw new Error(`key conflict: "${steps.join(' ')}" already has sub-bindings`);
      }
      // Absent, a leaf (overwrite), or a built-in subtree (override) →
      // install the leaf.
      node.children[tok] = { label: def.label || steps.join(' '), run: def.run };
      if (builtin) node.children[tok]._builtin = true;
    } else {
      if (existing && existing.run) {
        // Intermediate step lands on a leaf: only a built-in leaf may be
        // promoted to a subtree (override); a user/plugin leaf throws.
        if (!existing._builtin) {
          throw new Error(`key conflict: "${steps.slice(0, i + 1).join(' ')}" is already a terminal binding`);
        }
        node.children[tok] = { label: `+${tok}`, children: Object.create(null) };
        if (builtin) node.children[tok]._builtin = true;
      } else if (!existing) {
        node.children[tok] = { label: `+${tok}`, children: Object.create(null) };
        if (builtin) node.children[tok]._builtin = true;
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
 * `seq`; named keys (arrows, escape) arrive only in `key`; Tab and
 * Backspace arrive as their byte and are named here (`_BYTE_NAMES`).
 */
function tokenForEvent(key, seq) {
  const t = (seq != null && seq.length > 0) ? seq : key;
  return _BYTE_NAMES[t] || t;
}

/** Walk the leader tree from the root by a token sequence; the node reached, or
 *  null if any step is unbound. Lets the model carry only the serializable
 *  `prefixSeq` and re-derive the live node on demand — the node holds `run`
 *  closures, which are structuredClone-hostile and must never sit on the model
 *  (a checkpoint taken mid-chord would DataCloneError). */
function nodeForSeq(seq) {
  let node = _root;
  for (const tok of (seq || [])) {
    node = resolve(node, tok);
    if (!node) return null;
  }
  return node;
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
  labelSubtree, resolve, nodeForSeq, tokenForEvent, continuations, unreachableSteps,
  typeableKeyNames,
};
