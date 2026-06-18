/**
 * Theme selection is MODEL state; the palette is a RENDER-TIME projection (#D8).
 *
 * `model.theme` is the single source of truth. A `set_theme` Msg updates it —
 * and that's ALL it does (no Cmd, no effect). The palette cache the pure render
 * leaves read (`leaves/infra/themes.theme()`) is projected from `model.theme` at
 * the render entry (`paint.js render(model) → themes.setTheme(model.theme)`),
 * a per-frame derivation — the same shape as `now = model.now` driving the frame
 * clock. So the frame is replay-safe of the theme: replaying the Msg log
 * reconstructs `model.theme`, and the next render reproduces the palette.
 *
 * (Before #D8 the cache was synced by a `set_theme` EFFECT, which replay skips —
 * so a replayed frame lost the theme. That effect + Cmd are retired.)
 *
 * This pins:
 *   - set_theme updates model.theme (and nothing else — no effect-sync),
 *   - render's projection lands the palette on THEMES[model.theme],
 *   - re-applying the current theme is an identity-preserving no-op,
 *   - restore (the preview-undo path) flows through the Msg + reprojects.
 *
 * Run: node js/test/test-theme-model.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../model/store');
require('../dispatch/runtime/effects').installBuiltins();
const dispatch = require('../dispatch/control/dispatch');
const themes = require('../leaves/infra/themes');

const names = themes.themeNames();
const A = getModel().theme;                         // current
const B = names.find(n => n !== A) || names[0];     // a different one

// What paint.js render(model) does at frame entry — project model.theme onto
// the palette cache. Calling it here simulates a frame without the heavy paint.
const frameSync = () => themes.setTheme(getModel().theme);

describe('[set_theme] model.theme is the source; palette is a render-time projection (#D8)', () => {
  it('init seeds model.theme to the leaf default', () => {
    eq(typeof A, 'string');
    assert(names.includes(A), `seeded theme ${A} is a real theme`);
  });

  it('set_theme updates model.theme', () => {
    dispatch.applyMsg({ type: 'set_theme', name: B });
    eq(getModel().theme, B, 'model.theme committed');
  });

  it('the Msg alone does NOT sync the palette — render projects it (replay-safe)', () => {
    themes.setTheme(A);                          // palette = A (a known stale state)
    dispatch.applyMsg({ type: 'set_theme', name: B });
    eq(getModel().theme, B, 'model.theme = B');
    // No set_theme effect anymore: the dispatch did not touch the palette.
    eq(themes.theme(), themes.THEMES[A], 'palette still A — the Msg does not sync it');
    frameSync();                                 // render(model) projects model.theme
    eq(themes.theme(), themes.THEMES[B], 'after render: palette === THEMES[model.theme]');
  });

  it('re-applying the current theme is an identity-preserving no-op', () => {
    const before = getModel();
    dispatch.applyMsg({ type: 'set_theme', name: B });
    assert(getModel() === before, 'no model churn when theme unchanged');
  });

  it('restore (preview-undo path) flows through the Msg + reprojects', () => {
    dispatch.applyMsg({ type: 'set_theme', name: A });
    eq(getModel().theme, A, 'model.theme restored');
    frameSync();
    eq(themes.theme(), themes.THEMES[A], 'palette reprojected to A in lockstep');
  });
});

report();
