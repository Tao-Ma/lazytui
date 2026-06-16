#!/usr/bin/env node
'use strict';
// One-shot dependency-graph walker for the v0.6.5 §1 layering pass.
// Walks js/ (minus test/scripts), classifies each require() as top-level
// (module scope) or deferred (inside a function body), resolves it to a
// target file, and reports the directory-layer graph + the cyclic edges.
//
// NOT a build artifact — a planning instrument. Heuristic, not a parser:
// "top-level" = require() appearing at indent column 0 or assigned at
// module scope (no enclosing brace depth). Good enough to find the cut.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..'); // js/
const SKIP_DIRS = new Set(['test', 'scripts']);

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name), out);
    } else if (ent.name.endsWith('.js')) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

const files = walk(ROOT, []);

// Layer = first path segment under js/ (app, dispatch, panel, leaves, io,
// parser, render, overlay, feature). panel/* subdirs collapse to "panel".
function layerOf(absFile) {
  const rel = path.relative(ROOT, absFile);
  return rel.split(path.sep)[0];
}

// Track brace depth to tell module-scope requires from function-body ones.
// Crude lexer: strip strings/comments per line, count net braces.
function classifyRequires(src) {
  const reqs = []; // {target, deferred, line}
  let depth = 0;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Strip line comments BEFORE matching requires (else a commented-out
    // `require('...')` counts as a real edge). Keep string contents intact
    // so the require path survives.
    const noComment = line.replace(/\/\/.*$/, '');
    // For brace-depth tracking, blank out string contents PRESERVING LENGTH so
    // a require's column index in `noComment` aligns with `noStr`.
    const blank = (m) => ' '.repeat(m.length);
    const noStr = noComment
      .replace(/'(?:[^'\\]|\\.)*'/g, blank)
      .replace(/"(?:[^"\\]|\\.)*"/g, blank)
      .replace(/`(?:[^`\\]|\\.)*`/g, blank);
    // Classify each require at ITS position: running depth + net braces opened
    // earlier ON THIS LINE. So a one-line `function f(){ require(...) }` is
    // correctly DEFERRED (was misclassified top-level when depth was read for
    // the whole line before its own braces).
    const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = reqRe.exec(noComment)) !== null) {
      let d = depth;
      for (let k = 0; k < m.index; k++) {
        if (noStr[k] === '{') d++;
        else if (noStr[k] === '}') d = Math.max(0, d - 1);
      }
      reqs.push({ target: m[1], deferred: d > 0, line: i + 1 });
    }
    // carry running depth to subsequent lines
    for (const ch of noStr) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return reqs;
}

function resolveTarget(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // external / node builtin
  let p = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (fs.existsSync(p + '.js')) return p + '.js';
  if (fs.existsSync(path.join(p, 'index.js'))) return path.join(p, 'index.js');
  return null;
}

// Build layer-level edges. edge key "A->B" => {top:n, deferred:n, samples:[]}
const edges = new Map();
const fileEdges = []; // {from, to, deferred, line, fromLayer, toLayer}

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const fromLayer = layerOf(f);
  for (const r of classifyRequires(src)) {
    const tgt = resolveTarget(f, r.target);
    if (!tgt) continue;
    const toLayer = layerOf(tgt);
    if (toLayer === fromLayer) continue; // intra-layer: not part of the cross-layer graph
    fileEdges.push({
      from: path.relative(ROOT, f),
      to: path.relative(ROOT, tgt),
      deferred: r.deferred,
      line: r.line,
      fromLayer,
      toLayer,
    });
    const key = `${fromLayer}->${toLayer}`;
    if (!edges.has(key)) edges.set(key, { top: 0, deferred: 0 });
    edges.get(key)[r.deferred ? 'deferred' : 'top']++;
  }
}

// Report cross-layer edge summary
console.log('=== CROSS-LAYER EDGES (top-level | deferred) ===\n');
const sorted = [...edges.entries()].sort();
for (const [k, v] of sorted) {
  console.log(`  ${k.padEnd(28)}  top=${String(v.top).padStart(3)}  deferred=${String(v.deferred).padStart(3)}`);
}

// Find layer-level cycles via the edge set (top-level edges only — those
// are the ones that constrain load order / make the cycle "real").
const layers = [...new Set(files.map(layerOf))];
const topAdj = new Map(layers.map(l => [l, new Set()]));
const allAdj = new Map(layers.map(l => [l, new Set()]));
for (const [k, v] of edges) {
  const [a, b] = k.split('->');
  if (v.top > 0) topAdj.get(a).add(b);
  allAdj.get(a).add(b);
}

function sccs(adj) {
  // Tarjan
  let idx = 0;
  const indices = new Map(), low = new Map(), onStack = new Set(), stack = [];
  const out = [];
  function strong(v) {
    indices.set(v, idx); low.set(v, idx); idx++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v) || []) {
      if (!indices.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) { low.set(v, Math.min(low.get(v), indices.get(w))); }
    }
    if (low.get(v) === indices.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      out.push(comp);
    }
  }
  for (const v of adj.keys()) if (!indices.has(v)) strong(v);
  return out.filter(c => c.length > 1);
}

console.log('\n=== LAYER SCCs (top-level edges only) ===');
console.log(JSON.stringify(sccs(topAdj)));
console.log('\n=== LAYER SCCs (all edges incl. deferred) ===');
console.log(JSON.stringify(sccs(allAdj)));

// For the {app,dispatch,panel} SCC: dump the TOP-LEVEL edges between them,
// file by file — these are the ones that must be cut.
const SCC = new Set(['app', 'dispatch', 'panel']);
console.log('\n=== TOP-LEVEL edges WITHIN {app,dispatch,panel} (the cut targets) ===\n');
const within = fileEdges
  .filter(e => SCC.has(e.fromLayer) && SCC.has(e.toLayer) && !e.deferred && e.fromLayer !== e.toLayer)
  .sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
for (const e of within) {
  console.log(`  ${e.from}:${e.line}  ->  ${e.to}`);
}
console.log(`\n  (${within.length} top-level cross-edges inside the SCC)`);

// Deferred ratio per layer
console.log('\n=== DEFERRED-REQUIRE RATIO per layer (cross-layer requires) ===\n');
const byLayer = new Map();
for (const e of fileEdges) {
  if (!byLayer.has(e.fromLayer)) byLayer.set(e.fromLayer, { top: 0, deferred: 0 });
  byLayer.get(e.fromLayer)[e.deferred ? 'deferred' : 'top']++;
}
for (const [l, v] of [...byLayer.entries()].sort()) {
  const total = v.top + v.deferred;
  const pct = total ? Math.round((v.deferred / total) * 100) : 0;
  console.log(`  ${l.padEnd(10)}  total=${String(total).padStart(3)}  deferred=${String(v.deferred).padStart(3)}  (${pct}%)`);
}
