/**
 * Derived displayed-lines helper for tests.
 *
 * P3 (viewer-lines selector arc) — `slice.lines` is deleted; the
 * viewer's displayed lines DERIVE from the active tab's canonical home
 * (infoLines / viewerStreamBuffer / actionTabBuffers / contentTabs /
 * viewerOverride) via pane-tabs.viewerLines. Tests that used to assert
 * the stored mirror assert this derivation instead — the same
 * projection production render/arms consume.
 */
'use strict';

const pt = require('../../leaves/wm/pane-tabs');
const { getModel } = require('../../app/runtime');

function displayedLines(slice, model) {
  // U2e P1b — the content slot's active instance (info / text-view / transcript)
  // stores its buffer on `slice.lines` directly; prefer it. Fall back to the
  // viewer's flat-strip derivation for a legacy/detail-shaped slice.
  if (slice && Array.isArray(slice.lines)) return slice.lines;
  const m = model || getModel();
  return pt.viewerLines(slice, m, m.currentGroup);
}

module.exports = { displayedLines };
