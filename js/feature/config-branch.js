/**
 * config-branch plugin — git-branch-as-config-store.
 *
 * A group declares one of two shapes:
 *
 *   # (a) Explicit list — paths and excludes spelled out in the group.
 *   #     Use when the group's tracked set is independent of any other
 *   #     part of the project config.
 *   config_branch:
 *     branch: <branch-name>
 *     paths:
 *       - client
 *       - data/openvpn
 *     excludes:
 *       - data/openvpn/tmp
 *
 *   # (b) Reference to the top-level `files:` registry — single source of
 *   #     truth. Paths come from `files[*].path`; excludes come from each
 *   #     file's `exclude:` list. Use this when `files:` already declares
 *   #     the same set the branch should track — avoids double declaration.
 *   config_branch:
 *     branch: <branch-name>
 *     source: files
 *
 * The plugin's `groupActions` synthesizes three actions on the group:
 *
 *   save         → snapshot the listed paths from cwd into <branch>
 *                  (creates the branch if it doesn't exist; uses a temp
 *                  worktree, commits if there are changes)
 *   load         → restore the listed paths from <branch> back into cwd
 *                  (overwrites; refuses if the branch doesn't exist)
 *   check-stale  → diff cwd vs <branch>, print per-path verdicts, exit
 *                  0 if everything matches, 1 if any path differs or
 *                  exists on only one side
 *
 * Paths can be files or directories. Each is mkdir-p'd at the destination
 * and copied with `cp -a`. Missing source paths are skipped with a notice.
 *
 * The synthesized scripts are git-only: no `pbcopy`, `rsync`, or other
 * non-universal tools. As long as you're running inside a git repo,
 * they work — independent of host OS, container runtime, etc.
 *
 * Plugin contract: this module exports only `name` and `groupActions`.
 * Like archive.js, it has no other lifecycle hooks — loadable from
 * cli.js without booting any TUI runtime.
 */
'use strict';

// Worktree placement: <repo-root>/.tmp/worktree-<BRANCH>.
//
// Was mktemp -d (per-run unique tmpdir). The downside: a crashed run
// or SIGHUP (terminal closed mid-op, the EXIT/INT/TERM trap below
// can't catch HUP) leaves a stranded entry in .git/worktrees/, and
// the *next* attempt fails with "branch is already used by worktree
// at /var/folders/.../tmp.xxxx". User-visible, recovery requires a
// manual `git worktree prune`.
//
// Deterministic path + pre-op cleanup fixes that: we know exactly
// where the worktree should live, so we sweep that one specific path
// before adding the new worktree. Targeted — never touches a user-
// created worktree elsewhere in the repo.
//
// `.tmp/` is project-local (gitignored at the repo root), self-
// documenting (drop-able as a unit), and keeps the worktree visible
// to ls/find without polluting .git/.
const WORKTREE_PREP = [
  'TMP_ROOT="$(git rev-parse --show-toplevel)/.tmp"',
  'WT="$TMP_ROOT/worktree-$BRANCH"',
  'mkdir -p "$TMP_ROOT"',
  'git worktree remove --force "$WT" >/dev/null 2>&1 || true',
  'rm -rf "$WT"',
  // HUP added so closing the terminal mid-op also cleans up.
  // SIGKILL still can't be caught — that's what the pre-op
  // cleanup above is for.
  'trap \'git worktree remove "$WT" --force >/dev/null 2>&1; rm -rf "$WT"\' EXIT INT TERM HUP',
  'git worktree add "$WT" "$BRANCH" --quiet',
];

// Common worktree boilerplate used by all three actions: ensure the
// branch exists (creating an empty-tree commit if neither local nor
// origin has it), then run the prep block.
const WORKTREE_SETUP = [
  'set -e',
  'if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then',
  '    if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then',
  '        git branch "$BRANCH" "origin/$BRANCH" >/dev/null 2>&1',
  '    else',
  '        EMPTY=$(git hash-object -t tree /dev/null)',
  '        COMMIT=$(git commit-tree "$EMPTY" -m "Initial $BRANCH")',
  '        git branch "$BRANCH" "$COMMIT"',
  '    fi',
  'fi',
  ...WORKTREE_PREP,
];

// Same setup, but `load` and `check-stale` need the branch to exist —
// no auto-create. Refuse if missing instead.
const WORKTREE_SETUP_REQUIRE_BRANCH = [
  'set -e',
  'if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then',
  '    if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then',
  '        git branch "$BRANCH" "origin/$BRANCH" >/dev/null 2>&1',
  '    else',
  '        echo "branch \\"$BRANCH\\" does not exist locally or on origin" >&2',
  '        exit 1',
  '    fi',
  'fi',
  ...WORKTREE_PREP,
];

function preamble(branch, paths, excludes = []) {
  // PATHS / EXCLUDES are space-separated; the schema enforces non-empty
  // strings, and we don't accept paths with whitespace (schema rejects
  // empty, doesn't explicitly forbid spaces — keep an eye on this if it
  // ever bites).
  return [
    `BRANCH="${branch}"`,
    `PATHS="${paths.join(' ')}"`,
    `EXCLUDES="${excludes.join(' ')}"`,
  ];
}

function saveScript(branch, paths, excludes = []) {
  return [
    ...preamble(branch, paths, excludes),
    ...WORKTREE_SETUP,
    '',
    'for p in $PATHS; do',
    '    if [ ! -e "$p" ]; then echo "skip (missing locally): $p"; continue; fi',
    '    parent="$WT/$(dirname "$p")"',
    '    mkdir -p "$parent"',
    '    rm -rf "$WT/$p"',
    '    cp -a "$p" "$parent/"',
    'done',
    '',
    'for ex in $EXCLUDES; do',
    '    if [ -e "$WT/$ex" ]; then',
    '        rm -rf "$WT/$ex"',
    '        echo "excluded: $ex"',
    '    fi',
    'done',
    '',
    'cd "$WT"',
    'git add -A',
    'if git diff --cached --quiet; then',
    '    echo "no changes to commit"',
    'else',
    '    git commit -m "snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)" --quiet',
    '    echo "committed snapshot to branch $BRANCH"',
    'fi',
  ].join('\n');
}

function loadScript(branch, paths, excludes = []) {
  return [
    ...preamble(branch, paths, excludes),
    ...WORKTREE_SETUP_REQUIRE_BRANCH,
    '',
    'for p in $PATHS; do',
    '    if [ ! -e "$WT/$p" ]; then echo "skip (not in branch): $p"; continue; fi',
    '    parent="$(dirname "$p")"',
    '    mkdir -p "$parent"',
    '    rm -rf "$p"',
    '    cp -a "$WT/$p" "$parent/"',
    '    echo "loaded: $p"',
    'done',
  ].join('\n');
}

function checkStaleScript(branch, paths, excludes = []) {
  return [
    ...preamble(branch, paths, excludes),
    ...WORKTREE_SETUP_REQUIRE_BRANCH,
    '',
    'STALE=0',
    '# Pruned-local-copy tmpdir lives inside $WT so the existing worktree',
    '# cleanup trap removes it on SIGINT/EXIT — no second trap chain.',
    'CMP="$WT/.cmp"',
    'mkdir -p "$CMP"',
    '',
    'for p in $PATHS; do',
    '    SRC="$p"',
    '    pruned=0',
    '    for ex in $EXCLUDES; do',
    '        case "$ex" in',
    '            "$p"|"$p"/*)',
    '                if [ "$pruned" -eq 0 ] && [ -e "$p" ]; then',
    '                    rm -rf "$CMP/_"',
    '                    cp -a "$p" "$CMP/_"',
    '                    SRC="$CMP/_"',
    '                    pruned=1',
    '                fi',
    '                rel="${ex#$p}"; rel="${rel#/}"',
    '                if [ -z "$rel" ]; then',
    '                    rm -rf "$SRC"',
    '                else',
    '                    rm -rf "$SRC/$rel"',
    '                fi',
    '                ;;',
    '        esac',
    '    done',
    '    if [ -e "$SRC" ] && [ -e "$WT/$p" ]; then',
    '        # diff exits 1 on differences; the trailing || true keeps `set -e` happy.',
    '        diff_out=$(diff -qr "$SRC" "$WT/$p" 2>/dev/null || true)',
    '        if [ -n "$diff_out" ]; then',
    '            echo "DIFF: $p"',
    '            printf \'%s\\n\' "$diff_out" | sed \'s/^/  /\'',
    '            STALE=1',
    '        fi',
    '    elif [ -e "$SRC" ]; then',
    '        echo "ONLY-LOCAL: $p"',
    '        STALE=1',
    '    elif [ -e "$WT/$p" ]; then',
    '        echo "ONLY-BRANCH: $p"',
    '        STALE=1',
    '    fi',
    'done',
    'if [ "$STALE" -eq 0 ]; then echo "no differences"; fi',
    'exit "$STALE"',
  ].join('\n');
}

function resolveFromSource(cfg, config) {
  // `source: files` derives both paths and excludes from the top-level
  // `files:` registry — the single source of truth for declared user
  // state. The plugin holds no path state; it only renders scripts.
  //
  // `categories:` is the filter the user passes in to scope the source.
  // If absent, every entry in `files:` is included; if present, only
  // entries with a matching `category:` are taken. The latter is what
  // dev9 wants: the parser auto-appends plugin YAML paths to `files:`
  // (without a category) and those should not land in the config
  // branch.
  if (cfg.source !== 'files') return null;
  const files = (config && config.files) || [];
  const categories = Array.isArray(cfg.categories) ? cfg.categories : null;
  const paths = [];
  const excludes = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    if (categories && !categories.includes(f.category)) continue;
    paths.push(f.path);
    if (Array.isArray(f.exclude)) {
      for (const e of f.exclude) {
        if (typeof e === 'string' && e) excludes.push(e);
      }
    }
  }
  return { paths, excludes };
}

function groupActions(group, _groupName, config) {
  if (!group || !group.config_branch) return {};
  const cfg = group.config_branch;
  const branch = cfg.branch;
  if (typeof branch !== 'string' || !branch) return {};

  let paths;
  let excludes;
  const fromSource = resolveFromSource(cfg, config);
  if (fromSource) {
    paths = fromSource.paths;
    excludes = fromSource.excludes;
  } else {
    paths = cfg.paths;
    excludes = Array.isArray(cfg.excludes) ? cfg.excludes : [];
  }
  if (!Array.isArray(paths) || paths.length === 0) return {};

  const exTag = excludes.length ? ` (− ${excludes.length} excluded)` : '';
  return {
    save: {
      type: 'run',
      label: 'Save',
      desc: `Snapshot ${paths.length} path(s) into branch "${branch}"${exTag}`,
      script: saveScript(branch, paths, excludes),
    },
    load: {
      type: 'run',
      label: 'Load',
      desc: `Restore the listed paths from branch "${branch}" into cwd`,
      script: loadScript(branch, paths, excludes),
    },
    'check-stale': {
      type: 'run',
      label: 'Check stale',
      desc: `Diff cwd vs branch "${branch}"; rc 1 if any path differs${exTag}`,
      script: checkStaleScript(branch, paths, excludes),
    },
  };
}

module.exports = {
  name: 'config-branch',
  groupActions,
  // Exported for unit tests; not part of the public plugin contract.
  _saveScript: saveScript,
  _loadScript: loadScript,
  _checkStaleScript: checkStaleScript,
};
