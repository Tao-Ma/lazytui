/**
 * image-backup — `docker save | gzip` for a list of images (and
 * `gunzip | docker load` to restore). groupAction contributor.
 * Mirrors do.sh's old `maintenance image-save` / `image-load` but
 * driven by YAML so any dev project can wire its own list.
 *
 * A group declares:
 *
 *   images:
 *     list:                          # required, non-empty
 *       - dev9-env
 *       - gitea/gitea:latest
 *       - aanousakis/no-ip
 *     output_dir: image_backup       # optional, default "."
 *
 * `groupActions(group, name)` synthesizes two actions:
 *
 *   save  → for each image, `docker save <img> | gzip > <dir>/<safe>.tar.gz`
 *           (`/` and `:` in image refs are replaced with `_` for the
 *           filename; missing images are skipped with a notice rather
 *           than failing the whole batch).
 *   load  → `gunzip -c <dir>/*.tar.gz | docker load` for every file in
 *           the output dir. Refuses if the dir is missing.
 *
 * Shape: exports only `name` + `groupActions` — not a Component, not
 * registered with the framework. cli.js loads it directly via
 * BUILT_IN_PLUGINS for CLI-mode action resolution. Same shape +
 * intent as feature/archive.js.
 */
'use strict';

function safeName(img) {
  return img.replace(/[\/:]/g, '_');
}

function saveScript(list, out) {
  const lines = [
    'set -u',
    `mkdir -p "${out}"`,
  ];
  for (const img of list) {
    const safe = safeName(img);
    lines.push(`echo "  ${img}..."`);
    // pipefail in a subshell — without it, gzip succeeds on empty
    // input even when docker save fails, leaving a junk .tar.gz on
    // disk. With pipefail, the subshell rc reflects docker's failure;
    // we then rm the partial file and surface a SKIP so the user
    // knows which image bailed without aborting the whole batch.
    //
    // Invoke bash explicitly for this subshell — actions run under
    // `sh -c` (see exec.js) and on Debian/Ubuntu /bin/sh is dash,
    // which lacks `set -o pipefail`. Bash is universally available
    // on supported platforms.
    lines.push(
      `bash -c 'set -o pipefail; docker save "$1" 2>/dev/null | gzip > "$2"' _ "${img}" "${out}/${safe}.tar.gz" || ` +
      `{ rm -f "${out}/${safe}.tar.gz"; echo "  SKIP ${img} (not found)"; }`,
    );
  }
  lines.push(`echo "saved to ${out}/"`);
  lines.push(`ls -lh "${out}/"`);
  return lines.join('\n');
}

function loadScript(out) {
  return [
    'set -u',
    `[ -d "${out}" ] || { echo "no backup dir at ${out}" >&2; exit 1; }`,
    'found=0',
    `for f in "${out}"/*.tar.gz; do`,
    '    [ -f "$f" ] || continue',
    '    found=$((found + 1))',
    '    echo "  $(basename "$f")..."',
    '    gunzip -c "$f" | docker load',
    'done',
    `[ "$found" -gt 0 ] || { echo "no .tar.gz files in ${out}" >&2; exit 1; }`,
    'echo "done."',
  ].join('\n');
}

function groupActions(group) {
  if (!group || !group.images) return {};
  const cfg = group.images;
  const list = cfg.list;
  if (!Array.isArray(list) || list.length === 0) return {};
  const out = (typeof cfg.output_dir === 'string' && cfg.output_dir) || '.';

  return {
    save: {
      type: 'run',
      label: 'Save images',
      desc: `docker save ${list.length} image(s) to ${out}/<safe-name>.tar.gz`,
      script: saveScript(list, out),
    },
    load: {
      type: 'run',
      label: 'Load images',
      desc: `docker load from every ${out}/*.tar.gz`,
      script: loadScript(out),
    },
  };
}

module.exports = {
  name: 'image-backup',
  groupActions,
  // Exported for unit tests; not part of the public plugin contract.
  _saveScript: saveScript,
  _loadScript: loadScript,
  _safeName: safeName,
};
