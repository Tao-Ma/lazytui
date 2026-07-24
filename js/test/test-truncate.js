/**
 * leaves/render/draw.truncate — MARKUP-AWARE truncation.
 *
 * Regression: truncate used to keep only the LEADING style tag and stripMarkup
 * the rest, so any INNER markup on a truncated line was dropped. The user-visible
 * bug: a drag-selection over a long (truncated) reversed row — e.g. the Wires
 * pane's cursor row — lost its `[/]…[reverse]` XOR break, painting as one solid
 * reverse bar so the selection was invisible.
 *
 * Run: node js/test/test-truncate.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { truncate } = require('../leaves/render/draw');
const { visibleLen } = require('../leaves/text/ansi');

describe('[truncate] preserves INNER markup through truncation', () => {
  it('keeps a mid-line [/]…[reverse] XOR break (selection over a reversed row)', () => {
    // A selected/cursor row (leading [reverse]) with a selection XOR break at
    // cols 10..30 — the shape select-core.highlightLine produces.
    const line = '[reverse]▸ primary.[/]lsn → miner.start    [reverse]      ✓ 0/CAFE [cfg]';
    const out = truncate(line, 40);
    // The inner break must survive: reverse OPENS, CLOSES (the un-reversed
    // selection), then re-OPENS — not collapse to one leading [reverse].
    assert(/\[reverse\].*\[\/\].*\[reverse\]/.test(out), `inner break preserved: ${out}`);
    assert(out.endsWith('…'), 'ellipsis appended');
  });
  it('keeps a mid-line color span (e.g. a search match on a long line)', () => {
    const line = 'the quick brown [reverse][yellow]fox[/] jumps over the lazy dog again';
    const out = truncate(line, 24);
    assert(/\[reverse\]\[yellow\]fox\[\/\]/.test(out), `match markup preserved: ${out}`);
  });
});

describe('[truncate] leading style + width + escapes', () => {
  it('still preserves the LEADING style tag (cursor highlight on a long path)', () => {
    const out = truncate('[reverse]/a/very/long/file/path/that/overflows', 12);
    assert(out.startsWith('[reverse]'), `leading style kept: ${out}`);
    assert(out.endsWith('…'), 'ellipsis');
  });
  it('preserves a \\[ escape as a literal bracket (1 col), not a tag start', () => {
    const out = truncate('[dim]\\[Enter] to run and then some padding overflow[/]', 20);
    assert(out.includes('\\[Enter]'), `escape kept literal: ${out}`);
  });
  it('truncates plain text to maxWidth visible cols incl. the ellipsis', () => {
    const out = truncate('abcdefghij', 5);
    eq(out, 'abcd…');
    eq(visibleLen(out), 5);
  });
  it('CJK width-aware: does not overrun on wide glyphs', () => {
    // each 日本 glyph is 2 cols; maxWidth 5 → room for 2 glyphs (4) + … would be 5,
    // but the -1 ellipsis reserve stops at 2 cols of content then …
    const out = truncate('日本語テスト', 5);
    assert(visibleLen(out) <= 5, `within width: ${JSON.stringify(out)} (${visibleLen(out)})`);
    assert(out.endsWith('…'), 'ellipsis');
  });
  it('short text is returned unchanged (fast path, no ellipsis)', () => {
    eq(truncate('[reverse]a[/]bc[reverse]d', 40), '[reverse]a[/]bc[reverse]d');
  });
});

describe('[truncate] never overruns — parametric no-overrun invariant', () => {
  // The cell-diff emits absolute per-cell column moves, so truncate MUST satisfy
  // visibleLen(out) <= max(0, w) for EVERY input class × width — a 1-col overrun
  // misaligns borders. Sweeps glyph widths, markup, escapes, and degenerate cases.
  const samples = [
    'plain ascii text that is fairly long and will overflow narrow widths',
    '日本語テストワイド'.repeat(4),                 // CJK wide (2 cols each)
    'aＢc日d',                                      // mixed narrow/fullwidth
    '👍🏽 emoji 👩‍👩‍👧 zwj family and more text here', // surrogate pairs + ZWJ
    'áb́ć combining marks trailing',  // zero-width combining
    '[reverse][bold][green]all markup no glyphs[/]',
    '[reverse]▸ leading reverse row, unclosed, to end of a long line',
    'the [reverse][yellow]match[/] inside a longer line that overflows',
    '[unmatched bracket with no close and lots of trailing text here',
    'literal \\[Enter] escape then a long overflowing tail tail tail',
    'ends with a lone backslash and long text \\',
    '',
  ];
  it('visibleLen(truncate(s, w)) <= max(0, w) for all classes × w in [0..14]', () => {
    for (const s of samples) {
      for (let w = 0; w <= 14; w++) {
        const out = truncate(s, w);
        const vl = visibleLen(out);
        assert(vl <= Math.max(0, w),
          `overrun: w=${w} vl=${vl} in=${JSON.stringify(s)} out=${JSON.stringify(out)}`);
      }
    }
  });
  it('non-positive width yields empty (no stray ellipsis)', () => {
    eq(truncate('[reverse]anything', 0), '');
    eq(truncate('anything', -3), '');
  });
  it('a 2-col glyph on a 1-col boundary is refused (no 1-col overrun)', () => {
    // "a" (1) fills to w=3's limit-1=2? then "日" (2) would overrun → dropped.
    const out = truncate('a日 tail', 3);
    assert(visibleLen(out) <= 3, `within 3 cols: ${JSON.stringify(out)}`);
  });
});

report();
