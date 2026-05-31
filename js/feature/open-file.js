/**
 * Open a host filesystem path as a read-only content tab in the detail panel.
 *
 * Shared between the files Component's Enter-on-file flow and the `:open`
 * cmdline verb. Handles the HOST-path case only — files.js still owns the
 * docker-container / declared-registry variants of _openFileAsTab because
 * those need panel-config context (panel.container, panel.source).
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
const { addContentTab, updateContentTabLines } = require('../panel/viewer/tabs');
const { loadFile, DEFAULT_MAX_BYTES, DEFAULT_HEX_AFTER } = require('../io/file-loader');
const { esc } = require('../io/ansi');
const { getModel } = require('../app/runtime');

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
    require('../render/render-queue').scheduleRender();
  }).catch(err => {
    updateContentTabLines(originGroup, key, [
      '[red]Failed to load:[/]', '', `[dim]${esc(err.message)}[/]`,
    ]);
    require('../render/render-queue').scheduleRender();
  });
}

module.exports = { openHostFileAsTab };
