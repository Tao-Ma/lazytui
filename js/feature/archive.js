/**
 * archive — generic tar+xz+sha256 backup pattern. groupAction contributor.
 *
 * A group declares:
 *
 *   archive:
 *     target: <directory-to-archive>           # required
 *     name:   <archive-base-filename>          # required
 *     output_dir: <where-to-write>             # optional, default: "."
 *
 * `groupActions(group, name)` synthesizes two actions on that group:
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
 * Shape: this module exports only `name` and `groupActions` — no
 * `init` / `update` / `panelTypes`, so it's NOT a Component and isn't
 * registered with the Component framework. cli.js loads it directly
 * via the BUILT_IN_PLUGINS list to merge groupActions for CLI-mode
 * action resolution. Living in `feature/` (alongside register /
 * history / yaml-layout) signals "utility module, not a panel" —
 * the post-v0.5-Phase-6 spot for chrome-less groupAction contributors.
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

const { shEscape } = require('../leaves/text/sh-escape');

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

  // Single-quote-escape every config value before embedding — schema
  // only validates they're strings, so a `target: foo"; rm -rf /; "`
  // (or any name/output_dir with `$`, backtick, `;`, etc.) would
  // execute under raw `"${target}"` interpolation. shEscape produces
  // POSIX-literal `'foo"; rm -rf /; "'`.
  const tgt = shEscape(target);
  const nm  = shEscape(name);
  const dir = shEscape(out);
  return {
    archive: {
      type: 'run',
      label: 'Archive',
      desc: `tar.xz ${target}/ → ${out}/${name}-<date>.tar.xz (+ .sha256)`,
      script: [
        'set -e',
        PICK_SUM,
        `mkdir -p ${dir}`,
        `OUT=${dir}/${nm}-$(date -u +%Y%m%d).tar.xz`,
        `tar -cJf "$OUT" -C ${tgt} .`,
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
