/**
 * Graph rasterizers + colorize/meter leaves (truecolor arc Phase 2,
 * docs/truecolor.md). Pure functions — given a numeric series, dimensions,
 * and a value range, produce arrays of `height` strings each `width` VISIBLE
 * columns wide. No I/O, no theme deps; color enters ONLY through the
 * injected `colorFor` callback (leaves purity wall — the panel passes
 * themes.gradient), and every emitted color run is `[/]`-terminated (P8:
 * the reset-free per-column shape is the H1 quadratic).
 *
 * Two rasterizers, one contract:
 *   - `rasterize` — block chars, 8 fill levels per cell (`▁..█`), 1 sample
 *     per column; H rows = H*8 vertical slots.
 *   - `rasterizeBraille` — braille (U+2800 block), 2×4 dots per cell:
 *     2 samples per column and H rows = H*4 vertical slots — double the
 *     horizontal resolution of blocks.
 *
 * Data shape (both):
 *   - `samples` is newest-last (last element = current value).
 *   - `NaN` / non-finite values render as empty space (gap in graph; for
 *     braille, a gap in that half-cell).
 *   - Longer-than-needed series: take the newest window. Shorter: left-pad
 *     with NaN so the graph is right-aligned (recent data on the right).
 */
'use strict';

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// Window `samples` to exactly `need` entries: newest-last kept, front
// NaN-padded when short (the shared right-align rule).
function _cut(samples, need) {
  if (samples.length >= need) return samples.slice(samples.length - need);
  return new Array(need - samples.length).fill(NaN).concat(samples);
}

function _norm01(v, min, max) {
  const range = max - min;
  if (!Number.isFinite(v) || range <= 0) return NaN;
  return Math.max(0, Math.min(1, (v - min) / range));
}

/**
 * @param {number[]} samples — newest last; non-finite renders as ' '
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.min
 * @param {number} opts.max
 * @returns {string[]} `height` rows, each exactly `width` chars
 */
function rasterize(samples, { width, height, min, max }) {
  if (height < 1 || width < 1) return [];
  const range = max - min;
  const cut = _cut(samples, width);
  const slots = new Array(width);
  const nans = new Array(width);
  for (let c = 0; c < width; c++) {
    const v = cut[c];
    if (!Number.isFinite(v) || range <= 0) {
      slots[c] = 0; nans[c] = !Number.isFinite(v);
      continue;
    }
    const norm = Math.max(0, Math.min(1, (v - min) / range));
    slots[c] = Math.round(norm * height * 8);
    nans[c] = false;
  }
  const rows = new Array(height);
  for (let r = 0; r < height; r++) {
    // Bottom row first in slot space (cells closer to slot=0 are at the
    // bottom of the graph). r=0 is the top row visually.
    const bottomOfRow = (height - 1 - r) * 8;
    let row = '';
    for (let c = 0; c < width; c++) {
      if (nans[c]) { row += ' '; continue; }
      const within = slots[c] - bottomOfRow;
      if (within <= 0) row += ' ';
      else if (within >= 8) row += '█';
      else row += BLOCKS[within];
    }
    rows[r] = row;
  }
  return rows;
}

// Braille dot bits (U+2800 base): left column top→bottom 0x01 0x02 0x04
// 0x40, right column 0x08 0x10 0x20 0x80. A bar fills from the BOTTOM, so
// k filled dot-rows in a half-cell = the bottom k bits of that column.
const _BRL_LEFT  = [0, 0x40, 0x44, 0x46, 0x47];
const _BRL_RIGHT = [0, 0x80, 0xA0, 0xB0, 0xB8];

/**
 * Braille rasterizer — same contract as `rasterize` (see header), but each
 * output column consumes TWO samples (left/right dot columns) and each row
 * carries 4 vertical dot slots. A non-finite sample leaves its half-cell
 * empty; a column whose both samples are gaps renders ' '.
 *
 * @param {number[]} samples — newest last
 * @param {{width:number, height:number, min:number, max:number}} opts
 * @returns {string[]} `height` rows, each exactly `width` chars
 */
function rasterizeBraille(samples, { width, height, min, max }) {
  if (height < 1 || width < 1) return [];
  const cut = _cut(samples, width * 2);
  const slots = new Array(width * 2);
  for (let i = 0; i < cut.length; i++) {
    const n = _norm01(cut[i], min, max);
    slots[i] = Number.isFinite(n) ? Math.round(n * height * 4) : 0;
  }
  const rows = new Array(height);
  for (let r = 0; r < height; r++) {
    const bottomOfRow = (height - 1 - r) * 4;
    let row = '';
    for (let c = 0; c < width; c++) {
      const kl = Math.max(0, Math.min(4, slots[c * 2] - bottomOfRow));
      const kr = Math.max(0, Math.min(4, slots[c * 2 + 1] - bottomOfRow));
      row += (kl || kr) ? String.fromCharCode(0x2800 | _BRL_LEFT[kl] | _BRL_RIGHT[kr]) : ' ';
    }
    rows[r] = row;
  }
  return rows;
}

/**
 * Per-column value norms for colorizing, aligned with the rasterizers'
 * windowing: `group` samples per output column (1 for blocks, 2 for
 * braille), each column = the MAX of its group's finite norms (peaks win),
 * NaN when the whole group is gaps. Returns `width` entries in [0,1]|NaN.
 */
function columnNorms(samples, { width, min, max, group = 1 }) {
  if (width < 1) return [];   // degenerate width (a sub-2-col pane) — match the
                              // rasterizers' guard; else `new Array(<negative>)` throws.
  const cut = _cut(samples, width * group);
  const norms = new Array(width);
  for (let c = 0; c < width; c++) {
    let best = NaN;
    for (let g = 0; g < group; g++) {
      const n = _norm01(cut[c * group + g], min, max);
      if (Number.isFinite(n) && !(n <= best)) best = n;
    }
    norms[c] = best;
  }
  return norms;
}

/**
 * Wrap plain graph rows in value-mapped markup color runs. `colorFor(norm)`
 * → a markup color atom (the panel passes themes.gradient) or falsy for
 * uncolored; space columns stay uncolored. Adjacent same-atom columns batch
 * into ONE `[atom]…[/]` run, and every run is `[/]`-terminated (P8). Rows
 * must be single-width glyphs (blocks/braille both are).
 */
function colorizeRows(rows, norms, colorFor) {
  return rows.map((row) => {
    let out = '';
    let run = null;
    let buf = '';
    const flush = () => {
      if (!buf) return;
      out += run ? `[${run}]${buf}[/]` : buf;
      buf = '';
    };
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      const atom = ch === ' ' ? null : (colorFor(norms[c]) || null);
      if (atom !== run) { flush(); run = atom; }
      buf += ch;
    }
    flush();
    return out;
  });
}

/**
 * Height-mapped colorize (btop-style) — each row is ONE color run, determined
 * by its VERTICAL position (top = hot end of the ramp, bottom = cool). Because a
 * row's color is fixed regardless of the samples, a value shift that moves the
 * glyphs but not a row's contents emits no SGR change — cell-diff only re-sends
 * the cells whose GLYPH changed. That's the byte-thrift win over the value-mapped
 * `colorizeRows` (which recolors nearly every column each tick). `colorFor(frac)`
 * gets the row's height fraction ∈ [0,1] (1 = top). All-space rows stay bare.
 */
function colorizeByHeight(rows, colorFor) {
  const H = rows.length;
  return rows.map((row, i) => {
    if (!/\S/.test(row)) return row;                 // all gaps → uncolored
    const frac = H > 1 ? (H - 1 - i) / (H - 1) : 1;   // top row = 1, bottom = 0
    const atom = colorFor(frac) || null;
    return atom ? `[${atom}]${row}[/]` : row;
  });
}

/**
 * Quantize a norm ∈ [0,1] to one of `bands` evenly-spaced levels (band centers
 * at k/(bands-1)). Keeps the value→color SEMANTICS of `colorizeRows` but snaps
 * the color, so a small sample shift that stays within a band emits no SGR
 * change — a middle ground between the full 101-step ramp and height-mapping.
 * NaN passes through (a gap column stays uncolored).
 */
function quantizeNorm(n, bands) {
  if (!Number.isFinite(n)) return n;
  const b = Math.max(2, bands | 0);
  return Math.round(Math.max(0, Math.min(1, n)) * (b - 1)) / (b - 1);
}

// Horizontal eighth-block partials, 1/8 → 7/8 (left-fill).
const _MPARTIAL = '▏▎▍▌▋▊▉';

/**
 * One meter row: `frac` ∈ [0,1] of `width` columns filled left→right in
 * eighth-block resolution. Non-finite/negative → empty track (spaces);
 * the caller colors the whole row as one run (a meter is one value).
 */
function meterRow(frac, width) {
  if (width < 1) return '';
  const f = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  const eighths = Math.round(f * width * 8);
  const full = eighths >> 3;
  const rem = eighths & 7;
  let s = '█'.repeat(full);
  if (rem) s += _MPARTIAL[rem - 1];
  return s.length < width ? s + ' '.repeat(width - s.length) : s;
}

module.exports = { rasterize, rasterizeBraille, columnNorms, colorizeRows, colorizeByHeight, quantizeNorm, meterRow, BLOCKS };
