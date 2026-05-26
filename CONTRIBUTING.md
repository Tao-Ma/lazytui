# Contributing to lazytui

Thanks for your interest. Contributions are welcome — from a typo
fix in a doc to a new built-in panel type or a new demo against
your favorite open-source target.

## Quick start

```sh
git clone https://github.com/Tao-Ma/lazytui.git
cd lazytui

# Node deps (node-pty + @xterm/headless for embedded terminals,
# js-yaml for config parsing).
npm install --omit=dev

# Run the test suite.
node js/run-tests.js
```

### Dogfooding a dev lazytui inside another project

When you're iterating on lazytui itself and want to try a change
inside an existing consumer (say `~/exchange/pg-tui`) without
publishing/installing, set `LAZYTUI_PATH`:

```sh
export LAZYTUI_PATH=~/exchange/lazytui
~/exchange/pg-tui/run        # runs your dev lazytui against pg-tui's config
unset LAZYTUI_PATH           # back to whatever pg-tui shipped with
```

Every `bin/lazytui` (including the one in the consumer's node_modules)
re-exec's against the lazytui at `LAZYTUI_PATH`. Same-directory guard
keeps the lazytui repo itself unaffected; an invalid path fails loud
(no silent fallback).

## Where to start

- **Found a bug or want a small fix:** open an issue, or send a PR
  if it's a one-line change.
- **Want to add a demo for project X:** read [DEMO.md](DEMO.md)
  first. The "pick the shape" rule and the loop discipline ("fix
  the prompt, not the artifact") are load-bearing for keeping demos
  coherent.
- **Want to change the framework itself:** read
  [docs/PRINCIPLES.md](docs/PRINCIPLES.md) first. *"YAML defines,
  TUI renders."* Then [docs/PLUGINS.md](docs/PLUGINS.md) for the
  plugin contract, or [docs/LAYOUT.md](docs/LAYOUT.md) for panel
  types.
- **Plugin author:** start with `bin/lazytui --spec` — it dumps
  the consolidated authoring bundle (SPEC + PRINCIPLES + PLUGINS +
  PROJECT + HUB + DECORATORS + LAYOUT) in one file. That is the
  contract; feed it to an AI agent or read it yourself.

## Code conventions

The codebase is small and self-describing. Two non-obvious rules
that surface often (both from
[docs/PRINCIPLES.md](docs/PRINCIPLES.md)):

- **`esc()` every dynamic `[` in renderer markup.** The Rich-style
  markup pipeline silently swallows unescaped `[` as tag opens and
  breaks visible-width calculation, misaligning borders.
- **No inner markup inside `[reverse]` selected lines.** Any `[/]`
  or color escape resets the reverse mid-line. Selected rows are
  plain text; colors belong on unselected rows.

If you're adding behavior, prefer extending the `type:` field on
actions rather than introducing a new YAML top-level concept.

## Pull request flow

1. Fork or branch off `main`.
2. Make the change. Keep commits focused (one logical change per
   commit is ideal but not required for small PRs).
3. Run `node js/run-tests.js` locally. CI runs the same on every push.
4. Open the PR with a description that answers "what changed and
   why." A test plan or repro for bug fixes is appreciated.

For demo PRs specifically, ship the human-authored `.agent-prompt.md`
with whatever the agent produced. The prompt is the durable record
of intent and the only way the next regeneration stays coherent.

## Reporting bugs / requesting features

Open an issue on GitHub:
[github.com/Tao-Ma/lazytui/issues](https://github.com/Tao-Ma/lazytui/issues).

Include the lazytui commit, your OS / Node version, and
a minimal repro YAML if relevant. For framework bugs, include the
output of `bin/lazytui your-config.yml --list` so it's clear which
actions the parser saw.

## Discussion

For design questions or "is this the right shape for X" type
conversations, GitHub Issues with the `discussion` label is fine
for now. A separate forum can come later if it earns its keep.
