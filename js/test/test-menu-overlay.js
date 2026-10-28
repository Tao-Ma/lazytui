/**
 * Render-capture tests for the menu overlay (`js/overlay/menu.js`).
 *
 * The menu overlay backs TWO user-facing surfaces: the global command list
 * (keyboard `x`) and the right-click context menu — the latter has reducer
 * tests in test-context-menu.js but neither surface had a paint test. This
 * file pins that items + title + selection highlight actually render when
 * menuOpen is on, closing the gap per [[feedback_render_test_new_overlays]].
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const { freshOverlayModel, captureOverlay } = require('./_helpers/overlay-capture');
const { renderMenu } = require('../overlay/menu');

// A menu item is a [label, verb, arg?] tuple (per leaves/context-menu's
// buildContextItems shape); `null` is a visual separator row.
const ITEMS = [
  ['Open', 'open', null],
  ['Rename', 'rename', null],
  null,
  ['Delete', 'delete', null],
];

// Contract quirk: renderMenu does NOT self-gate on model.modes.menuOpen —
// unlike confirm.js / register-popup.js / fabric-field.js, the menu overlay
// trusts the caller (paint.js) to only invoke it when the mode is on. These
// tests cover the "mode on" cases; the gating is caller responsibility and
// is pinned by the paint-side pipeline, not here.

describe('[menu-overlay] paints model.modal.menu contents', () => {
  it('menuOpen on → all non-separator items visible, title defaults to "Menu"', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'menu_open', items: ITEMS });
    const out = captureOverlay(m, (nr, c) => renderMenu(nr, c));
    assert(out.includes('Open'), `Open absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('Rename'), `Rename absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('Delete'), `Delete absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('Menu'), `default title absent — got: ${JSON.stringify(out)}`);
  });

  it('msg.title override replaces the "Menu" default (right-click uses "Actions")', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'menu_open', items: ITEMS, title: 'Actions' });
    const out = captureOverlay(m, (nr, c) => renderMenu(nr, c));
    assert(out.includes('Actions'), `custom title absent — got: ${JSON.stringify(out)}`);
    // Nothing in the sample items is called "Menu" so a leaked default would show.
    assert(!/\bMenu\b/.test(out), `default title leaked past override — got: ${JSON.stringify(out)}`);
  });

  it('menu_nav moves selection — nav past a null separator jumps to the next real row', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'menu_open', items: ITEMS });
    [m] = runtime.update(m, { type: 'menu_nav', dir: +1 });   // Open → Rename
    [m] = runtime.update(m, { type: 'menu_nav', dir: +1 });   // Rename → Delete (skips null)
    // No render assertion on the specific SGR; renderOverlay's exact markup
    // isn't the point. We assert on reducer-visible state via the painted
    // text + the count stripe (count: [selPos, selCount] → "3/3").
    const out = captureOverlay(m, (nr, c) => renderMenu(nr, c));
    assert(/3\s*\/\s*3|3 of 3|3\/3/.test(out), `expected 3/3 count stripe for 3rd selectable row, got: ${JSON.stringify(out)}`);
  });

  it('menu_close clears items in the slice (caller stops calling renderMenu)', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'menu_open', items: ITEMS });
    [m] = runtime.update(m, { type: 'menu_close' });
    // The reducer wipes items on close so if a stale caller somehow invokes
    // renderMenu post-close, it paints an empty title-only box, not stale rows.
    const out = captureOverlay(m, (nr, c) => renderMenu(nr, c));
    assert(!out.includes('Delete'), `post-close call still paints stale items — got: ${JSON.stringify(out)}`);
    assert(!out.includes('Open'), `post-close call still paints stale items — got: ${JSON.stringify(out)}`);
  });

  it('literal `[` in an item label stays visible (markup-safe esc)', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, {
      type: 'menu_open',
      items: [['Copy [selection]', 'copy', null]],
    });
    const out = captureOverlay(m, (nr, c) => renderMenu(nr, c));
    assert(out.includes('[selection]'), `literal brackets consumed by markup — got: ${JSON.stringify(out)}`);
  });
});

report();
