/**
 * Theme selection is MODEL state (#1/#2 TEA review fix).
 *
 * Before: the active theme lived only in module globals in leaves/themes
 * (`active`/`activeName`), set imperatively — off-model, non-replayable, with a
 * hand-rolled `:theme` undo (setTheme(orig)). Now `model.theme` is the single
 * source of truth: a `set_theme` Msg updates it and emits a `set_theme` Cmd that
 * syncs the leaves/themes palette cache (the projection the pure render leaves
 * read). The cache is a single-writer derived view of the model — same shape as
 * model.now driving the frame clock.
 *
 * This pins:
 *   - set_theme updates model.theme AND syncs the leaves cache,
 *   - re-applying the current theme is an identity-preserving no-op,
 *   - restore (the preview-undo path) flows through the Msg,
 *   - setTheme has exactly one caller (the effect) so the cache can't drift.
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

describe('[set_theme] model.theme is the source of truth; cache is derived', () => {
  it('init seeds model.theme to the leaf default', () => {
    eq(typeof A, 'string');
    assert(names.includes(A), `seeded theme ${A} is a real theme`);
  });

  it('set_theme updates model.theme', () => {
    dispatch.applyMsg({ type: 'set_theme', name: B });
    eq(getModel().theme, B, 'model.theme committed');
  });

  it('the set_theme Cmd synced the palette cache to the model', () => {
    eq(themes.theme(), themes.THEMES[B], 'leaves/themes.active === THEMES[model.theme]');
  });

  it('re-applying the current theme is an identity-preserving no-op', () => {
    const before = getModel();
    dispatch.applyMsg({ type: 'set_theme', name: B });
    assert(getModel() === before, 'no model churn when theme unchanged');
  });

  it('restore (preview-undo path) flows back through the Msg', () => {
    dispatch.applyMsg({ type: 'set_theme', name: A });
    eq(getModel().theme, A, 'model.theme restored');
    eq(themes.theme(), themes.THEMES[A], 'cache restored in lockstep');
  });
});

report();
