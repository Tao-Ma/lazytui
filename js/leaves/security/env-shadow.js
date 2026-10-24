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
 * Pure leaf: no io, no model, data only. See the long comment in
 * `js/dispatch/runtime/action-runner.js:_envWithShadowGuard` for per-name
 * rationale and the shellshock-class `BASH_FUNC_*` prefix handling.
 */
'use strict';

const ENV_SHADOW_DENY = new Set([
  'PATH', 'SHELL',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FORCE_FLAT_NAMESPACE',
  'BASH_ENV', 'ENV',
]);

/** True iff `name` is a shadow-sensitive env var (literal match OR
 *  `BASH_FUNC_<anything>` for the shellshock exported-function class). */
function isShadowedEnvName(name) {
  return ENV_SHADOW_DENY.has(name) || (typeof name === 'string' && name.startsWith('BASH_FUNC_'));
}

module.exports = { ENV_SHADOW_DENY, isShadowedEnvName };
