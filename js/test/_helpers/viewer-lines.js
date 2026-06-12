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

const pt = require('../../leaves/pane-tabs');
const { getModel } = require('../../app/runtime');

function displayedLines(slice, model) {
  const m = model || getModel();
  return pt.viewerLines(slice, m, m.currentGroup);
}

module.exports = { displayedLines };
