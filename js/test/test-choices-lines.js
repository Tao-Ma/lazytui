/**
 * Pure-leaf test for `js/leaves/text/choices-lines.js` — the stdout-splitter
 * `choices_cmd:` runtime uses to convert child output into {items, labels}.
 *
 * Covers brief §3.2 rules:
 *   - LF split; CRLF normalized; lone \r normalized
 *   - fully empty lines dropped (leading, interior, trailing)
 *   - labeled:false → each line is a value; label === value
 *   - labeled:true → first-\t splits value\tlabel; no-\t → label falls back
 *     to value; subsequent \t chars kept literal (flattened to space)
 *   - defensive: non-string input, \r/\n inside a label flattened
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { parseChoicesStdout } = require('../leaves/text/choices-lines');

describe('[choices-lines] unlabeled — plain newline split', () => {
  it('three items', () => {
    eq(parseChoicesStdout('a\nb\nc\n', { labeled: false }),
       { items: ['a', 'b', 'c'], labels: null });
  });

  it('no trailing newline is fine', () => {
    eq(parseChoicesStdout('a\nb\nc', { labeled: false }),
       { items: ['a', 'b', 'c'], labels: null });
  });

  it('empty stdout → empty items', () => {
    eq(parseChoicesStdout('', { labeled: false }),
       { items: [], labels: null });
  });

  it('only newlines → empty items', () => {
    eq(parseChoicesStdout('\n\n\n', { labeled: false }),
       { items: [], labels: null });
  });

  it('CRLF normalized to LF', () => {
    eq(parseChoicesStdout('a\r\nb\r\nc\r\n', { labeled: false }),
       { items: ['a', 'b', 'c'], labels: null });
  });

  it('lone \\r normalized to LF (classic-Mac defense)', () => {
    eq(parseChoicesStdout('a\rb\rc', { labeled: false }),
       { items: ['a', 'b', 'c'], labels: null });
  });

  it('interior empty lines dropped', () => {
    eq(parseChoicesStdout('a\n\nb\n\n\nc', { labeled: false }),
       { items: ['a', 'b', 'c'], labels: null });
  });

  it('leading empty lines dropped', () => {
    eq(parseChoicesStdout('\n\na\nb', { labeled: false }),
       { items: ['a', 'b'], labels: null });
  });

  it('literal tab in unlabeled line is flattened to space', () => {
    // Preserves single-row paint invariant — a literal \t would emit a
    // horizontal-tab escape and re-anchor the next cell's paint column.
    eq(parseChoicesStdout('a\tb\nc', { labeled: false }),
       { items: ['a b', 'c'], labels: null });
  });

  it('non-string input → empty', () => {
    eq(parseChoicesStdout(null, { labeled: false }),
       { items: [], labels: null });
    eq(parseChoicesStdout(42, { labeled: false }),
       { items: [], labels: null });
  });
});

describe('[choices-lines] labeled — first-\\t split', () => {
  it('value\\tlabel splits as expected', () => {
    const r = parseChoicesStdout('v1\tLabel One\nv2\tLabel Two', { labeled: true });
    eq(r.items, ['v1', 'v2']);
    eq(r.labels, ['Label One', 'Label Two']);
  });

  it('no \\t on a labeled line → label falls back to value', () => {
    const r = parseChoicesStdout('bare\nv2\tL2', { labeled: true });
    eq(r.items, ['bare', 'v2']);
    eq(r.labels, ['bare', 'L2']);
  });

  it('all-bare labeled list → items === labels', () => {
    const r = parseChoicesStdout('a\nb\nc', { labeled: true });
    eq(r.items, ['a', 'b', 'c']);
    eq(r.labels, ['a', 'b', 'c']);
  });

  it('subsequent \\t chars in label kept (flattened to space, not re-split)', () => {
    const r = parseChoicesStdout('v\tL1\tL2\tL3', { labeled: true });
    eq(r.items, ['v']);
    eq(r.labels, ['L1 L2 L3']);
  });

  it('empty value with a label (leading \\t) → empty item kept, label used', () => {
    // The user said "a labeled line without a tab means label=value"; a line
    // starting with \t has a tab, so value is '' and label is the rest. We
    // keep the empty value (the author presumably intended a sentinel).
    const r = parseChoicesStdout('\tjust-label', { labeled: true });
    eq(r.items, ['']);
    eq(r.labels, ['just-label']);
  });

  it('empty label (trailing \\t) → value kept, label is empty string', () => {
    const r = parseChoicesStdout('v\t', { labeled: true });
    eq(r.items, ['v']);
    eq(r.labels, ['']);
  });

  it('CRLF normalized before tab split', () => {
    const r = parseChoicesStdout('v1\tL1\r\nv2\tL2\r\n', { labeled: true });
    eq(r.items, ['v1', 'v2']);
    eq(r.labels, ['L1', 'L2']);
  });

  it('empty stdout → empty items + null labels (shape consistent with fn-channel)', () => {
    // The reducer arm's WAL shape is `labels: null` for the empty-return case
    // on the fn channel; normalize here so same semantic hashes same shape.
    const r = parseChoicesStdout('', { labeled: true });
    eq(r.items, []);
    eq(r.labels, null);
  });

  it('labeled:true opts default to false if missing', () => {
    const r = parseChoicesStdout('a\tb', undefined);
    eq(r.items, ['a b']);                     // flattened in the unlabeled path
    eq(r.labels, null);
  });
});

report();
