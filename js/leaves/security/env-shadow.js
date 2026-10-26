/**
 * Env-shadow denylist — shared between the parser (reject at load) and the
 * action-runner (refuse at spawn). Both callers converged on the same set
 * during the slice-1 args→ports pre-release review (round 2 + round 4).
 *
 * These env vars substantively change WHICH binary runs, WHICH libraries load,
 * or WHICH code runs BEFORE the script does, so a port VALUE binding one of
 * them into the child env is a hijack class worth defending against — even
 * though the YAML author already has a `script:` field (a bigger weapon). The
 * defense closes the "user types into the invoke-time popup" surface AND the
 * "CLI --exec passes a positional arg" surface uniformly.
 *
 * Members by class:
 *   OS loader / shell startup (slice-1 scope):
 *     PATH, SHELL                                    — which binary runs
 *     LD_PRELOAD / LD_LIBRARY_PATH / LD_AUDIT        — glibc dynamic loader
 *     DYLD_INSERT_LIBRARIES / DYLD_LIBRARY_PATH /
 *       DYLD_FORCE_FLAT_NAMESPACE                    — macOS dyld
 *     BASH_ENV / ENV                                 — sh/bash startup files
 *     BASH_FUNC_<anything>                           — shellshock exported-fn
 *   Interpreter injection (post slice-1, same class one layer up — a port
 *   value under one of these names makes `python3 -c '…'` / `node -e '…'` /
 *   `perl -e '…'` / `ruby -e '…'` / `lua -e '…'` / any java tool execute
 *   attacker code BEFORE the script body runs, via the interpreter's own
 *   startup hooks):
 *     NODE_OPTIONS, NODE_PATH, NODE_REPL_EXTERNAL_MODULE
 *     PYTHONPATH, PYTHONSTARTUP, PYTHONHOME
 *     PERL5LIB, PERL5OPT, PERL5DB
 *     RUBYOPT, RUBYLIB
 *     LUA_PATH, LUA_CPATH, LUA_INIT
 *     JAVA_TOOL_OPTIONS, _JAVA_OPTIONS, JDK_JAVA_OPTIONS
 *   Git exec-class (scripts commonly shell out to git; these are invoked as
 *   commands, so a value is a command injection):
 *     GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF
 *
 * Deliberately NOT members (decision, not omission):
 *   PAGER / EDITOR / GIT_PAGER — only fire on interactive invocations that an
 *     action script shouldn't be making; refusing them would annoy legitimate
 *     ports like a "pager" option without closing a hijack class.
 *   GODEBUG and other runtime-tuning vars (NODE_TLS_REJECT_UNAUTHORIZED,
 *     PYTHONUNBUFFERED, etc.) — change runtime behavior but do not execute
 *     attacker-controlled code. Out of scope for env-shadow; a different
 *     defense would be needed if we ever care.
 *
 * Port names are case-sensitive identifiers, so lowercase homographs like
 * `path`, `node`, `pythonpath` stay legal — only exact-name shadows are
 * refused. Rename an offending port to its lowercase form to silence the
 * warning.
 *
 * Not applicable to `variadic: true` input ports (Brief 3): their items go
 * into the shell spawn's argv tail as `$@`, never into the child env — so a
 * variadic port named `PATH` is still a bad idea, but not for env-shadow
 * reasons; the parser's existing `port.env_shadow` warning fires on the
 * NAME either way. See docs/ports-and-wires.md "Variadic input ports".
 *
 * Pure leaf: no io, no model, data only. See the long comment in
 * `js/dispatch/runtime/action-runner.js:_envWithShadowGuard` for the matching
 * per-class rationale on the spawn side.
 */
'use strict';

const ENV_SHADOW_DENY = new Set([
  // OS loader / shell startup
  'PATH', 'SHELL',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FORCE_FLAT_NAMESPACE',
  'BASH_ENV', 'ENV',
  // Interpreter injection
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
  'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME',
  'PERL5LIB', 'PERL5OPT', 'PERL5DB',
  'RUBYOPT', 'RUBYLIB',
  'LUA_PATH', 'LUA_CPATH', 'LUA_INIT',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  // Git exec-class
  'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF',
]);

/** True iff `name` is a shadow-sensitive env var (literal match OR
 *  `BASH_FUNC_<anything>` for the shellshock exported-function class). */
function isShadowedEnvName(name) {
  return ENV_SHADOW_DENY.has(name) || (typeof name === 'string' && name.startsWith('BASH_FUNC_'));
}

module.exports = { ENV_SHADOW_DENY, isShadowedEnvName };
