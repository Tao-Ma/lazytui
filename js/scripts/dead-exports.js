#!/usr/bin/env node
'use strict';
/**
 * Conservative dead-export scanner (§5(d) re-verify tool).
 *
 * For each prod module's `module.exports = { ... }` block (and `exports.x =`),
 * extract exported names and classify by where the name-token appears ELSEWHERE
 * in the js/ tree:
 *   DEAD      — appears in no other file at all (prod or test)
 *   TEST-ONLY — appears only in js/test/ (+ scripts), never in another prod file
 * Conservative by design: a name is "used" if its \bNAME\b token shows up in
 * another file in ANY context, so we UNDER-report (never flag a live export).
 * Manual vetting still required — namespace re-exports + common-word collisions.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');           // js/
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}
const allFiles = walk(ROOT);
const isTestish = f => /\/(test|scripts)\//.test(f);
const prodFiles = allFiles.filter(f => !isTestish(f));

// corpus: file -> source
const src = new Map();
for (const f of allFiles) src.set(f, fs.readFileSync(f, 'utf8'));

// strip line + block comments crudely for token search (keeps offsets loose)
function decomment(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}
const decommented = new Map();
for (const [f, s] of src) decommented.set(f, decomment(s));

function exportsOf(source) {
  const names = new Set();
  // block form: module.exports = { ... }
  const m = source.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\}/);
  if (m) {
    const body = decomment(m[1]);
    for (const part of body.split(',')) {
      const t = part.trim();
      if (!t || t.startsWith('...')) continue;
      const key = t.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
    }
  }
  // exports.x = / module.exports.x =
  for (const mm of source.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(mm[1]);
  }
  return names;
}

const dead = [], testOnly = [];
for (const f of prodFiles) {
  const names = exportsOf(src.get(f));
  for (const name of names) {
    const re = new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\b');
    let inOtherProd = false, inTest = false;
    for (const g of allFiles) {
      if (g === f) continue;
      if (!re.test(decommented.get(g))) continue;
      if (isTestish(g)) inTest = true; else { inOtherProd = true; break; }
    }
    if (inOtherProd) continue;
    const rel = path.relative(ROOT, f);
    if (inTest) testOnly.push(`${rel} :: ${name}`);
    else dead.push(`${rel} :: ${name}`);
  }
}

console.log(`=== DEAD (no reference anywhere outside defining file) — ${dead.length} ===`);
for (const d of dead.sort()) console.log('  ' + d);
console.log(`\n=== TEST-ONLY (referenced only under test/|scripts/) — ${testOnly.length} ===`);
for (const t of testOnly.sort()) console.log('  ' + t);
