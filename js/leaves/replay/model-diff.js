/**
 * B6 — per-Msg model diff (pure leaf, bottom tier, zero deps).
 *
 * Structurally diff two `{model, slices}` snapshots (the shape
 * `replay.snapshotState()` returns) into a bounded list of changed leaf paths.
 * Set-aware: Component slices hold `multiSel`/`expanded` Sets (the only
 * non-plain values in the replayable state). The replay controller computes
 * this ON DEMAND (idx-1 vs idx) for the scrubber's Changes panel + skip-to-next-
 * change; it is NEVER stored in the WAL (no bloat). The `--dev` console reuses it.
 *
 * Distinct from `leaves/render/cell-diff.js` (the visual cell/row tint) — this
 * diffs MODEL state, that diffs rendered rows.
 */
'use strict';

const MAX = 50;        // default cap on emitted changes
const MAX_DEPTH = 12;  // recursion guard (no cyclic/huge structures today, but be safe)
const REPR_CAP = 40;   // max chars in a leaf's display repr

// Compact one-line display of a leaf value (never recurses — the walk handles depth).
function repr(v) {
  if (v === undefined) return '∅';
  if (v === null) return 'null';
  if (typeof v === 'string') { const s = JSON.stringify(v); return s.length > REPR_CAP ? s.slice(0, REPR_CAP - 1) + '…' : s; }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Set) return `Set(${v.size})`;
  if (v instanceof Map) return `Map(${v.size})`;
  if (v instanceof Date) return `Date(${v.getTime()})`;
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') { const s = '{' + Object.keys(v).join(',') + '}'; return s.length > REPR_CAP ? s.slice(0, REPR_CAP - 1) + '…' : s; }
  return String(v);
}

function setEq(a, b) {
  if (a.size !== b.size) return false;
  for (const m of a) if (!b.has(m)) return false;
  return true;
}
// STRICT plain-object test: only `{}`-shaped objects recurse key-by-key. A Map,
// Date, RegExp, or class instance is NOT plain — it has its own prototype, so
// `Object.keys()` would be empty and the diff would silently report "no change"
// on a Map/Date value change (the replayable state holds only plain objects +
// Sets today, so this is a latent guard: any future exotic value routes to the
// leaf branch and is reported, never silently dropped).
function isPlainObj(v) {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * @returns {{ changes: Array<{path,kind,before?,after?}>, truncated: boolean }}
 *   kind ∈ 'add' (only in b) | 'remove' (only in a) | 'change' (both, differ).
 *   opts: { max=50, maxDepth=12, pathFilter='' (substring on path) }.
 */
function diffState(a, b, opts = {}) {
  const max = opts.max || MAX;
  const maxDepth = opts.maxDepth || MAX_DEPTH;
  const filter = opts.pathFilter || '';
  const changes = [];
  let truncated = false;

  function push(c) {
    if (filter && !c.path.includes(filter)) return;
    if (changes.length >= max) { truncated = true; return; }
    changes.push(c);
  }

  function walk(pa, pb, path, depth) {
    if (changes.length >= max) { truncated = true; return; }   // cheap early-out (esp. max:1)
    if (Object.is(pa, pb)) return;
    if (pa instanceof Set && pb instanceof Set) {
      if (setEq(pa, pb)) return;
      for (const m of pb) if (!pa.has(m)) push({ path, kind: 'add', after: repr(m) });
      for (const m of pa) if (!pb.has(m)) push({ path, kind: 'remove', before: repr(m) });
      return;
    }
    if (depth >= maxDepth) { push({ path, kind: 'change', before: repr(pa), after: repr(pb) }); return; }
    if (isPlainObj(pa) && isPlainObj(pb)) {
      const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
      for (const k of keys) walk(pa[k], pb[k], path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    if (Array.isArray(pa) && Array.isArray(pb)) {
      const n = Math.max(pa.length, pb.length);
      for (let i = 0; i < n; i++) walk(pa[i], pb[i], `${path}[${i}]`, depth + 1);
      return;
    }
    // Leaf mismatch (scalar differs, or the type changed, or one side absent).
    const kind = pa === undefined ? 'add' : pb === undefined ? 'remove' : 'change';
    push({ path, kind, before: repr(pa), after: repr(pb) });
  }

  walk(a, b, '', 0);
  return { changes, truncated };
}

module.exports = { diffState };
