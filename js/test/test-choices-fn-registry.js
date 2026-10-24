/**
 * `choices_fn` plumbing (args→ports slice 2, commit 1): the dotted-ref registry
 * that resolves a YAML port's `choices_fn: "<component>.<name>"` to the fn a
 * component (or feature plugin) shipped. The runtime handler + reducer arms
 * land in later commits; this file pins the registration surface only.
 *
 * Covers:
 *   1. `registerChoicesFn('edit', { sections_of })` makes `getChoicesFn('edit.sections_of')`
 *      resolve to that fn.
 *   2. `getChoicesFn('nope.missing')` is null — the invariant the runtime relies
 *      on for its "unknown ref" error path (feedback_backcompat_on_new_validations).
 *   3. A re-registration under the same ref last-writes-wins (re-boot / replay).
 *   4. A feature plugin with `choicesFns:` registered via
 *      `registerGroupActionPlugin` ALSO exposes its fns under the plugin's name —
 *      so the two contributor shapes (Component + feature plugin) stay unified
 *      ([[feedback_fix_the_class_not_the_instance]] applied prospectively).
 *   5. Bad inputs are no-ops (missing name, non-function value, non-object fns
 *      map) — defense-in-depth against hand-built plugin modules.
 *
 * Run: node js/test/test-choices-fn-registry.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const api = require('../panel/api');

describe('[choices-fn-registry] registerChoicesFn + getChoicesFn', () => {
  it('register + lookup round-trip', () => {
    api.__resetChoicesFns();
    const fn = () => ['a', 'b'];
    api.registerChoicesFn('edit', { sections_of: fn });
    eq(api.getChoicesFn('edit.sections_of'), fn, 'exact fn identity returned');
  });

  it('unknown ref returns null', () => {
    api.__resetChoicesFns();
    eq(api.getChoicesFn('nope.missing'), null, 'null for unregistered ref');
    eq(api.getChoicesFn(''), null, 'null for empty ref');
    eq(api.getChoicesFn(null), null, 'null for null ref');
    eq(api.getChoicesFn(42), null, 'null for non-string ref');
  });

  it('re-registration is last-write-wins', () => {
    api.__resetChoicesFns();
    const first = () => ['a'];
    const second = () => ['b'];
    api.registerChoicesFn('edit', { sections_of: first });
    api.registerChoicesFn('edit', { sections_of: second });
    eq(api.getChoicesFn('edit.sections_of'), second, 'second registration overwrites first');
  });

  it('bad inputs are no-ops', () => {
    api.__resetChoicesFns();
    api.registerChoicesFn('', { foo: () => [] });
    eq(api.getChoicesFn('.foo'), null, 'empty component name — nothing registered');
    api.registerChoicesFn('mod', null);
    api.registerChoicesFn('mod', 'not-an-object');
    api.registerChoicesFn('mod', { bad: 'not-a-function' });
    api.registerChoicesFn('mod', { '': () => [] });
    eq(api.getChoicesFn('mod.bad'), null, 'non-function value dropped');
    eq(api.getChoicesFn('mod.'), null, 'empty fn name dropped');
  });

  it('feature plugin choicesFns registered via registerGroupActionPlugin', () => {
    api.__resetChoicesFns();
    const fn = async () => ['x', 'y'];
    const plugin = {
      name: 'mock-feature',
      groupActions: () => ({}),
      choicesFns: { enumerate: fn },
    };
    api.registerGroupActionPlugin(plugin);
    eq(api.getChoicesFn('mock-feature.enumerate'), fn,
       'feature-plugin choicesFns resolve under the plugin name');
  });
});

report();
