/**
 * State-transition resets (T4) — group switch and detail-content swap
 * must not leak transient detail state (visual selection, cursor,
 * committed search) from the outgoing content into the new content.
 *
 * Run: node js/test/test-state-resets.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const { resetGroupContext, setViewerContent } = require('../app/state');
const runtime = require('../app/runtime');
const { getModel } = runtime;
const api = require('../panel/api');
const { getInstanceSlice } = api;
const route = require('../panel/route');

// U2e P1b — register the content-slot Component siblings + boot a SEEDED content
// slot (parser + initState) so route.resolveTarget('viewer') resolves to a real
// mounted instance (the setViewerContent / viewer_reset_chrome destination).
api.registerComponent(require('../panel/info/info'));
api.registerComponent(require('../panel/text-view/text-view'));
function seedContentSlot() {
  const { parse } = require('../parser/index');
  const { initState } = require('../app/state');
  const m = getModel();
  m.config = parse(require('path').resolve(__dirname, '../../test/test.yml'));
  m.projectDir = '.';
  initState();
}

describe('[1] resetGroupContext drops ROOT chrome state', () => {
  it('clears list-select + per-panel filters/multi-sel (root layer)', () => {
    // Set up via the reducer rather than poking model.modes directly —
    // tests post-Phase 4 should mirror the production write path.
    const dispatch = require('../dispatch/control/dispatch');
    dispatch.applyMsg({ type: 'list_select', mode: 'on' });
    eq(getModel().modes.listSelectMode, true, 'precondition: mode armed');
    resetGroupContext();
    eq(getModel().modes.listSelectMode, false, 'list-select mode cleared');
  });
});

describe('[2] viewer_reset_chrome clears the active content instance transient state', () => {
  it('tvu-handled on the content instance: clears selection + parks the cursor', () => {
    // U2e P1b — the group-change reset now dispatches viewer_reset_chrome to the
    // content slot's ACTIVE instance (resolveTarget('viewer') → info/text-view),
    // handled by the SHARED leaves/text/text-view-update (tvu). The retired
    // fields (tab index, viewerOverride) and the `[≡]` menu-close were hoisted
    // OUT of this arm into the dispatch funnel (app/state.js#resetGroupContext
    // emits a separate pane_menu_close) — so the per-content arm now clears ONLY
    // the visual selection + cursor. Drive the text-view Component's update
    // (a content instance) directly with an isolated slice.
    const tv = require('../panel/text-view/text-view');
    const init = tv.init();
    const slice = {
      ...init,
      lines: ['a', 'b', 'c', 'd', 'e', 'f'],
      select: { active: true, kind: 'char', anchor: { line: 2, col: 1 }, cursor: { line: 3, col: 0 } },
      cursor: { line: 5, col: 2 },
    };
    const r = tv.update({ type: 'viewer_reset_chrome' }, slice);
    eq(r.select.active, false, 'visual selection cleared');
    eq(r.cursor.line, 0, 'cursor line reset');
    eq(r.cursor.col, 0, 'cursor col reset');
  });
});

describe('[3] setViewerContent shows a discrete doc as a text-view tab (U2e P4)', () => {
  // U2e P4 — setViewerContent no longer writes the detail viewer's viewerOverride
  // (retired). It mints a `text-view` content tab (poolId `content-<opts.key>`) and
  // replaces its lines, reusing the tab on re-invoke. This is the shared entry for
  // help / config-status diff / history replay.
  const mpane = require('../leaves/wm/pane');
  function docTabLines(key) {
    const inst = route.getInstance(mpane.newPaneId('content-' + key));
    return inst ? inst.slice.lines : null;
  }

  it('mints a text-view tab with the given content, active', () => {
    seedContentSlot();
    setViewerContent(null, 'brand new\ncontent here', { key: 'doc3', label: 'Doc' });
    const slotPaneId = route.resolveViewerPaneId();
    const pane = require('../leaves/wm/pool').findPaneLocation(
      getInstanceSlice('layout').arrange, p => p.paneId === slotPaneId).pane;
    eq(pane.activeTabId, 'content-doc3', 'the doc tab is active');
    eq((docTabLines('doc3') || []).join('|'), 'brand new|content here', 'lines seeded');
  });
  it('reuses the same tab and replaces content on re-invoke', () => {
    seedContentSlot();
    setViewerContent(null, 'first', { key: 'doc3b', label: 'Doc' });
    setViewerContent(null, 'second\nthird', { key: 'doc3b', label: 'Doc' });
    eq((docTabLines('doc3b') || []).join('|'), 'second|third', 'content replaced in place');
  });
});

report();
