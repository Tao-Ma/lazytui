/**
 * A2 measurement (v0.6.7) — cell-diff vs row-diff: bytes-on-wire + CPU.
 *
 * The honest trade: cell-diff parses BOTH rows into cells (more CPU per changed
 * row) but emits only changed cells (fewer bytes). It wins when FEW cells change
 * (clock digit, spinner, one footer field, typing) and is neutral-to-loss when
 * whole rows change (a selection bar flipping reverse-video across a line; a
 * scrolling viewport where every row's content shifts).
 *
 * For each scenario we compute, over the SAME (prev,cur) frame, both emits and
 * report bytes (row → cell, % saved) and CPU (ops/sec each). Benches the A2
 * implementation in leaves/render/cell-grid.js (distinct from the replay
 * highlighter leaves/render/cell-diff.js). Run:
 *   node js/test/bench-cell-grid.js
 */
'use strict';

const { richToAnsi, RESET } = require('../leaves/text/ansi');
const cellGrid = require('../leaves/render/cell-grid');

const COLS = 120, ROWS = 48;

// Row-level emit (the current default path in painter.paintFrame).
function rowEmit(prev, cur) {
  let ansi = '';
  for (let i = 0; i < cur.length; i++) {
    if (cur[i] !== prev[i]) ansi += `\x1b[${i + 1};1H` + richToAnsi(cur[i]) + RESET + '\x1b[K';
  }
  return ansi;
}
// Cell-level emit (A2).
function cellEmit(prev, cur) {
  let ansi = '';
  for (let i = 0; i < cur.length; i++) {
    if (cur[i] !== prev[i]) ansi += cellGrid.diffRowToAnsi(prev[i], cur[i], i);
  }
  return ansi;
}

const pad = (s) => (s.length < COLS ? s + ' '.repeat(COLS - s.length) : s.slice(0, COLS));
// A plausibly-busy base frame: a mix of plain + colored + reverse rows.
function baseFrame() {
  const rows = [];
  for (let i = 0; i < ROWS; i++) {
    if (i === 0) rows.push(pad('[bold] lazytui — group: demo                       12:00:00[/]'));
    else if (i % 7 === 0) rows.push(pad(`[green]●[/] container-${i} running   cpu 2.${i % 10}%  mem 31MB`));
    else if (i === 3) rows.push(pad('[reverse] selected row — the cursor lives here'));
    else rows.push(pad(`line ${i}: the quick brown fox jumps over the lazy dog ${i}`));
  }
  return rows;
}

const scenarios = {
  'clock tick (1 digit in the header)': (f) => {
    const c = f.slice(); c[0] = pad('[bold] lazytui — group: demo                       12:00:01[/]'); return c;
  },
  'spinner frame (1 cell)': (f) => {
    const c = f.slice(); c[7] = c[7].replace('●', '◐'); return c;
  },
  'selection bar moves (2 rows flip reverse)': (f) => {
    const c = f.slice();
    c[3] = pad('line 3: the quick brown fox jumps over the lazy dog 3');     // loses reverse
    c[4] = pad('[reverse] selected row — the cursor lives here');            // gains reverse
    return c;
  },
  'typing a char into a footer field': (f) => {
    const c = f.slice(); c[ROWS - 1] = pad(':open data/conf'); return c;
  },
  'scroll: every viewport row shifts by one': (f) => {
    const c = f.slice();
    for (let i = 1; i < ROWS - 1; i++) c[i] = pad(`line ${i + 1}: the quick brown fox jumps over the lazy dog ${i + 1}`);
    return c;
  },
};

function timeOps(fn, prev, cur, iters) {
  // warmup
  for (let i = 0; i < 2000; i++) fn(prev, cur);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn(prev, cur);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  return Math.round(iters / (ms / 1000));
}

const base = baseFrame();
console.log(`cell-diff vs row-diff — ${ROWS}×${COLS} frame, per-scenario (one frame update)\n`);
const ITERS = 50000;
for (const [name, mut] of Object.entries(scenarios)) {
  const cur = mut(base);
  const rb = rowEmit(base, cur).length;
  const cb = cellEmit(base, cur).length;
  const saved = rb === 0 ? 0 : Math.round((1 - cb / rb) * 100);
  const rowOps = timeOps(rowEmit, base, cur, ITERS);
  const cellOps = timeOps(cellEmit, base, cur, ITERS);
  const cpu = Math.round((cellOps / rowOps - 1) * 100);
  console.log(`${name}`);
  console.log(`  bytes:  row ${rb}  →  cell ${cb}   (${saved >= 0 ? '-' : '+'}${Math.abs(saved)}% on the wire)`);
  console.log(`  cpu:    row ${rowOps.toLocaleString()} ops/s  cell ${cellOps.toLocaleString()} ops/s   (cell ${cpu >= 0 ? '+' : ''}${cpu}%)\n`);
}
