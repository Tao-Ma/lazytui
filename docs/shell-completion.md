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

## On-disk TTL cache (v0.6.43-unreleased)

The `--complete` helper is a one-shot process — the v0.6.41 model-resident `choicesCache` (stale-while-refetch for the TUI) is invisible to it. Without a store that outlives the process, every TAB press respawns `choices_cmd:` and pays up to the port's `choices_timeout` (default 5000ms, max 60000ms) each time. Example pain: `./do session worktree <repo> <TAB>` on dev9 fires `docker exec ... git branch` per press.

Fix: a per-config on-disk LRU TTL cache sitting between the helper and `choices_cmd:`. A hit within the TTL (default **15 seconds**) prints cached items and skips the spawn.

**Shape**
- Path: `$XDG_CACHE_HOME/lazytui/complete/<sha1-of-realpath>.json` (fallback `~/.cache/lazytui/complete/...`).
- Directory permissions: 0700. File permissions: 0600.
- Atomic write: tmp + rename (never a partially-written file).
- LRU cap: 64 entries per cache file (one per `(actionKey, port, source, deps-hash)` key).
- Key shape: `${actionKey}|${port}|${source}|${depsHash}` where `source` is `cmd:<cmd>`. Dep values go into `depsHash` so same-port fetches with different deps (worktree.branch for repo A vs repo B) stay apart.

**Never cached**
- Timeouts (`[timeout]` chip equivalent) — a timeout is "the author's command was too slow", caching it would pin the slow outcome. Next TAB retries fresh.
- Non-zero exits / errors — same reasoning.
- Empty item lists — an empty result is often transient (dep not yet filled), caching it hides the real list when it lands.

**Escape hatch**

```sh
LAZYTUI_COMPLETE_NO_CACHE=1 ./do session worktree <repo> <TAB>
```

Skips both read AND write. Use this when debugging an edited `choices_cmd:` so the 15s stale window doesn't hide the change, or when you specifically want to measure a cold spawn. The env var is only consulted by the completion helper; the TUI's own cache is unaffected.

**Concurrent writers (last-rename-wins)**

Two shells both TAB the same config at the same instant: both the `--complete` processes read the same cache state S, both compute an independent put of a different key, both tmp+rename. The second rename overwrites the first writer's new entry. Each process sees its own key on the next TAB; neither sees the other's.

Not corruption (atomic tmp+rename rules out a half-written file) and not an exploit — one of the two keys is just missing until a later TAB respawns it. The common case (one user, one shell) is unaffected. If you consistently share a config between many parallel shells and some entries seem to disappear, that's this.

**Cache invalidation = you**

The cache is **time-bounded only** — no mtime watch on the config, no SIGUSR trigger, no file-watcher. If you need an immediate retry on an edited `choices_cmd:` without waiting out the TTL, either set `LAZYTUI_COMPLETE_NO_CACHE=1` for the next TAB, or wipe the cache file by hand (`rm "$XDG_CACHE_HOME/lazytui/complete/<sha1>.json"`).

**Shared with the TUI**

The key derivation (`js/leaves/ports/choices-cache-key.js`) is shared between this on-disk cache and the TUI's `_cacheKeyFor` so the two hash to byte-identical keys. The STORES stay separate (model-resident for TUI, process-local for CLI) because the TUI needs WAL-replay determinism and the CLI helper has no model to carry — but the key format is a convergence point for future unification.

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
