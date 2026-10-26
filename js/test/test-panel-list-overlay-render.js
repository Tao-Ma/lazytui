/**
 * Render-capture tests for the panel-list overlay (`js/overlay/panel-list.js`).
 *
 * The reducer / items-derivation surface is covered by test-panel-list-overlay.js;
 * this file closes the paint gap per [[feedback_render_test_new_overlays]].
 *
 * Panel-list reads from the layout Component's slice (`slice.panelList.open`
 * + `slice.arrange`), not a flat `model.modal.*` state, so this test uses
 * the smoke bootFresh pattern (full layout mint via initState) instead of
 * the simple _helpers/overlay-capture freshOverlayModel.
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const api = require('../panel/api');
const { dispatchMsg } = require('../dispatch/runtime/loop');
const { renderPanelListOverlay } = require('../overlay/panel-list');

// The overlay reads via api.getInstanceSlice('layout'); we open panel-list by
// dispatching the layout-ns Msg through the real pipeline so slice.arrange is
// seeded properly (which panelListItems walks).
function openPanelListOverSmoke() {
  sm.bootFresh();
  sm.resize(140, 40);                                    // wide: side-by-side layout branch
  // Component-ns Msgs route through dispatchMsg + api.wrap, NOT applyMsg
  // (applyMsg is the top-level non-Component path).
  dispatchMsg(api.wrap('layout', { type: 'panel_list_open' }));
}

describe('[panel-list-overlay] paints iff slice.panelList.open', () => {
  it('open=false → zero bytes written', () => {
    sm.bootFresh();
    const out = sm.capture(() => renderPanelListOverlay()).raw;
    assert(out === '', `expected no output when panelList closed, got ${JSON.stringify(out).slice(0, 200)}`);
  });

  it('open=true → "Panels" title + at least one item visible', () => {
    openPanelListOverSmoke();
    const cap = sm.capture(() => renderPanelListOverlay());
    const frame = cap.frame;
    assert(frame.includes('Panels'), `title absent — got: ${JSON.stringify(frame).slice(0, 300)}`);
    // The smoke default-config layout has at least `groups` + `detail` panels;
    // detail is always-present. Pin on detail — portable across layout tweaks.
    assert(/detail/i.test(frame), `expected 'detail' row — got: ${JSON.stringify(frame).slice(0, 300)}`);
  });

  it('close → paints nothing (slice.panelList.open flips to false)', () => {
    openPanelListOverSmoke();
    dispatchMsg(api.wrap('layout', { type: 'panel_list_close' }));
    const out = sm.capture(() => renderPanelListOverlay()).raw;
    assert(out === '', `after close: no overlay, got: ${JSON.stringify(out).slice(0, 200)}`);
  });

  it('narrow terminal (< MIN_SIDE_BY_SIDE=75) falls back to list-only', () => {
    sm.bootFresh();
    sm.resize(70, 30);                                   // below MIN_SIDE_BY_SIDE
    dispatchMsg(api.wrap('layout', { type: 'panel_list_open' }));
    const cap = sm.capture(() => renderPanelListOverlay());
    const frame = cap.frame;
    assert(frame.includes('Panels'), `title absent in list-only mode — got: ${JSON.stringify(frame).slice(0, 300)}`);
    // The side-by-side branch would include a preview sub-pane that lists a
    // 'column:' label from the preview renderer; list-only drops it.
    assert(!/column:/i.test(frame), `narrow mode should drop side-by-side preview — got: ${JSON.stringify(frame).slice(0, 300)}`);
  });
});

report();
