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

const crypto = require('crypto');
const { shEscape } = require('../leaves/text/sh-escape');

/** Filename-safe key for a docker image ref. Replaces `/` and `:` with
 *  `_` AND appends an 8-char hash of the ORIGINAL ref so collisions
 *  between distinct refs that flatten to the same string (e.g.
 *  `a/b:latest` vs `a:b:latest`) can't silently clobber each other in
 *  the backup directory. Load still globs `*.tar.gz`, so the longer
 *  filename is transparent to the load path. */
function safeName(img) {
  const flat = img.replace(/[\/:]/g, '_');
  const hash = crypto.createHash('sha256').update(img).digest('hex').slice(0, 8);
  return `${flat}-${hash}`;
}

function saveScript(list, out) {
  // shEscape every config-supplied value before embedding — schema only
  // checks that strings ARE strings; a `output_dir: /tmp"; rm -rf /; "`
  // would otherwise execute under raw `"${out}"` interpolation. Image
  // refs come from the user-provided `list` and need the same treatment.
  const dir = shEscape(out);
  const lines = [
    'set -u',
    `mkdir -p ${dir}`,
  ];
  for (const img of list) {
    const safe = safeName(img);
    const imgQ = shEscape(img);
    const outFile = shEscape(`${out}/${safe}.tar.gz`);
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
      `bash -c 'set -o pipefail; docker save "$1" 2>/dev/null | gzip > "$2"' _ ${imgQ} ${outFile} || ` +
      `{ rm -f ${outFile}; echo "  SKIP ${img} (not found)"; }`,
    );
  }
  lines.push(`echo "saved to ${out}/"`);
  lines.push(`ls -lh ${dir}/`);
  return lines.join('\n');
}

function loadScript(out) {
  const dir = shEscape(out);
  return [
    'set -u',
    `[ -d ${dir} ] || { echo "no backup dir at ${out}" >&2; exit 1; }`,
    'found=0',
    `for f in ${dir}/*.tar.gz; do`,
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
