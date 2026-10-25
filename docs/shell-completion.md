# Shell tab-completion

**Status:** shipped — v0.6.39.

The YAML carries everything tab-completion needs: group paths, action keys, port declaration order, and (since v0.6.36) `choices_cmd:` commands that enumerate valid values at runtime. Two flags make the CLI an equal citizen with the TUI:

- `--completion bash|zsh [--cmd <name>]` — print a completion script to stdout.
- `--complete <cword> -- <word1> <word2> …` — dynamic candidate helper (integration flag).

## Install

### bash

```bash
# One-shot (current shell only):
eval "$(./do --completion bash --cmd ./do)"

# Persistent:
./do --completion bash --cmd ./do >> ~/.bashrc
```

### zsh

```zsh
# One-shot:
eval "$(./do --completion zsh --cmd ./do)"

# Persistent (add to .zshrc BEFORE compinit, or source after it fires):
./do --completion zsh --cmd ./do >> ~/.zshrc
```

The generated script is deliberately dumb — it just collects the current words and calls back to `--complete`. It contains **no absolute paths**: tool resolution happens through `--cmd`'s literal name, so your wrapper handles `node` / `NODE_PATH` / config location exactly as it does for every other invocation.

## What gets completed

```
./do <TAB>              # group paths (incl. dotted subgroups: config.branch)
./do svc <TAB>          # action keys under group `svc`
./do svc restart <TAB>  # positional 1 for `svc:restart` — runs the port's choices_cmd
./do svc exec alpha <TAB>  # positional 2 — binds `container=alpha` for `cmd`'s choices_cmd
```

For each positional, the completer runs the port's `choices_cmd:` with:

- **cwd** = the component's `project_dir` (same as the action's `script:`).
- **env** = parent env + all earlier positionals bound to their port names verbatim. This is strictly more useful than binding only `depends_on:` — the words are sitting there and your command may want them.
- **Shadow-named ports** (`PATH`, `LD_PRELOAD`, `BASH_FUNC_*`, …) are silently dropped from the env (same denylist as `--exec` and the TUI).
- **Timeout** = `min(choices_timeout, 2500ms)`. Tighter than the TUI's 5000ms default — a hung TAB freezes your prompt, which is worse than missing candidates. On timeout: no output, exit 0.
- **Items cap** = 32 (same as the TUI popover; humans realistically scan ≤ ~32 items).
- **`choices_labeled: true`** → values only. Labels are TUI popover UX; TAB inserts the value you'd actually submit.

## Wrapper convention

If you have a wrapper script (`./do`, `./myproject`, etc.) that forwards to the entry point, make sure it also forwards `--completion` and `--complete` verbatim — same as it forwards `--list` or `--exec`:

```bash
#!/usr/bin/env bash
# dev9's `./do` wrapper, abbreviated
exec node tui.js config.yml "$@"
```

The `"$@"` passthrough is enough; no special handling for the two new flags.

## Error handling

**Completion must stay silent during TAB.** The `--complete` helper:
- Always exits 0 (even on config load errors, spawn failures, timeouts).
- Prints nothing to stderr.
- Prints nothing to stdout on any error.

If completion seems to not work:
1. Verify the script is sourced: `complete -p ./do` (bash) or `compdef | grep ./do` (zsh).
2. Run `./do --complete 1 -- ./do ""` manually and check for empty output / errors.
3. Check the config loads: `./do config.yml --list` should work.

## Trust

Shell completion runs config-declared shell commands — the same trust bar as `--exec` against that config. Someone completing against a config they wouldn't run has already lost: the choices commands have the author's full shell power at the author's chosen `project_dir`. This is intentional — the mechanism is useless without it, and the author's YAML wrote the command.

Three deltas vs `--exec` worth naming before you install completion for a config you didn't write (think: AI-generated configs, templates downloaded from the web, config inherited from a prior maintainer):

- **Firing frequency** — TAB fires on every exploratory press. A `choices_cmd:` with side effects (writes a log, counts an invocation, pings a telemetry endpoint) runs many times during a session, not once per deliberate action.
- **Pre-commitment** — typing `./do bad-group ba<TAB>` has not committed to running the action; the choices command still fires. An attacker who got their YAML into a user's config can run their payload without the user ever hitting Enter.
- **Privilege** — `sudo ./do <TAB>` runs completion as root if completion is installed in the invoking shell. The user is already escalated at this point, but it's easy to forget the choices commands now carry root.

If any of those matter for your config, review the YAML's `choices_cmd:` lines before installing completion.

### Process-group escape (`setsid`/`disown`/`nohup`)

Timeouts send `SIGTERM` to the choices_cmd's process group (`detached: true` + `process.kill(-pid)`). Grand-children inherit the group and die with it — EXCEPT when the command explicitly escapes: `setsid long-binary`, `nohup long-cmd &`, `(long-cmd &)`, `disown` all put the child in a different pgroup that the timeout kill can't reach. Those processes orphan to PID 1 and keep running until they finish naturally. Same pitfall as the TUI's `choices_cmd:` runtime; don't `setsid`/`disown` from inside a `choices_cmd:`.

## Not supported

- **`choices_fn:`** → Components aren't booted in CLI mode (they'd need a full TUI-mode boot). TAB-completion for a `choices_fn:` port emits nothing; the shell falls back to default/file completion. This is documented behavior, not a bug — switch the port to `choices_cmd:` if you want CLI parity.
- **Windows** → same posture as the process-group kill in the TUI's `choices_cmd:` runtime: POSIX only.

## Companion: missing-required errors surface valid choices

When you `--exec` an action and forget a required port, the error output now includes a `valid <port>: a, b, c` line if that port has a `choices_cmd:`:

```
$ ./do svc:restart
tui --exec: missing required port(s): name
  usage: --exec svc:restart <name>
  valid name: nginx, sshd
```

Same 2.5s timeout and same semantics as TAB completion. Ports without `choices_cmd:` get no additional line (silent).
