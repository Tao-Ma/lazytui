/**
 * image-backup — `docker save | gzip` for a list of images (and
 * `gunzip | docker load` to restore). groupAction contributor.
 *
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
 * `groupActions(group, name)` synthesizes four actions:
 *
 *   save    → per image: atomically produce <dir>/<safe>.tar.gz +
 *             <safe>.tar.gz.sha256 sidecar. Streams to `.partial`,
 *             computes sha256 from the partial, `mv` partial → final,
 *             then writes the sidecar LAST. Sidecar presence ⇒ the
 *             final file is a complete docker-save stream whose bytes
 *             match the recorded hash. An interrupt mid-pipeline can
 *             never truncate the previous good backup (the redirect
 *             targets `.partial`, not the final name).
 *             Missing images: SKIP notice, batch continues.
 *   load    → `gunzip | docker load` for every `<dir>/*.tar.gz` whose
 *             `.sha256` sidecar validates. A bad sum ABORTS the whole
 *             batch (rc 1) — restoring a corrupt image is worse than
 *             stopping. Files without a sidecar (legacy / interrupted
 *             pre-upgrade) are skipped loudly unless the `force` port
 *             is set, in which case they load with a notice.
 *   verify  → integrity gate (no docker needed). For every `*.tar.gz`
 *             in the dir: sidecar present → `$SUM -c`; absent → `gzip
 *             -t` + report UNVERIFIED. Warns on leftover `*.partial`.
 *             rc 1 on any FAIL (bad sum / failed gzip -t); UNVERIFIED
 *             alone stays rc 0 (legacy-informational; the load gate
 *             already refuses those without force). Cron/CI-friendly.
 *   status  → read-only drift report. Per configured image ref:
 *             live image ID (`docker inspect`) vs the ID baked INTO
 *             the tar. Matches EITHER tar layout — containerd store
 *             (`index.json`'s `manifests[].digest`) OR classic
 *             graphdriver (`manifest.json`'s `Config` as `<id>.json`
 *             or `blobs/sha256/<id>`) — comparing all 64-hex
 *             candidates against the live hex, so neither store type
 *             reports STALE spuriously. Verdict: CURRENT / STALE /
 *             MISSING / UNVERIFIED / ARCHIVED (no live). Trailing
 *             strays section lists files in the dir that are neither
 *             an expected `<safe>.tar.gz` / its sidecar for any
 *             configured ref, nor `*.partial`. No mutations.
 *
 * Shape: exports only `name` + `groupActions` — not a Component, not
 * registered with the framework. cli.js loads it directly via
 * BUILT_IN_PLUGINS for CLI-mode action resolution. Same shape +
 * intent as feature/archive.js, now with the same `.sha256` sidecar
 * discipline (shared `PICK_SUM` leaf).
 */
'use strict';

const crypto = require('crypto');
const { shEscape } = require('../leaves/text/sh-escape');
const { PICK_SUM } = require('../leaves/text/pick-sum');

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
    PICK_SUM,
  ];
  for (const img of list) {
    const safe = safeName(img);
    const imgQ = shEscape(img);
    const base = `${safe}.tar.gz`;
    const partial = shEscape(`${out}/${safe}.tar.gz.partial`);
    const finalF = shEscape(`${out}/${safe}.tar.gz`);
    const sidecar = shEscape(`${out}/${safe}.tar.gz.sha256`);
    const baseQ = shEscape(base);
    lines.push(`echo ${shEscape(`  ${img}...`)}`);
    // ATOMIC WINDOW. Three invariants being pinned:
    //   1. The redirect targets `.partial`, never the final name — an
    //      interrupt / SIGKILL / power loss leaves last-good-backup
    //      intact under `<base>`; worst case = a stale `.partial`
    //      sibling (cleaned by the next save, flagged by verify).
    //   2. `.partial` doesn't match the load/verify globs (`*.tar.gz`
    //      only matches names ENDING in `.tar.gz`; `foo.tar.gz.partial`
    //      does not), so a leftover partial can never be loaded.
    //   3. Sidecar presence ⇒ the file under the final name is a
    //      complete docker-save stream whose bytes hash to the sidecar
    //      value. We compute the hash from the partial (pre-mv), then
    //      mv, then write the sidecar LAST — if any step fails the
    //      sidecar is simply absent and the file falls under verify's
    //      UNVERIFIED / load's refuse-without-force branch.
    //
    // The stale-partial cleanup at the top of the block covers the
    // "same image saved twice in a row, first was interrupted" case.
    //
    // Invoke bash explicitly for the pipefail subshell — actions run
    // under `sh -c` and on Debian/Ubuntu /bin/sh is dash, which lacks
    // `set -o pipefail`. Without pipefail, gzip succeeds on empty
    // input even when docker save fails, leaving a junk file; the SKIP
    // notice depends on pipeline failure to fire.
    lines.push(
      `rm -f ${partial}`,
      `if bash -c 'set -o pipefail; docker save "$1" 2>/dev/null | gzip > "$2"' _ ${imgQ} ${partial}; then`,
      `  HASH=$($SUM ${partial} | awk '{print $1}')`,
      `  if [ -n "$HASH" ]; then`,
      `    mv ${partial} ${finalF}`,
      `    printf '%s  %s\\n' "$HASH" ${baseQ} > ${sidecar}`,
      `  else`,
      `    rm -f ${partial}`,
      `    echo ${shEscape(`  FAIL ${img} (checksum step)`)} >&2`,
      `  fi`,
      `else`,
      `  rm -f ${partial}`,
      `  echo ${shEscape(`  SKIP ${img} (not found)`)}`,
      `fi`,
    );
  }
  lines.push(`echo ${shEscape(`saved to ${out}/`)}`);
  lines.push(`ls -lh ${dir}/`);
  return lines.join('\n');
}

function loadScript(out) {
  const dir = shEscape(out);
  return [
    'set -u',
    `[ -d ${dir} ] || { echo ${shEscape(`no backup dir at ${out}`)} >&2; exit 1; }`,
    PICK_SUM,
    'found=0',
    'loaded=0',
    'skipped=0',
    `for f in ${dir}/*.tar.gz; do`,
    '  [ -f "$f" ] || continue',
    '  found=$((found + 1))',
    '  base=$(basename "$f")',
    '  if [ -f "$f.sha256" ]; then',
    // $SUM -c resolves filenames relative to cwd; the sidecar carries
    // the FINAL basename, so cd into the backup dir before verifying.
    // A sum failure aborts the whole batch (rc 1 — load of a corrupt
    // image is a worse outcome than stopping and alerting the operator).
    `    if (cd ${dir} && $SUM -c "$base.sha256") >/dev/null 2>&1; then`,
    '      echo "  $base..."',
    '      gunzip -c "$f" | docker load',
    '      loaded=$((loaded + 1))',
    '    else',
    '      echo "FAIL checksum: $base" >&2',
    '      exit 1',
    '    fi',
    '  else',
    // No sidecar = legacy file (pre-upgrade save) OR an interrupted
    // save whose sidecar never landed. Refuse to load without an
    // explicit opt-in — this is the mechanism that neutralizes the
    // dev9 incident class (legacy-named files silently stealing tags
    // during a full restore). `force` is the port, bound as the env
    // var `$force` by the shell-ports resolver.
    '    if [ -n "${force:-}" ]; then',
    '      echo "  $base... (unverified — force)"',
    '      gunzip -c "$f" | docker load',
    '      loaded=$((loaded + 1))',
    '    else',
    '      echo "  SKIP $base (no .sha256 sidecar — legacy/unverified; set force to override)"',
    '      skipped=$((skipped + 1))',
    '    fi',
    '  fi',
    'done',
    `[ "$found" -gt 0 ] || { echo ${shEscape(`no .tar.gz files in ${out}`)} >&2; exit 1; }`,
    '[ "$loaded" -gt 0 ] || { echo "no files loaded ($skipped skipped — set force to load unverified)" >&2; exit 1; }',
    'echo "done. loaded $loaded, skipped $skipped."',
  ].join('\n');
}

function verifyScript(out) {
  const dir = shEscape(out);
  return [
    'set -u',
    `[ -d ${dir} ] || { echo ${shEscape(`no backup dir at ${out}`)} >&2; exit 1; }`,
    PICK_SUM,
    'files=0',
    'fail=0',
    `for f in ${dir}/*.tar.gz; do`,
    '  [ -f "$f" ] || continue',
    '  files=$((files + 1))',
    '  base=$(basename "$f")',
    '  if [ -f "$f.sha256" ]; then',
    `    if (cd ${dir} && $SUM -c "$base.sha256") >/dev/null 2>&1; then`,
    '      echo "OK                       $base"',
    '    else',
    '      echo "FAIL (checksum)          $base"',
    '      fail=1',
    '    fi',
    '  else',
    // No sidecar → fall back to gzip -t to catch outright corruption
    // of a legacy file. UNVERIFIED alone is informational (rc 0); a
    // failed gzip -t is a hard FAIL (rc 1).
    '    if gzip -t "$f" >/dev/null 2>&1; then',
    '      echo "UNVERIFIED (no sidecar)  $base"',
    '    else',
    '      echo "FAIL (gzip -t)           $base"',
    '      fail=1',
    '    fi',
    '  fi',
    'done',
    // Leftover .partial from an interrupted save — WARN only, not a
    // FAIL (it isn't a data error; it's a stale artifact the next save
    // will overwrite). Loud enough that an operator notices and can
    // `rm` it, cheap enough to not block a cron verify.
    `for p in ${dir}/*.tar.gz.partial; do`,
    '  [ -f "$p" ] || continue',
    '  echo "WARN leftover partial: $(basename "$p")"',
    'done',
    `[ "$files" -gt 0 ] || { echo ${shEscape(`no .tar.gz files in ${out}`)} >&2; exit 1; }`,
    'exit $fail',
  ].join('\n');
}

function statusScript(list, out) {
  const dir = shEscape(out);
  // Build a shell `case` alternation of every expected basename
  // (both `<safe>.tar.gz` and `<safe>.tar.gz.sha256` per configured
  // ref). Used by the strays loop to recognize non-stray files. Each
  // name is single-quoted so metacharacters stay literal — safeName's
  // output set is `[a-zA-Z0-9_.-]`, no glob meta, but belt-and-braces.
  const expectedPatterns = [];
  for (const img of list) {
    const safe = safeName(img);
    expectedPatterns.push(shEscape(`${safe}.tar.gz`));
    expectedPatterns.push(shEscape(`${safe}.tar.gz.sha256`));
  }
  const expectedAlt = expectedPatterns.join('|');

  const lines = [
    'set -u',
    `[ -d ${dir} ] || { echo ${shEscape(`no backup dir at ${out}`)} >&2; exit 1; }`,
    `command -v docker >/dev/null 2>&1 || { echo ${shEscape('docker not found on PATH')} >&2; exit 1; }`,
    'echo "images:"',
  ];

  for (const img of list) {
    const safe = safeName(img);
    const imgQ = shEscape(img);
    const file = shEscape(`${out}/${safe}.tar.gz`);
    const sidecarF = shEscape(`${out}/${safe}.tar.gz.sha256`);
    lines.push(
      // Per-ref status block.
      // Live ID — docker inspect format `{{.Id}}` returns `sha256:<64hex>`
      // when the ref exists, empty when it doesn't. `|| true` keeps the
      // script running past a lookup miss (we want ARCHIVED/MISSING, not
      // a hard exit).
      `_ref=${imgQ}`,
      `_live=$(docker inspect --format '{{.Id}}' "$_ref" 2>/dev/null || true)`,
      `_live_hex=${'${_live#sha256:}'}`,
      `if [ ! -f ${file} ]; then`,
      `  if [ -z "$_live" ]; then`,
      `    echo "  MISSING     $_ref  (no backup, no live image)"`,
      `  else`,
      `    echo "  MISSING     $_ref  (live only — no backup on disk)"`,
      `  fi`,
      `else`,
      `  _sidecar=no`,
      `  [ -f ${sidecarF} ] && _sidecar=yes`,
      // size + mtime via ls -lh — portable enough; we care about the
      // operator-facing columns, not programmatic parsing downstream.
      `  _info=$(ls -lh ${file} 2>/dev/null | awk '{print $5, $6, $7, $8}')`,
      // Match EITHER tar layout. Grep for any 64-hex sequence inside
      // index.json AND manifest.json — covers:
      //   - containerd store:  index.json's manifests[].digest
      //   - classic store:     manifest.json's Config as `<id>.json` or
      //                        `blobs/sha256/<id>`
      // Both forms spell the ID as a bare 64-hex somewhere in those two
      // files, so grep-OR + any-match defeats the "report every image
      // STALE on containerd daemons" bug the brief flags.
      `  _inner_ids=$({ tar -xzOf ${file} index.json 2>/dev/null; tar -xzOf ${file} manifest.json 2>/dev/null; } | grep -oE '[0-9a-f]{64}' | sort -u)`,
      `  _verdict='STALE     '`,
      `  if [ "$_sidecar" = 'no' ]; then`,
      `    _verdict='UNVERIFIED'`,
      `  elif [ -z "$_live" ]; then`,
      `    _verdict='ARCHIVED  '`,
      `  else`,
      `    for _id in $_inner_ids; do`,
      `      if [ "$_id" = "$_live_hex" ]; then`,
      `        _verdict='CURRENT   '`,
      `        break`,
      `      fi`,
      `    done`,
      `  fi`,
      `  echo "  $_verdict  $_ref  sidecar=$_sidecar  $_info"`,
      `fi`,
    );
  }

  // Strays section — any file in the dir that isn't an expected
  // `<safe>.tar.gz` or `<safe>.tar.gz.sha256` for a configured ref,
  // and isn't a `*.partial`. Formally surfaces the dev9 incident
  // class (legacy-naming files mixing with new ones) without
  // mutating anything: deleting backups stays a human decision.
  lines.push(
    'echo ""',
    'echo "strays:"',
    '_stray=0',
    `for f in ${dir}/*; do`,
    '  [ -f "$f" ] || continue',
    '  _base=$(basename "$f")',
    '  case "$_base" in',
    '    *.partial) continue ;;',
  );
  if (expectedAlt) {
    lines.push(`    ${expectedAlt}) continue ;;`);
  }
  lines.push(
    '  esac',
    '  echo "  $_base"',
    '  _stray=$((_stray + 1))',
    'done',
    '[ "$_stray" -eq 0 ] && echo "  (none)"',
    'exit 0',
  );

  return lines.join('\n');
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
      desc: `docker save ${list.length} image(s) → ${out}/<safe>.tar.gz + .sha256 (atomic)`,
      script: saveScript(list, out),
    },
    load: {
      type: 'run',
      label: 'Load images',
      desc: `docker load every ${out}/*.tar.gz with a valid .sha256 (force to override)`,
      // `force` is a safety override. Declared as an optional string
      // port (type is opaque in the fabric; any non-empty value turns
      // the branch on via `${force:-}`). `remember: false` because a
      // safety override shouldn't prefill from history.
      ports: {
        in: {
          force: {
            type: 'string',
            required: false,
            remember: false,
            desc: 'set non-empty to load files without a .sha256 sidecar',
          },
        },
      },
      script: loadScript(out),
    },
    verify: {
      type: 'run',
      label: 'Verify images',
      desc: `check .sha256 (or gzip -t) for every ${out}/*.tar.gz; warn on *.partial`,
      script: verifyScript(out),
    },
    status: {
      type: 'run',
      label: 'Status',
      desc: `compare each configured image's live ID vs the one baked into ${out}/<safe>.tar.gz; list strays`,
      script: statusScript(list, out),
    },
  };
}

module.exports = {
  name: 'image-backup',
  groupActions,
  // Exported for unit tests; not part of the public plugin contract.
  _saveScript: saveScript,
  _loadScript: loadScript,
  _verifyScript: verifyScript,
  _statusScript: statusScript,
  _safeName: safeName,
};
