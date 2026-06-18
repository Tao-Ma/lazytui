/**
 * Built-in themes — named after popular terminal color schemes.
 * Uses basic 16 ANSI colors (actual appearance depends on terminal theme).
 * User selects via YAML: theme: dracula
 * Zero dependencies.
 *
 * Lives in `leaves/infra/` (#D1 2026-06-18): the THEMES table is pure data, but
 * this module also holds the STATEFUL palette cache (`active`/`activeName`,
 * mutated by setTheme — the #D8 two-store synced from model.theme), so it sits
 * in the stateful-infra sub-tier, not `leaves/` proper (pure transforms). See
 * infra/hub.js for the tier contract.
 */
'use strict';

const DEFAULT_THEME = 'monokai';

const THEMES = {
  // Monokai — warm yellow accents (default)
  monokai: {
    focus: 'yellow',
    dim: 'dim',
    selected: 'reverse',
    accent: 'yellow',
    running: 'green',
    stopped: 'red',
    partial: 'yellow',
    unknown: 'dim',
    footer: 'dim reverse',
    bold_current: 'bold yellow',
    chrome_collapse: 'yellow',
    chrome_expand:   'green',
    chrome_close:    'red',
    chrome_trigger:  'bold yellow',
  },

  // Dracula — purple/cyan accents
  dracula: {
    focus: 'magenta',
    dim: 'dim',
    selected: 'reverse',
    accent: 'cyan',
    running: 'green',
    stopped: 'red',
    partial: 'yellow',
    unknown: 'dim',
    footer: 'dim reverse',
    bold_current: 'bold cyan',
    chrome_collapse: 'yellow',
    chrome_expand:   'green',
    chrome_close:    'red',
    chrome_trigger:  'bold magenta',
  },

  // Solarized — blue/cyan, muted
  solarized: {
    focus: 'cyan',
    dim: 'dim',
    selected: 'reverse',
    accent: 'cyan',
    running: 'green',
    stopped: 'red',
    partial: 'yellow',
    unknown: 'dim',
    footer: 'dim reverse',
    bold_current: 'bold cyan',
    chrome_collapse: 'yellow',
    chrome_expand:   'green',
    chrome_close:    'red',
    chrome_trigger:  'bold cyan',
  },

  // Gruvbox — warm orange/yellow
  gruvbox: {
    focus: 'yellow',
    dim: 'dim',
    selected: 'reverse',
    accent: 'yellow',
    running: 'green',
    stopped: 'red',
    partial: 'yellow',
    unknown: 'dim',
    footer: 'dim reverse',
    bold_current: 'bold',
    chrome_collapse: 'yellow',
    chrome_expand:   'green',
    chrome_close:    'red',
    chrome_trigger:  'bold yellow',
  },

  // Nord — cool blue
  nord: {
    focus: 'blue',
    dim: 'dim',
    selected: 'reverse',
    accent: 'cyan',
    running: 'green',
    stopped: 'red',
    partial: 'yellow',
    unknown: 'dim',
    footer: 'dim reverse',
    bold_current: 'bold cyan',
    chrome_collapse: 'yellow',
    chrome_expand:   'green',
    chrome_close:    'red',
    chrome_trigger:  'bold blue',
  },

  // Minimal — white borders, no color
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
  },
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

module.exports = { setTheme, theme, activeThemeName, themeNames, THEMES, DEFAULT_THEME };
