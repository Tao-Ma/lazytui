/**
 * Render-capture tests for the register-popup overlay (`js/overlay/register-popup.js`).
 *
 * The register-popup had deep reducer coverage (test-register-popup.js —
 * open/nav/drop/promote mechanics) but ZERO render-capture — a mode
 * flipped but nothing painted would stay green. This file closes that
 * gap per [[feedback_render_test_new_overlays]].
 *
 * Driven via the real reducer + overlay render(), with stdout captured
 * through _helpers/overlay-capture. Mirrors test-fabric-field-overlay.js's
 * shape.
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const { freshOverlayModel, captureOverlay } = require('./_helpers/overlay-capture');
const { render: renderRegisterPopup } = require('../overlay/register-popup');

function freshWithHistory(entries) {
  const m = freshOverlayModel();
  m.register = { history: (entries || []).slice(), cap: 10 };
  return m;
}

describe('[register-popup-overlay] paints iff registerPopupMode is on', () => {
  it('mode off → zero bytes written', () => {
    const out = captureOverlay(freshOverlayModel(), (nr, c) => renderRegisterPopup(nr, c));
    assert(out === '', `expected no output when mode is off, got ${JSON.stringify(out)}`);
  });

  it('mode on, empty history → empty-state line + footer', () => {
    let m = freshWithHistory([]);
    [m] = runtime.update(m, { type: 'register_popup_enter' });
    const out = captureOverlay(m, (nr, c) => renderRegisterPopup(nr, c));
    assert(out.includes('empty register'), `empty-state message absent — got: ${JSON.stringify(out)}`);
    assert(/Enter promote/.test(out), `footer hint absent — got: ${JSON.stringify(out)}`);
    assert(/Register history \(0\)/.test(out), `title absent — got: ${JSON.stringify(out)}`);
  });

  it('mode on, history populated → entries visible + title counts entries', () => {
    let m = freshWithHistory(['alpha', 'beta', 'gamma']);
    [m] = runtime.update(m, { type: 'register_popup_enter' });
    const out = captureOverlay(m, (nr, c) => renderRegisterPopup(nr, c));
    assert(out.includes('alpha'), `entry 'alpha' absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('beta'), `entry 'beta' absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('gamma'), `entry 'gamma' absent — got: ${JSON.stringify(out)}`);
    assert(/Register history \(3\)/.test(out), `title count absent — got: ${JSON.stringify(out)}`);
  });

  it('newline + tab in a yanked entry are rendered as visible glyphs (↵ + space)', () => {
    let m = freshWithHistory(['line1\nline2', 'tabbed\there']);
    [m] = runtime.update(m, { type: 'register_popup_enter' });
    const out = captureOverlay(m, (nr, c) => renderRegisterPopup(nr, c));
    assert(out.includes('↵'), `newline glyph absent — got: ${JSON.stringify(out)}`);
    // Tab becomes a plain space; harder to assert on positively since the
    // overlay has many spaces. Pin via the preceding + following chars.
    assert(out.includes('tabbed here'), `tab-replaced row absent — got: ${JSON.stringify(out)}`);
  });

  it('literal `[` in a yanked entry stays visible (markup-safe esc)', () => {
    let m = freshWithHistory(['foo [bar] baz']);
    [m] = runtime.update(m, { type: 'register_popup_enter' });
    const out = captureOverlay(m, (nr, c) => renderRegisterPopup(nr, c));
    assert(out.includes('foo [bar] baz'), `literal brackets consumed by markup — got: ${JSON.stringify(out)}`);
  });
});

report();
