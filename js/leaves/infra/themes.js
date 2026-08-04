/**
 * Built-in themes — named after popular terminal color schemes, carrying
 * those schemes' CANONICAL hex palettes (truecolor arc 1c, docs/truecolor.md).
 * Slot values are markup tag bodies (leaves/text/ansi.js): attribute atoms
 * (`dim`, `reverse`), named colors, and `#rrggbb` truecolor atoms — the
 * pipeline is canonically truecolor; 256/16-color devices get these
 * quantized at the write boundary (P3, leaves/render/color-depth.js).
 * `minimal` deliberately keeps the restrained named-16 look.
 * User selects via YAML: theme: dracula
 *
 * GRADS holds per-theme gradient ANCHORS (start/mid/end hex triples) for
 * value-mapped graph coloring; `gradient(name, frac)` resolves a fraction to
 * a hex through a lazily built ~100-step ramp, cached per (theme, name) —
 * setTheme runs per frame (#D8 sync), so expansion must never ride on it.
 * All RGB lives HERE: panels obtain colors only via theme()/gradient()
 * (slot discipline P2, enforced by test-color-tripwire.js).
 *
 * Lives in `leaves/infra/` (#D1 2026-06-18): the THEMES table is pure data,
 * but this module also holds the STATEFUL palette cache (`active`/
 * `activeName`, mutated by setTheme — the #D8 two-store synced from
 * model.theme), so it sits in the stateful-infra sub-tier, not `leaves/`
 * proper (pure transforms). The gradient ramp cache is a pure-derivation
 * memo keyed by theme name inside the same store — no new stateful tier.
 * See infra/hub.js for the tier contract.
 */
'use strict';

const DEFAULT_THEME = 'monokai';

const THEMES = {
  // Monokai — warm yellow accents (default)
  monokai: {
    focus: '#e6db74',
    dim: 'dim',
    selected: '#f8f8f2 on #49483e',
    accent: '#e6db74',
    running: '#a6e22e',
    stopped: '#f92672',
    partial: '#e6db74',
    unknown: 'dim',
    footer: '#a59f85 on #3e3d32',
    bold_current: 'bold #e6db74',
    chrome_collapse: '#e6db74',
    chrome_expand:   '#a6e22e',
    chrome_close:    '#f92672',
    chrome_trigger:  'bold #e6db74',
    success: '#a6e22e',
    warning: '#e6db74',
    error:   '#f92672',
    match:   '#e6db74',
    match_current: '#272822 on #e6db74',
  },

  // Dracula — purple/cyan accents
  dracula: {
    focus: '#ff79c6',
    dim: 'dim',
    selected: '#f8f8f2 on #44475a',
    accent: '#8be9fd',
    running: '#50fa7b',
    stopped: '#ff5555',
    partial: '#f1fa8c',
    unknown: 'dim',
    footer: '#bd93f9 on #343746',
    bold_current: 'bold #8be9fd',
    chrome_collapse: '#f1fa8c',
    chrome_expand:   '#50fa7b',
    chrome_close:    '#ff5555',
    chrome_trigger:  'bold #ff79c6',
    success: '#50fa7b',
    warning: '#f1fa8c',
    error:   '#ff5555',
    match:   '#f1fa8c',
    match_current: '#282a36 on #f1fa8c',
  },

  // Solarized — blue/cyan, muted
  solarized: {
    focus: '#2aa198',
    dim: 'dim',
    selected: '#eee8d5 on #586e75',
    accent: '#2aa198',
    running: '#859900',
    stopped: '#dc322f',
    partial: '#b58900',
    unknown: 'dim',
    footer: '#93a1a1 on #073642',
    bold_current: 'bold #2aa198',
    chrome_collapse: '#b58900',
    chrome_expand:   '#859900',
    chrome_close:    '#dc322f',
    chrome_trigger:  'bold #2aa198',
    success: '#859900',
    warning: '#b58900',
    error:   '#dc322f',
    match:   '#b58900',
    match_current: '#002b36 on #b58900',
  },

  // Gruvbox — warm orange/yellow
  gruvbox: {
    focus: '#fabd2f',
    dim: 'dim',
    selected: '#fbf1c7 on #665c54',
    accent: '#fabd2f',
    running: '#b8bb26',
    stopped: '#fb4934',
    partial: '#fabd2f',
    unknown: 'dim',
    footer: '#ebdbb2 on #504945',
    bold_current: 'bold',
    chrome_collapse: '#fabd2f',
    chrome_expand:   '#b8bb26',
    chrome_close:    '#fb4934',
    chrome_trigger:  'bold #fabd2f',
    success: '#b8bb26',
    warning: '#fabd2f',
    error:   '#fb4934',
    match:   '#fabd2f',
    match_current: '#282828 on #fabd2f',
  },

  // Nord — cool blue
  nord: {
    focus: '#81a1c1',
    dim: 'dim',
    selected: '#eceff4 on #4c566a',
    accent: '#88c0d0',
    running: '#a3be8c',
    stopped: '#bf616a',
    partial: '#ebcb8b',
    unknown: 'dim',
    footer: '#d8dee9 on #434c5e',
    bold_current: 'bold #88c0d0',
    chrome_collapse: '#ebcb8b',
    chrome_expand:   '#a3be8c',
    chrome_close:    '#bf616a',
    chrome_trigger:  'bold #81a1c1',
    success: '#a3be8c',
    warning: '#ebcb8b',
    error:   '#bf616a',
    match:   '#ebcb8b',
    match_current: '#2e3440 on #ebcb8b',
  },

  // Minimal — white borders, restrained named-16 palette (doubles as the
  // pure-16-color theme: nothing here needs quantization).
  minimal: {
    focus: 'white',
    dim: 'dim',
    selected: 'reverse',
    accent: 'white',
    running: 'green',
    stopped: 'red',
    partial: 'yellow',
    unknown: 'dim',
    footer: 'dim reverse',
    bold_current: 'bold',
    chrome_collapse: 'yellow',
    chrome_expand:   'green',
    chrome_close:    'red',
    chrome_trigger:  'bold white',
    success: 'green',
    warning: 'yellow',
    error:   'red',
    match:   'yellow',
    match_current: 'reverse yellow',
  },
};

// Gradient anchors per theme — [start, mid, end] hex, low→high value (the
// classic cool→hot ramp, tinted to each scheme). Kept OUTSIDE the slot
// objects so theme() stays a pure slot→tag map.
const GRADS = {
  monokai:   { percent: ['#a6e22e', '#e6db74', '#f92672'] },
  dracula:   { percent: ['#50fa7b', '#f1fa8c', '#ff5555'] },
  solarized: { percent: ['#859900', '#b58900', '#dc322f'] },
  gruvbox:   { percent: ['#b8bb26', '#fabd2f', '#fb4934'] },
  nord:      { percent: ['#a3be8c', '#ebcb8b', '#bf616a'] },
  minimal:   { percent: ['#4d4d4d', '#a6a6a6', '#ffffff'] },
};

let active = THEMES[DEFAULT_THEME];
let activeName = DEFAULT_THEME;

function setTheme(name) {
  if (THEMES[name]) { active = THEMES[name]; activeName = name; }
  else              { active = THEMES[DEFAULT_THEME]; activeName = DEFAULT_THEME; }
}

function theme() { return active; }
function activeThemeName() { return activeName; }
function themeNames() { return Object.keys(THEMES); }

// --- gradient(name, frac) → '#rrggbb' -------------------------------------
// Value-mapped graph color: frac ∈ [0,1] (clamped) resolves through a
// STEPS+1-entry ramp interpolated start→mid→end in linear RGB. Ramps build
// lazily and cache per (theme, gradient) — a pure derivation of GRADS, so
// the cache never invalidates. Unknown names fall back to 'percent'.
const STEPS = 100;
const _rampCache = new Map();

function _hexToRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function _rgbToHex(r, g, b) {
  const two = (v) => v.toString(16).padStart(2, '0');
  return `#${two(r)}${two(g)}${two(b)}`;
}
function _mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function _ramp(themeName, gradName) {
  const key = `${themeName}:${gradName}`;
  let ramp = _rampCache.get(key);
  if (ramp) return ramp;
  const anchors = (GRADS[themeName] && GRADS[themeName][gradName])
    || GRADS[themeName].percent;
  const [s, m, e] = anchors.map(_hexToRgb);
  ramp = new Array(STEPS + 1);
  for (let i = 0; i <= STEPS; i++) {
    const f = i / STEPS;
    const rgb = f <= 0.5 ? _mix(s, m, f * 2) : _mix(m, e, (f - 0.5) * 2);
    ramp[i] = _rgbToHex(rgb[0], rgb[1], rgb[2]);
  }
  _rampCache.set(key, ramp);
  return ramp;
}

function gradient(name, frac) {
  const f = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  return _ramp(activeName, name)[Math.round(f * STEPS)];
}

module.exports = { setTheme, theme, activeThemeName, themeNames, gradient, THEMES, GRADS, DEFAULT_THEME };
