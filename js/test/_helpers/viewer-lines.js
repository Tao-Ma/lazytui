/**
 * Derived displayed-lines helper for tests.
 *
 * U2f — every content-slot instance (info / text-view / transcript) stores its
 * displayed buffer on `slice.lines` directly, so this is now a thin accessor. The
 * former flat-strip derivation (via the deleted pane-tabs.viewerLines, over
 * infoLines / viewerStreamBuffer / contentTabs / viewerOverride) is gone.
 */
'use strict';

function displayedLines(slice) {
  return (slice && Array.isArray(slice.lines)) ? slice.lines : [];
}

module.exports = { displayedLines };
