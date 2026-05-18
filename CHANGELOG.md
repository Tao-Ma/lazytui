# Changelog

All notable changes to lazytui are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Release packaging.** `package.json` populated with publish-ready
  metadata (repository, homepage, author, license, keywords). New
  `.npmignore` keeps tests, demos, and `__pycache__/` out of the npm
  tarball — package size ~170 kB / 78 files. A
  `.github/workflows/release.yml` workflow triggers on `v*.*.*` tag
  push: runs tests, builds `lazytui-X.Y.Z.tgz` (npm-style) +
  `lazytui-X.Y.Z-source.tar.gz` (full git-archive), creates a GitHub
  Release with both attached. RELEASING.md documents the maintainer
  flow including the deferred npm-publish path (the dual-runtime
  Node+Python install is still an open question).
- Three worked demos under `demo/`:
  - `postgres` — produce-from-source shape (Shape A).
  - `cloudberrydb` — wrap-upstream shape (Shape B) against
    apache/cloudberry's `devops/sandbox/`.
  - `tidb` (on `dev-demo-tidb` branch, awaiting live-test merge) —
    orchestrate pre-built `pingcap/*` images.
- `DEMO.md` codifies the two demo shapes and the "fix the prompt,
  not the artifact" loop discipline.
- `bin/lazytui` portable wrapper. Auto-detects `.venv/` at the repo
  root so demos run without manually activating the venv.
- `--spec` flag dumps the consolidated plugin-authoring bundle
  (SPEC + PRINCIPLES + PLUGINS + PROJECT + HUB + DECORATORS +
  LAYOUT) for AI agents.
- Framework + spec docs relocated under `docs/`; historical
  snapshots under `docs/history/`. Root is README + DEMO +
  LICENSE only.

### Fixed
- README ASCII TUI mockup misaligned on GitHub's web font due to
  ambiguous-width glyphs (`●`, `❶`, `⧉`, `↑↓`, `←→`). Rebuilt with
  single-cell-safe characters.

## [0.1.0] — 2026-05-15

Initial public release. Single squashed commit on
[github.com/Tao-Ma/lazytui](https://github.com/Tao-Ma/lazytui).
Full pre-squash history preserved on the internal gitea mirror
under the `backup/main-history` branch and the
`v0.1.0-pre-squash` tag.

### Included
- Renderer (Node.js, zero npm runtime deps except node-pty and
  @xterm/headless for embedded PTY tabs).
- Parser (Python, validates and resolves the YAML config; 6 pytest
  files).
- 17 JS smoke suites covering state, dispatch, plugins, hub,
  decorators, render helpers, terminal, history, multiselect,
  archive, config-branch, config-status, image-backup, stats,
  tree, prompt, confirm, cmdline-args, onkey-dispatch, bulk
  commands.
- Built-in panel types: `groups`, `actions`, `file-manager`,
  `history`, `detail`, plus `containers` and `stats` from the
  docker plugin.
- Subsystems: hub (pub/sub), decorators (UI slot framework),
  cmdline (`:`) verbs, embedded PTY terminals, 6 themes, design
  mode, cli mode (`--exec`, `--list`), `--spec` bundle.

[Unreleased]: https://github.com/Tao-Ma/lazytui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Tao-Ma/lazytui/releases/tag/v0.1.0
