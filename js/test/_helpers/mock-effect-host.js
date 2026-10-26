/**
 * Shared mock effect-host for choices_fn / choices_cmd runtime tests
 * (and any future effect that follows the same registration shape).
 *
 * Factored from identical implementations in test-choices-fn-runtime.js
 * and test-choices-cmd-runtime.js so the two don't drift. Shape:
 *
 *   const { dispatched, released, host } = makeEffectHost();
 *   handler({...effect payload...}, host);
 *   // host.applyMsg pushes to `dispatched`
 *   // host.releaseKey pushes to `released`
 *
 * Pass `{signal}` for abort-flow tests (pre-aborted or AbortController).
 * The default is `null` for cmd-style hosts; fn-style wants
 * `{aborted:false}` because its code path reads `.aborted` without a
 * null-check. Caller picks which they need.
 */
'use strict';

/**
 * @param {object} [opts]
 * @param {AbortSignal|{aborted:boolean}|null} [opts.signal] — defaults to null
 *   (SIGTERM-style — effect code null-checks). Pass `{aborted:false}` or a
 *   real AbortController's `.signal` for abort-flow tests.
 */
function makeEffectHost(opts) {
  opts = opts || {};
  const dispatched = [];
  const released = [];
  return {
    dispatched,
    released,
    host: {
      applyMsg: (m) => dispatched.push(m),
      releaseKey: () => released.push(true),
      signal: opts.signal === undefined ? null : opts.signal,
    },
  };
}

module.exports = { makeEffectHost };
