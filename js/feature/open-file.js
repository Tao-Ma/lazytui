/**
 * Open a host filesystem path as a read-only content tab in the detail panel.
 *
 * Shared between the files Component's Enter-on-file flow and the `:open`
 * cmdline verb. Handles the HOST-path case only — files.js still owns the
 * docker-container / declared-registry variants of _openFileAsTab because
 * those need panel-config context (panel.container, panel.source). Phase C
 * of the open-target arc will fold those back through the scheme registry.
 *
 * Also registers the HOST scheme on the open-target registry (the catch-all
 * fallback): anything without a `<word>://` prefix is routed here.
 *
 * Async file load: an immediate `[dim]Loading…[/]` content tab is added so
 * the user gets feedback under their cursor; the resolved lines slot in via
 * `updateContentTabLines` once `loadFile` resolves (or with a `[red]Failed
 * to load[/]` blurb on error). The group is captured at call time so a
 * mid-flight group switch doesn't misfile the resolved content (T27 — same
 * trap the files Component fixed via originGroup).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { addContentTab, updateContentTabLines } = require('../panel/viewer/tabs');
const { loadFile, DEFAULT_MAX_BYTES, DEFAULT_HEX_AFTER } = require('../io/file-loader');
const { esc } = require('../io/ansi');
const { getModel } = require('../model/store');
const openTarget = require('./open-target');

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//;

/**
 * Open `filepath` as a content tab in the current group.
 *
 *   filepath  string — absolute or relative (resolved against projectDir).
 *   opts      { label?, maxBytes?, hexAfter? } — defaults from file-loader.
 */
function openHostFileAsTab(filepath, opts = {}) {
  const base = getModel().projectDir || process.cwd();
  const absPath = path.isAbsolute(filepath) ? filepath : path.resolve(base, filepath);
  const key = `file:${absPath}`;
  const label = opts.label || path.basename(absPath);
  const originGroup = getModel().currentGroup;
  const loadingLabel = `[dim]Loading ${esc(absPath)}…[/]`;
  addContentTab(originGroup, key, label, [loadingLabel]);

  const loadOpts = {
    maxBytes: opts.maxBytes || DEFAULT_MAX_BYTES,
    hexAfter: opts.hexAfter || DEFAULT_HEX_AFTER,
  };
  loadFile(absPath, loadOpts).then(result => {
    updateContentTabLines(originGroup, key, result.lines);
    require('../leaves/render-queue').scheduleRender();
  }).catch(err => {
    updateContentTabLines(originGroup, key, [
      '[red]Failed to load:[/]', '', `[dim]${esc(err.message)}[/]`,
    ]);
    require('../leaves/render-queue').scheduleRender();
  });
}

/**
 * Path completion for the host filesystem. Returns render-safe match
 * entries the cmdline drops into its dropdown.
 *
 *   - Empty input or trailing `/` → list everything in that dir
 *   - Otherwise → list entries in dirname(input) whose name starts with
 *     basename(input) (case-insensitive)
 *
 * Display string is the full command line replacement (`open <path>`) so
 * the Tab handler can swap it into the buffer wholesale; the entries
 * carry `argComplete: true` so the cmdline knows to use replace-buffer
 * semantics rather than the default command-name rewrite.
 */
function hostComplete(input) {
  const base = getModel().projectDir || process.cwd();
  let dir, prefix;
  if (!input || input.endsWith('/')) {
    const absInput = !input ? base : (path.isAbsolute(input) ? input : path.resolve(base, input));
    dir = absInput;
    prefix = '';
  } else {
    const absInput = path.isAbsolute(input) ? input : path.resolve(base, input);
    dir = path.dirname(absInput);
    prefix = path.basename(absInput);
  }

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }

  const lcPrefix = prefix.toLowerCase();
  return entries
    .filter(e => e.name.toLowerCase().startsWith(lcPrefix))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map(e => {
      const fullPath = path.join(dir, e.name);
      // Render the path the same way the user typed (relative if input was
      // relative, absolute if they typed absolute). Cleaner UX than
      // forcing all completions to be absolute.
      const displayPath = path.isAbsolute(input) || (input && input.startsWith('/'))
        ? fullPath
        : path.relative(base, fullPath) || e.name;
      const suffix = e.isDirectory() ? '/' : '';
      const shown = displayPath + suffix;
      return {
        display: `open ${shown}`,
        desc: e.isDirectory() ? '[dir]' : '[file]',
        kind: 'path',
        argComplete: true,
        // Directories are refine-only: Enter behaves like Tab (descend).
        // Files have a meaningful Enter (open the file).
        refine: e.isDirectory(),
        run: () => {
          if (!e.isDirectory()) openHostFileAsTab(shown);
        },
      };
    });
}

// Host scheme — the catch-all. Registered LAST so specific schemes (docker,
// ssh, …) register first and claim their prefixes before host's match()
// sees the input. Specific schemes register at their own module load.
openTarget.registerOpenScheme('host', {
  match: input => SCHEME_PREFIX.test(input) ? null : (input || ''),
  complete: hostComplete,
  open: (target, opts) => openHostFileAsTab(target, opts),
});

module.exports = { openHostFileAsTab, hostComplete };
