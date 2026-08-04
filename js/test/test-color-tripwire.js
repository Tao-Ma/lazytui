/**
 * Slot-discipline tripwire (truecolor arc P2, docs/truecolor.md).
 *
 * ALL RGB lives in themes.js: panels obtain colors only via theme() /
 * gradient(), so hex color literals may appear in exactly two source
 * files — leaves/infra/themes.js (the palettes + gradient anchors) and
 * leaves/render/color-depth.js (the xterm DEVICE palette: quantization
 * math, not a UI color choice). A hex literal anywhere else in js/
 * (tests excluded — they pin parser/quantizer bytes) is color drift:
 * fix it by adding/using a theme slot, not by allowlisting the file.
 *
 * "No raw RGB outside themes" is a LEXICAL property, so a source scan is
 * the semantic check here — the rare case where grep is the right tool.
 *
 * Run: node js/test/test-color-tripwire.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it, assert, report } = require('./test-runner');

const ROOT = path.join(__dirname, '..');
const ALLOWED = new Set([
  path.join('leaves', 'infra', 'themes.js'),
  path.join('leaves', 'render', 'color-depth.js'),
]);
const HEX_LITERAL = /#[0-9a-fA-F]{6}\b/;

function* walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.relative(ROOT, p);
    if (rel === 'test' || name === 'node_modules') continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith('.js')) yield [rel, p];
  }
}

describe('hex color literals appear only in themes.js + the device palette', () => {
  it('scan js/ (excluding js/test/)', () => {
    const offenders = [];
    for (const [rel, p] of walk(ROOT)) {
      if (ALLOWED.has(rel)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (!HEX_LITERAL.test(src)) continue;
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (HEX_LITERAL.test(lines[i])) offenders.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
    assert(offenders.length === 0,
      `hex color literal(s) outside the allowlist — use a theme slot / gradient() instead:\n  ${offenders.join('\n  ')}`);
  });
});

report();
