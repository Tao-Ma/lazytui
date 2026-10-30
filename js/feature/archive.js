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
const { PICK_SUM } = require('../leaves/text/pick-sum');

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
      // ATOMIC SAVE — same pattern image-backup adopted in v0.6.53. Names
      // are date-stamped, so cross-day runs never collide, but the
      // same-day re-run-before-risky-change case did: `tar -cJf "$OUT"`
      // truncated the previous good archive at t=0, and an interrupt
      // (Ctrl-C / SSH drop / power loss) mid-tar left a truncated file
      // under the final name beside a now-stale sidecar — the dir looked
      // superficially fine, verify would also pass against the old hash
      // for a byte prefix. Three invariants being pinned:
      //   1. The `tar` target is never the final name — any interrupt
      //      leaves the previous same-day archive intact; worst case is
      //      a stale `.partial` sibling, removed by the next run's `rm`.
      //   2. The sidecar is written LAST, from the pre-mv hash. Sidecar
      //      presence ⇒ `<OUT>` is a complete tar.xz whose bytes hash to
      //      the recorded value. The mv → printf window replaces both
      //      generations together; an interrupt there leaves the NEW
      //      file with the OLD sidecar — verify correctly FAILs
      //      (fail-closed), not silently loads a drifted archive.
      //   3. Sidecar line keeps the current `<hash>  <OUT>` format (OUT
      //      = relative-to-project-dir path), NOT the basename. The
      //      synthesized `verify` runs `$SUM -c "$file.sha256"` from
      //      project_dir — the recorded path has to resolve from there.
      //      Copying image-backup's basename-style sidecar would break
      //      every new archive while old ones still verified. Explicit
      //      `printf '%s  %s\n' "$HASH" "$OUT"` reproduces the pre-v0.6.54
      //      `$SUM "$OUT" > "$OUT.sha256"` bytes exactly, so every
      //      existing sidecar on disk stays valid — zero migration.
      // `set -e` suffices: single commands only (no pipeline), so no
      // pipefail/dash concern and no bash subshell needed. Simpler than
      // image-backup's save (which had a `docker | gzip` pipeline).
      script: [
        'set -e',
        PICK_SUM,
        `mkdir -p ${dir}`,
        // Stale-partial cleanup — scoped to <dir>/<name>-*.tar.xz.partial
        // so unrelated files sharing the dir are untouched. The `*` sits
        // OUTSIDE the single-quoted parts so the shell globs it.
        `rm -f ${dir}/${nm}-*.tar.xz.partial`,
        `OUT=${dir}/${nm}-$(date -u +%Y%m%d).tar.xz`,
        `tar -cJf "$OUT.partial" -C ${tgt} .`,
        `HASH=$($SUM "$OUT.partial" | awk '{print $1}')`,
        'mv "$OUT.partial" "$OUT"',
        `printf '%s  %s\\n' "$HASH" "$OUT" > "$OUT.sha256"`,
        'echo "wrote $OUT (+ .sha256)"',
      ].join('\n'),
    },
    verify: {
      type: 'run',
      label: 'Verify',
      desc: 'Validate an archive against its .sha256 sidecar',
      // Named input port (docs/ports-and-wires.md P1 — shell path): the resolved
      // value is bound as the `$file` env var when the child shell spawns, so the
      // script never parses the user value. The TUI collects this via the fabric
      // modal (or a wire); the CLI maps the first positional `--exec` arg to the
      // first port in declaration order.
      ports: {
        in: {
          file: { type: 'string', required: true, desc: 'archive to verify' },
        },
      },
      script: [
        'set -e',
        PICK_SUM,
        '$SUM -c "$file.sha256"',
      ].join('\n'),
    },
  };
}

module.exports = {
  name: 'archive',
  groupActions,
};
