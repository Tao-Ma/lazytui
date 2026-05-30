/**
 * Block-char line-graph rasterizer. Pure function — given a numeric
 * series, dimensions, and a value range, produces an array of
 * `height` strings each `width` chars wide. No I/O, no theme deps,
 * no markup; the caller composes axis labels and overlays around it.
 *
 * Each character cell carries 8 fill levels via `▁..█`; with `H`
 * rows of height the total resolution is `H*8` slots.
 *
 * Data shape:
 *   - `samples` is newest-last (last element = current value).
 *   - `NaN` / non-finite values render as empty space (gap in graph).
 *   - If samples.length > width: take the last `width` samples.
 *   - If samples.length < width: left-pad with NaN so the graph is
 *     right-aligned (recent data on the right).
 */
'use strict';

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

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
  // Right-align: trim from the front when oversized; left-pad with NaN
  // when undersized so the newest sample is always at column W-1.
  let cut;
  if (samples.length >= width) {
    cut = samples.slice(samples.length - width);
  } else {
    cut = new Array(width - samples.length).fill(NaN).concat(samples);
  }
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

module.exports = { rasterize, BLOCKS };
