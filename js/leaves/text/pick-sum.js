/**
 * PICK_SUM — a POSIX shell snippet that selects a sha256 tool at
 * runtime so the same script works on macOS (`shasum -a 256`) and
 * Linux (`sha256sum`) without per-host config.
 *
 * Shared leaf used by every synthesized action that writes/validates
 * `.sha256` sidecars (feature/archive.js, feature/image-backup.js).
 * Zero deps, no dynamic parts — a plain constant string.
 *
 * Usage: emit PICK_SUM near the top of the generated script, then
 * reference `$SUM` wherever a checksum command is needed:
 *
 *   script: [
 *     'set -e',
 *     PICK_SUM,
 *     '$SUM "$f" > "$f.sha256"',
 *   ].join('\n');
 */
'use strict';

const PICK_SUM =
  "if command -v sha256sum >/dev/null 2>&1; then SUM='sha256sum'; " +
  "else SUM='shasum -a 256'; fi";

module.exports = { PICK_SUM };
