/**
 * Single-quote-wrap an arbitrary string for safe POSIX shell embedding.
 *
 * `'…'` in POSIX shell is literal — no `$` expansion, no `` ` `` command
 * substitution, no backslash escaping. The only character that needs
 * special handling INSIDE single quotes is `'` itself: close the quote,
 * emit a literal `\'`, reopen the quote.
 *
 *   shEscape("hello")          → "'hello'"
 *   shEscape("/path/with sp")  → "'/path/with sp'"
 *   shEscape("foo'bar")        → "'foo'\\''bar'"
 *   shEscape('"; rm -rf /')    → "'\"; rm -rf /'"
 *
 * Used by feature/archive.js + feature/image-backup.js (and any future
 * groupActions producer) to interpolate config-supplied values into
 * synthesized shell scripts without trusting the schema's plain-string
 * check to catch every metacharacter. Pre-v0.6.x both producers did
 * raw `"${target}"` interpolation; a YAML `target: foo"; rm -rf /; "`
 * would execute. Now it's `target='foo"; rm -rf /; "'` — literal.
 *
 * Zero deps.
 */
'use strict';

function shEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

module.exports = { shEscape };
