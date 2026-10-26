/**
 * Shared "does this input-port decl expose a choices affordance?" predicate.
 *
 * Three channels today — all three count:
 *   - `choices_fn: <ref>`            (slice 2: Component-provided function)
 *   - `choices_cmd: <shell>`         (slice 3: shell command)
 *   - `choices: { items: [...] }`    (slice 3+1: literal, parser-normalized)
 *
 * The variadic port's parser forbids all three on a variadic field, so a
 * variadic port always returns false here.
 *
 * Centralizing this predicate prevents the drift that birthed Brief 1 of
 * v0.6.43: when literal `choices:` landed, action-runner.js learned the
 * new channel (`anyChoices`) but the TUI reducer's `fabric_form_choices_open`
 * guard and the dispatch.js SPACE branch kept checking only fn/cmd — so
 * a literal-only field advertised a `[N choices]` chip whose popover
 * couldn't actually open. Same CLI/TUI-drift class as the v0.6.29
 * postmortem and the motivation for [[js/leaves/ports/variadic.js]].
 *
 * Pure leaf: data-in / data-out, no I/O.
 */
'use strict';

/**
 * `pdef` is the parser-normalized input-port decl (an entry of
 * `action.ports.in`). Returns true when any choices channel is declared.
 */
function declHasChoices(pdef) {
  if (!pdef || typeof pdef !== 'object') return false;
  if (typeof pdef.choices_fn === 'string' && pdef.choices_fn) return true;
  if (typeof pdef.choices_cmd === 'string' && pdef.choices_cmd) return true;
  if (pdef.choices && typeof pdef.choices === 'object'
      && Array.isArray(pdef.choices.items)) return true;
  return false;
}

module.exports = { declHasChoices };
