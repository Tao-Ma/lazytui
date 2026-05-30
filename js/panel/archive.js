/**
 * archive plugin — generic tar+xz+sha256 backup pattern.
 *
 * A group declares:
 *
 *   archive:
 *     target: <directory-to-archive>           # required
 *     name:   <archive-base-filename>          # required
 *     output_dir: <where-to-write>             # optional, default: "."
 *
 * The plugin's `groupActions` synthesizes two actions on that group:
 *
 *   archive  → writes <output_dir>/<name>-YYYYMMDD.tar.xz plus a
 *              <archive>.sha256 sidecar in the same dir, then echoes
 *              the resulting path.
 *   verify   → takes the archive's path as a positional arg and
 *              re-validates its .sha256 sidecar.
 *              `./do <group> verify <path-to-archive>`
 *
 * Cross-platform: the synthesized scripts pick `sha256sum` (GNU) when
 * available, else fall back to `shasum -a 256` (BSD/macOS), so the same
 * action runs on dev9-env's macOS host and inside Linux containers
 * without a config switch.
 *
 * Plugin contract: this module exports only `name` and `groupActions`.
 * It deliberately has no other lifecycle hooks — keeps it loadable
 * from cli.js without booting any TUI runtime, mirroring the pattern
 * used by docker.js's groupActions for CLI parity (Phase A v2).
 *
 * If extending to multi-path archives — DO NOT introduce a bare
 * `paths: [...]` field. That recreates the two-registry duplication
 * config-branch was just refactored away from (see PRINCIPLES § 9).
 * Follow config-branch's pattern: support `source: files` (with the
 * existing `categories:` filter) so paths can be referenced from the
 * top-level `files:` registry, and keep `target:` as the legacy
 * single-path shape with a parser-side mutual-exclusion check.
 */
'use strict';

// Pick a checksum tool at runtime so the same script works on macOS
// (shasum) and Linux (sha256sum) without per-host config.
const PICK_SUM =
  "if command -v sha256sum >/dev/null 2>&1; then SUM='sha256sum'; " +
  "else SUM='shasum -a 256'; fi";

function groupActions(group) {
  if (!group || !group.archive) return {};
  const cfg = group.archive;
  const target = cfg.target;
  const name = cfg.name;
  if (typeof target !== 'string' || !target) return {};
  if (typeof name !== 'string' || !name) return {};
  const out = (typeof cfg.output_dir === 'string' && cfg.output_dir) || '.';

  // Embed config values as literal substrings — no quoting concerns
  // because schema validates them as plain strings (no shell metas
  // typical in real configs). $-vars only appear in the runtime portion.
  return {
    archive: {
      type: 'run',
      label: 'Archive',
      desc: `tar.xz ${target}/ → ${out}/${name}-<date>.tar.xz (+ .sha256)`,
      script: [
        'set -e',
        PICK_SUM,
        `mkdir -p "${out}"`,
        `OUT="${out}/${name}-$(date -u +%Y%m%d).tar.xz"`,
        `tar -cJf "$OUT" -C "${target}" .`,
        '$SUM "$OUT" > "$OUT.sha256"',
        'echo "wrote $OUT (+ .sha256)"',
      ].join('\n'),
    },
    verify: {
      type: 'run',
      label: 'Verify',
      desc: 'Validate an archive against its .sha256 sidecar',
      args: '<archive-file>',
      script: [
        'set -e',
        PICK_SUM,
        'F="${1:?Usage: verify <archive-file>}"',
        '$SUM -c "$F.sha256"',
      ].join('\n'),
    },
  };
}

module.exports = {
  name: 'archive',
  groupActions,
};
