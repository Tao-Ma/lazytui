/**
 * Render-capture tests for the confirm overlay (`js/overlay/confirm.js`).
 *
 * Reducer coverage of confirm_enter/accept/reject lives in test-confirm.js;
 * this file pins that the overlay actually PAINTS the message + y/n footer
 * when the mode is on. Closes the render-capture gap per [[feedback_render_test_new_overlays]].
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const { freshOverlayModel, captureOverlay } = require('./_helpers/overlay-capture');
const { renderConfirmOverlay } = require('../overlay/confirm');

describe('[confirm-overlay] paints iff confirmMode is on', () => {
  it('mode off → zero bytes written', () => {
    const out = captureOverlay(freshOverlayModel(), (nr, c) => renderConfirmOverlay(nr, c));
    assert(out === '', `expected no output when mode is off, got ${JSON.stringify(out)}`);
  });

  it('mode on → prompt + y/n footer + Confirm title', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'confirm_enter', message: 'Really delete widget?', cmd: null });
    const out = captureOverlay(m, (nr, c) => renderConfirmOverlay(nr, c));
    assert(out.includes('Really delete widget?'), `prompt absent — got: ${JSON.stringify(out)}`);
    assert(/y.*confirm/i.test(out), `y-confirm hint absent — got: ${JSON.stringify(out)}`);
    assert(/n.*cancel/i.test(out), `n-cancel hint absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('Confirm'), `title absent — got: ${JSON.stringify(out)}`);
  });

  it('multi-line prompt renders multi-line (YAML `|` style)', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, {
      type: 'confirm_enter',
      message: 'This will drop the table.\nAre you SURE?',
      cmd: null,
    });
    const out = captureOverlay(m, (nr, c) => renderConfirmOverlay(nr, c));
    assert(out.includes('This will drop the table.'), `line 1 absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('Are you SURE?'), `line 2 absent — got: ${JSON.stringify(out)}`);
  });

  it('literal `[` in a prompt stays visible (markup-safe esc)', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'confirm_enter', message: 'Delete file [important.txt]?', cmd: null });
    const out = captureOverlay(m, (nr, c) => renderConfirmOverlay(nr, c));
    assert(out.includes('[important.txt]'), `literal brackets consumed — got: ${JSON.stringify(out)}`);
  });

  it('mode off after confirm_reject → paints nothing', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'confirm_enter', message: 'Proceed?', cmd: null });
    [m] = runtime.update(m, { type: 'confirm_reject' });
    const out = captureOverlay(m, (nr, c) => renderConfirmOverlay(nr, c));
    assert(out === '', `after reject: no overlay, got: ${JSON.stringify(out)}`);
  });
});

report();
