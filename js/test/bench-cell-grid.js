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
 *
 * NOTE: these numbers are the screen-colours-OFF baseline (this bench never calls
 * ansi.enableScreenColors). PRODUCTION runs screen colours ON (app/tui.js), where
 * every cell carries an explicit fg+bg — so localized-update savings are ~10 pts
 * lower and scroll ~14 pts lower than reported here (still a clear win). See
 * docs/truecolor.md §Themed screen colours.
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
  // Truecolor arc 1e (docs/truecolor.md §Bench) — hex-tag scenarios through
  // the same markup path panels use. The gradient tick is the Phase-2 graph
  // workload: per-run colored braille, every run [/]-terminated (P8 — the
  // reset-free shape is the H1 quadratic and is pinned OUT by the oracle).
};

// Truecolor arc 1e (docs/truecolor.md §Bench) — hex-tag scenarios through
// the same markup path panels use, on their OWN prev frame (seeding graph
// rows into the shared base would perturb the frozen scroll baseline). The
// gradient tick is the Phase-2 graph workload: per-run colored braille,
// every run [/]-terminated (P8 — the reset-free shape is the H1 quadratic
// and is pinned OUT by the oracle).
const tcScenarios = {
  'truecolor: one status cell changes shade': (f) => {
    const c = f.slice(); c[7] = pad(`[#a6e22e]●[/] container-7 running   cpu 2.7%  mem 31MB`); return c;
  },
  'truecolor gradient graph tick (4 rows, per-run color)': (f) => {
    const c = f.slice();
    for (let r = 0; r < 4; r++) c[20 + r] = gradGraphRow(r, 1);
    return c;
  },
};

// A markup graph row: 8-col runs of braille, each run its own hex shade —
// a tick shifts glyphs AND run colors, the worst realistic Phase-2 case.
// NOT pad()ed: pad slices by raw length and would cut mid-markup; the row is
// already exactly COLS visible glyphs.
const _BRAILLE = '⣀⣤⣶⣿⡿⠿⠛⠉';
const _SHADES = ['#50f8a0', '#78e884', '#a0d868', '#c8c84c', '#f0b830', '#f89020', '#f86810', '#f84000'];
function gradGraphRow(row, tick) {
  let s = '';
  for (let run = 0; run < COLS / 8; run++) {
    const v = (run + row + tick) % 8;
    s += `[${_SHADES[v]}]${_BRAILLE[v].repeat(8)}[/]`;
  }
  return s;
}

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
function runScenario(name, prev, cur) {
  const rb = rowEmit(prev, cur).length;
  const cb = cellEmit(prev, cur).length;
  const saved = rb === 0 ? 0 : Math.round((1 - cb / rb) * 100);
  const rowOps = timeOps(rowEmit, prev, cur, ITERS);
  const cellOps = timeOps(cellEmit, prev, cur, ITERS);
  const cpu = Math.round((cellOps / rowOps - 1) * 100);
  console.log(`${name}`);
  console.log(`  bytes:  row ${rb}  →  cell ${cb}   (${saved >= 0 ? '-' : '+'}${Math.abs(saved)}% on the wire)`);
  console.log(`  cpu:    row ${rowOps.toLocaleString()} ops/s  cell ${cellOps.toLocaleString()} ops/s   (cell ${cpu >= 0 ? '+' : ''}${cpu}%)\n`);
}
for (const [name, mut] of Object.entries(scenarios)) {
  runScenario(name, base, mut(base));
}
// Truecolor scenarios diff against a graph-seeded variant of the base.
const tcBase = base.slice();
for (let r = 0; r < 4; r++) tcBase[20 + r] = gradGraphRow(r, 0);
for (const [name, mut] of Object.entries(tcScenarios)) {
  runScenario(name, tcBase, mut(tcBase));
}
