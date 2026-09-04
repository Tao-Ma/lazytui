#!/usr/bin/env node
'use strict';
// Dependency-graph walker for the layering pass. Walks js/ (minus test/scripts),
// classifies each require() as top-level (module scope) or deferred (inside a
// function body), resolves it to a target file, and computes the directory-layer
// graph + its cyclic edges (SCCs).
//
// TWO consumers: run directly (`node js/scripts/dep-walker.js`) it prints the
// full planning report; required as a module it exposes analyze() so the layering
// GATE (test/test-dep-layering.js) can assert the graph stays acyclic — layering
// is enforced, not convention. Heuristic, not a parser: "top-level" = a require()
// at brace-depth 0. Good enough to find (and hold) the cut.

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
      // A require inside a function body is DEFERRED (lazy). Brace-depth catches
      // `function(){…}` and braced arrows `()=>{…}`; a CONCISE arrow body
      // `()=>require(…)` has NO braces, so also treat a require preceded on this
      // line by an arrow whose body isn't `{`-braced as deferred. Without this the
      // `const x = () => require(...)` idiom (16× in-tree, e.g. replay-control.js's
      // lazy seams) counts as a TOP-LEVEL edge — over-approximating the load-order
      // graph so a future legal lazy upward arrow-require could trip a false cycle.
      const before = noStr.slice(0, m.index);
      const arrowIdx = before.lastIndexOf('=>');
      const conciseArrow = arrowIdx >= 0 && !/^\s*\{/.test(before.slice(arrowIdx + 2));
      reqs.push({ target: m[1], deferred: d > 0 || conciseArrow, line: i + 1 });
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

// Build the whole cross-layer picture: per-file edges, the layer-edge summary
// (top-level vs deferred counts), and the layer SCCs both ways. Pure over the
// on-disk tree — no shared mutable state, so the gate can call it repeatedly.
function analyze() {
  const files = walk(ROOT, []);
  const edges = new Map();   // "A->B" => { top, deferred }
  const fileEdges = [];      // { from, to, deferred, line, fromLayer, toLayer }

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const fromLayer = layerOf(f);
    for (const r of classifyRequires(src)) {
      const tgt = resolveTarget(f, r.target);
      if (!tgt) continue;
      const toLayer = layerOf(tgt);
      if (toLayer === fromLayer) continue; // intra-layer: not part of the cross-layer graph
      fileEdges.push({
        from: path.relative(ROOT, f), to: path.relative(ROOT, tgt),
        deferred: r.deferred, line: r.line, fromLayer, toLayer,
      });
      const key = `${fromLayer}->${toLayer}`;
      if (!edges.has(key)) edges.set(key, { top: 0, deferred: 0 });
      edges.get(key)[r.deferred ? 'deferred' : 'top']++;
    }
  }

  const layers = [...new Set(files.map(layerOf))];
  const topAdj = new Map(layers.map(l => [l, new Set()]));
  const allAdj = new Map(layers.map(l => [l, new Set()]));
  for (const [k, v] of edges) {
    const [a, b] = k.split('->');
    if (v.top > 0) topAdj.get(a).add(b);
    allAdj.get(a).add(b);
  }

  return { files, edges, fileEdges, topSCCs: sccs(topAdj), allSCCs: sccs(allAdj) };
}

function _printReport() {
  const { edges, fileEdges, topSCCs, allSCCs } = analyze();

  console.log('=== CROSS-LAYER EDGES (top-level | deferred) ===\n');
  for (const [k, v] of [...edges.entries()].sort()) {
    console.log(`  ${k.padEnd(28)}  top=${String(v.top).padStart(3)}  deferred=${String(v.deferred).padStart(3)}`);
  }

  console.log('\n=== LAYER SCCs (top-level edges only) ===');
  console.log(JSON.stringify(topSCCs));
  console.log('\n=== LAYER SCCs (all edges incl. deferred) ===');
  console.log(JSON.stringify(allSCCs));

  // For the {app,dispatch,panel} historic SCC: dump the TOP-LEVEL edges between
  // them, file by file — the ones a regression would have to cut.
  const SCC = new Set(['app', 'dispatch', 'panel']);
  console.log('\n=== TOP-LEVEL edges WITHIN {app,dispatch,panel} ===\n');
  const within = fileEdges
    .filter(e => SCC.has(e.fromLayer) && SCC.has(e.toLayer) && !e.deferred && e.fromLayer !== e.toLayer)
    .sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
  for (const e of within) console.log(`  ${e.from}:${e.line}  ->  ${e.to}`);
  console.log(`\n  (${within.length} top-level cross-edges inside {app,dispatch,panel})`);

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
}

if (require.main === module) _printReport();

module.exports = { analyze, sccs, layerOf, classifyRequires };
