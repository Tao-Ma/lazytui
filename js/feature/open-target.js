/**
 * Pluggable open-target scheme registry.
 *
 * `:open <input>` (and any future caller) routes through here. Each scheme
 * declares three hooks:
 *
 *   match(input)         — returns a target (any non-null value) if this
 *                          scheme claims the input; null otherwise.
 *   complete(input)      — returns an array of render-safe match entries
 *                          ({display, desc, kind, argComplete:true, run})
 *                          shown in the cmdline dropdown for path
 *                          completion. Optional.
 *   open(target, opts)   — opens the parsed target as a content tab.
 *
 * Scheme dispatch is first-match-wins, in registration order. The host
 * scheme (registered by feature/open-file.js) is the catch-all — its
 * match() claims anything without a `scheme://` prefix. Specific schemes
 * (docker, ssh, s3 — future) register first.
 *
 * URI-style prefix: `<scheme>://<context>/<path>` (e.g. `docker://api/etc/foo`).
 * The `://` is the disambiguator from relative host paths.
 */
'use strict';

const _schemes = [];

function registerOpenScheme(name, hooks) {
  if (!hooks || typeof hooks.match !== 'function') {
    console.error(`[open-target] scheme '${name}' missing required match()`);
    return;
  }
  _schemes.push({ name, ...hooks });
}

function _findScheme(input) {
  for (const s of _schemes) {
    const t = s.match(input);
    if (t != null) return { scheme: s, target: t };
  }
  return null;
}

/** First scheme to claim `input`, with its parsed target — or null. */
function parseTarget(input) {
  return _findScheme(input);
}

/** Completion candidates for `input`, routed to the claiming scheme.
 *  Returns [] when no scheme claims or the claiming scheme has no
 *  complete() hook.
 *
 *  Discoverability: when `input` is empty (no scheme prefix typed yet),
 *  also inject `hintEntry()` from EVERY OTHER scheme so the user sees
 *  `docker://` (etc.) as an option alongside host paths. Once the user
 *  has typed something, hints are dropped — they're committed to a
 *  scheme. */
function complete(input) {
  const m = _findScheme(input);
  if (!m || typeof m.scheme.complete !== 'function') return [];
  const main = m.scheme.complete(input) || [];
  if (!input || !input.trim()) {
    // Prepend hints so they're visible in the dropdown's first
    // MAX_DROPDOWN slots. Default selection skips hints (runtime.js
    // cmdline_set_matches) so Enter still lands on the first real
    // completion. Placing hints at the FRONT (rendered bottom-of-
    // dropdown by overlay/cmdline.js's reverse-iterate) puts them
    // closest to the user's eye + the prompt.
    const hints = [];
    for (const s of _schemes) {
      if (s === m.scheme) continue;
      if (typeof s.hintEntry === 'function') {
        const h = s.hintEntry();
        if (h) hints.push(h);
      }
    }
    return hints.concat(main);
  }
  return main;
}

/** Open `input` via the claiming scheme. Silently no-ops if nothing
 *  claims; schemes are expected to surface their own errors as content-
 *  tab contents (consistent with file-loader's failure mode). */
function openInput(input, opts) {
  const m = _findScheme(input);
  if (!m || typeof m.scheme.open !== 'function') return;
  m.scheme.open(m.target, opts || {});
}

/** Test-only: clear the scheme registry between cases. */
function _resetSchemes() { _schemes.length = 0; }

/** Read access for telemetry / debug. */
function _schemeNames() { return _schemes.map(s => s.name); }

module.exports = { registerOpenScheme, parseTarget, complete, openInput, _resetSchemes, _schemeNames };
