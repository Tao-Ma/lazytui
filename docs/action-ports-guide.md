# Action ports — a guide for component authors (humans and AI)

**Status:** shipped — slice 1 (v0.6.34) + slice 2 (v0.6.35) + slice 3 (v0.6.36) + literal `choices:` (`[Unreleased]`). The multi-field form is live for any action with 2+ declared `ports.in`; actions with a single port keep the pre-slice-1 one-field popup. **Computed choices (`choices_fn:` + `depends_on:`)** ship in slice 2 — see the "Computed choices" section. **Shell-backed choices (`choices_cmd:` + `choices_labeled:` + `choices_timeout:`)** ship in slice 3 — see the "Shell-backed choices" section. **Static literal choices (`choices:`)** ship under `[Unreleased]` — see the "Literal choices" section (the static sibling of the two dynamic channels). The review page + section grouping are planned follow-ups and are flagged inline below.

**For:** anyone writing a lazytui component or shell action — including AI assistants generating them. If you declare `ports.in` on an action, this doc tells you how your choices will render in the invoke-time form and how they'll bind at run time. The authoritative reference for the dataflow mechanics stays in [`docs/ports-and-wires.md`](ports-and-wires.md).

---

## tl;dr for the AI author

When you write a `type: run` action that needs user input, declare its inputs as named typed ports:

```yaml
provision-node:
  type: run
  label: Provision node
  script: |
    ssh "$host" sudo provision --role "$role" --port "$port"
  ports:
    in:
      host:
        type: string
        required: true
        desc: target hostname
      role:
        type: string
        required: true
        desc: node role (worker | control | storage)
        default: worker
      port:
        type: number
        required: false
        default: 22
        desc: SSH port
```

That is enough for the TUI to:
- open a labeled, multi-field form when the user invokes the action,
- pre-fill `role` with `worker` and `port` with `22`,
- block run until `host` is filled,
- bind the typed values to the shell as `$host` / `$role` / `$port`.

The rest of this doc explains *why* each of those keys matters and how to design them well.

---

## The one-paragraph mental model

An action's `ports.in` is a **map of named typed inputs**. Each input is **resolved** at invoke time via `inject > wire > default > error`. If every required input resolves, the action runs; its resolved values bind to the shell's env (`$name`) for `script:` actions or fill `{{name}}` holes for `run:` argv actions. If any required input is unresolved, the TUI opens the invoke-time form, lets the user fill the missing values, and re-runs resolution. **You don't write the form.** You describe the ports; the form falls out of the description.

---

## The schema, key by key

Each entry in `ports.in` is `{ name: { ...decl } }` where `name` is a strict identifier (`[A-Za-z_][A-Za-z0-9_]*`) — it binds as a POSIX env var on shell actions and as a `{{name}}` hole in argv actions, so hyphens and dots are rejected.

| Key | Type | Default | What it does |
|---|---|---|---|
| `type` | string | required | The port's declared type — `string`, `number`, `path`, or a domain tag like `pg.lsn`. **Advisory in slice 1** — the resolver treats the value as a string (bind-parameter model); `type` is author documentation + a hook for wire-compatibility checks and form widgets planned in a later slice. |
| `required` | bool | `true` | If false, resolution can complete without this value and the shell receives an unset env var; if true, running the action without a resolved value re-opens the invoke-time popup. The form does not block Enter on an empty required field — submit emits do_run and the resolver re-triggers the prompt. |
| `default` | string \| number | — | Pre-fills the field in the form and lets the resolver fall back when nothing upstream supplies the value. **Not type-checked in slice 1** — the raw literal is stringified and used as-is. |
| `desc` | string | `''` | One-line hint. Rendered under the field name in the form; keep it ≤ 60 chars for narrow terminals. |
| `choices` | list | — | (planned) Static enum of allowed values; renders as inline cycle or popover depending on list length. |
| `choices` | list | — | Static list of valid values. Each entry is either a scalar (string / number / boolean coerced to string) or a `{value, label}` map (label shown in the TUI popover; `value` is submitted). No shell, no timeout. Mutually exclusive with `choices_fn:` / `choices_cmd:` — setting both is a parse error. See "Literal choices" below. |
| `choices_fn` | string | — | Dotted ref `<component>.<fnName>` to a registered function the component ships; the fn returns the choices list at invoke time. Reachable only from Components / feature plugins (JS). See "Computed choices" below. |
| `choices_cmd` | string | — | Shell command whose stdout provides the choices list at invoke time (one choice per line). Reachable from pure YAML. Mutually exclusive with `choices_fn:` / `choices:` — setting multiple is a parse error. See "Shell-backed choices" below. |
| `choices_labeled` | bool | `false` | Only with `choices_cmd:`. When `true`, each output line is split on the first `\t` into `value\tlabel`; the overlay shows `label`, submits `value`. |
| `choices_timeout` | int (ms) | `5000` | Only with `choices_cmd:`. Hard timeout for the shell command; SIGTERM at expiry → `[timeout]` chip. Max 60000. |
| `depends_on` | list | — | Sibling port names this port's `choices_fn:` / `choices_cmd:` reads. Edits to a depended-on port, on blur, trigger a reactive refetch. For `choices_cmd:`, dep values are bound onto the child env (port name → env var, verbatim). |
| `section` | string | — | (planned) Logical grouping for actions with 10+ ports. |

Unknown port-level keys are **not** rejected at config load today — they're
silently ignored by the reducer. Future validation will enforce the schema; for
now, typos pass through quietly, so proofread.

---

## How your choices render in the form

The form groups fields by requiredness, required first:

```
╭──Provision node──────────────────────────────────────────────────────╮
│  Required                                                            │
│  host > ▊                                                  [unset]   │
│         target hostname                                              │
│  role   worker                                             [default] │
│         node role (worker|control|…)                                 │
│                                                                      │
│  Optional                                                            │
│  port   22                                                 [default] │
│         SSH port                                                     │
│                                                                      │
│[tab] next   [shift-tab] prev   [enter] run   [esc] cancel            │
╰──────────────────────────────────────────────────────────────────────╯
```

- The **Required** header appears only if some port is required; **Optional** only if some port isn't. All-required or all-optional actions get a flat list.
- Field order within each section mirrors declaration order (your YAML order wins).
- The port's `name` is the left-column label — pick names that read well there. `source_url` beats `src`.
- `desc` is a dim one-liner under the input. Users scan it; don't repeat the port name.
- Chips: `[default]` when text equals the declared default; `[modified]` when edited; `[unset]` when empty and no default.
- An action with **exactly one** declared port opens the lean single-field `fabric-field` popup instead — no form chrome. Design one-port actions with that in mind: a long `desc` has room to breathe. **Exception:** a one-port action whose port declares any of `choices:` / `choices_fn:` / `choices_cmd:` opens the (one-field) form instead so the choices chip and `[space]` popover are reachable — the lean popup has no choices machinery. The fetch fires on invoke-time form-open, so `confirm:` + `choices_cmd:` on a 1-port action still runs the choices command between the confirm accept and the script spawn (see "Shells at form-open time: `confirm:` does NOT gate `choices_cmd:`" below).

---

## Naming — what makes a good port name

A port name is **three things at once**: a form label, an env var, and (potentially) a wire address. The best names read well in all three contexts.

Good:
```
host  port  user  role  region  database  table_name  dry_run
```

Avoid:
```
h  p  u                          # too terse — meaningless as labels
hostName                          # mixed case trips posix env conventions
input_1  arg0                     # positional thinking leaks into the schema
the_host_to_connect_to            # over-explains; put explanation in `desc:`
```

Rules the config loader enforces:
- `^[A-Za-z_][A-Za-z0-9_]*$` — identifier only; no hyphens, no dots.
- Reserved names: avoid any env-var the shell already uses (`PATH`, `HOME`, `SHELL`, …) unless you mean to shadow them.

Rules we recommend:
- `snake_case` for consistency with the shell env binding.
- Nouns, not verbs: `source_file`, not `use_source_file`.
- Singular when a port holds one value; plural when it holds a list.

---

## Required vs optional — when to pick which

**Required** is for inputs the action **can't do anything useful without**. If a sensible default exists, prefer `required: false` + `default:`. A sensible default beats a mandatory prompt every time — the user sees your action in the invoke-time popup as "fill these two things in; the rest I've already picked for you."

Rule of thumb:
- Can the action succeed if this is empty? → `required: false`.
- Does the action have a safe default that's right for ≥50% of invocations? → `required: false` + `default:`.
- Does the user HAVE to type something before you can begin? → `required: true`.

A tiny worked example:

```yaml
# BAD — four required prompts for a diagnose action
diagnose:
  type: run
  script: diagnose "$host" --port "$port" --timeout "$timeout" --verbose "$verbose"
  ports:
    in:
      host:    { type: string, required: true,  desc: target host }
      port:    { type: number, required: true,  desc: port }
      timeout: { type: number, required: true,  desc: timeout seconds }
      verbose: { type: bool,   required: true,  desc: verbose mode }

# GOOD — one required prompt, three sensible defaults
diagnose:
  type: run
  script: diagnose "$host" --port "$port" --timeout "$timeout" --verbose "$verbose"
  ports:
    in:
      host:    { type: string, required: true,  desc: target host }
      port:    { type: number, required: false, default: 22,    desc: SSH port }
      timeout: { type: number, required: false, default: 30,    desc: timeout seconds }
      verbose: { type: bool,   required: false, default: false, desc: verbose output }
```

The `GOOD` version opens the form with 4 fields — the user hits `host`, types a value, and presses Enter. The 3 optionals ride along at their defaults and are discoverable without being in the way.

---

## Defaults — how they resolve

Resolution order (from `docs/ports-and-wires.md` §resolution):

```
inject  >  wire  >  default  >  (required ? error : omit)
```

So a `default:` only kicks in when **nothing upstream wrote** the value — no sticky inject on the port, no wire feeding it. The form shows the default pre-filled, and the chip reads `[default]` to make that fact visible. If the user types over it, the chip flips to `[modified]`. Backspace trims; `Ctrl+U` clears the focused field (and if the port has a default, the empty state renders as `[modified]` — an explicit blank the resolver honors). Reset-to-default on a hotkey is a planned follow-up slice.

A port with `required: false` and no `default:` is treated as "may be unset" — the resolver returns no value, and the shell receives an empty env var. Script that doesn't tolerate empty vars should either declare a default or be rewritten (`"${timeout:-30}"`).

---

## `desc` — one line, scanned-for-truth

The description renders dim under the field name. It's the user's one chance to understand what to type without reading your YAML. Rules:

- One line. If you need two sentences, your port is doing too much.
- ≤ 60 characters so it survives on a narrow terminal without truncation.
- Describe **what the value is**, not what the action will do with it.
- Mention the valid shape ("worker | control", "ms", "YYYY-MM-DD") when the type doesn't make it obvious.

```yaml
# BAD
role: { type: string, required: true,
        desc: "the role the node will take on in the cluster" }

# GOOD
role: { type: string, required: true,
        desc: "node role (worker | control | storage)" }
```

Static `choices:` now ships — see the "Literal choices" section below. For a fixed, author-known enum, prefer the literal form over listing it in `desc`. (If the enum is dynamic, see "Computed choices" or "Shell-backed choices" below.)

---

## Shell vs argv — the binding boundary

Two action shapes consume `ports.in`:

**Shell (`script:`)** — the resolved values are bound as **env vars** on the child process. Your script references them as `"$name"` (always quoted). No shell parsing of the user's input happens before the quote; bytes arrive literally.

```yaml
script: |
  ssh "$host" sudo provision --role "$role"
```

**Argv (`run:`)** — the resolved values fill `{{name}}` holes in the argv list. No shell is involved; `execve` runs the resulting argv.

```yaml
run: [ssh, "{{host}}", sudo, provision, --role, "{{role}}"]
```

In both cases, the user's typed input is **data, not code**. Don't try to be clever — don't write `script: $script_body` and expect the user to paste an interpolated template.

---

## Common patterns

### A ping-with-count

```yaml
ping-host:
  type: run
  label: Ping host
  script: ping -c "$count" "$host"
  ports:
    in:
      host:  { type: string, required: true, desc: hostname or IP }
      count: { type: number, required: false, default: 4, desc: number of echo requests }
```

### A migration with a confirm flag

```yaml
run-migration:
  type: run
  label: Run DB migration
  script: migrate --db "$db" --to "$version" ${dry_run:+--dry-run}
  ports:
    in:
      db:       { type: string, required: true,  desc: target database }
      version:  { type: string, required: true,  desc: migration version id }
      dry_run:  { type: bool,   required: false, default: true,
                  desc: show planned changes without executing }
```

Note the `${dry_run:+--dry-run}` pattern — the env var's presence toggles the flag, so the type stays a bool at the user level while the shell translates it to the flag's presence/absence.

### An exporter with a long default

```yaml
export:
  type: run
  label: Export rows
  script: pg_export --conn "$conn" --query "$query" --out "$out"
  ports:
    in:
      conn:  { type: string, required: true,  desc: postgres conn string }
      query: { type: string, required: false,
               default: "SELECT * FROM events WHERE ts > now() - interval '1 day'",
               desc: SQL to run }
      out:   { type: string, required: false, default: "/tmp/export.csv",
               desc: output path }
```

The long default renders truncated with `…` in the form; the user sees `[default]` and knows they can hit `d` to inspect / Tab to edit.

---

## Anti-patterns

### Positional thinking leaking in

```yaml
# BAD — positional names
ports:
  in:
    arg0: { type: string, required: true }
    arg1: { type: number, required: true }
    arg2: { type: bool,   required: false }
```

Positional args were the old `args:` model (retired in v0.6.30). Names ARE the UI. `arg0` tells the user nothing.

### Overloading one port with structured data

```yaml
# BAD — one port, two concerns
ports:
  in:
    host_and_port: { type: string, required: true, desc: "host:port" }
```

Split it: `host` + `port`. The form shows two labeled fields instead of a single opaque string the user has to construct correctly.

### Required with a default

```yaml
# BAD — redundant
ports:
  in:
    port: { type: number, required: true, default: 22 }
```

`required: true` means "the user must supply this"; `default: 22` means "if nothing supplies it, use 22." If 22 is acceptable, it's not required. Pick one.

### No `desc`

```yaml
# BAD
ports:
  in:
    tgt: { type: string, required: true }
```

A port with no `desc` renders a blank line under the input — the user has to guess what to type. If you can't write a one-liner for a port, your port name is wrong.

---

## Literal choices — `choices:`

Many ports take a value from a short fixed set the author already knows: a role name (`worker` / `control` / `storage`), a flag (`--full-tunnel` / `--no-full-tunnel`), a severity. For those, the author can declare the list inline — no shell, no fetch, no timeout:

```yaml
reissue:
  type: run
  script: ./issue-cert "$tunnel"
  ports:
    in:
      tunnel:
        type: string
        required: true
        choices:
          - { value: --full-tunnel,    label: all traffic via VPN }
          - { value: --no-full-tunnel, label: split tunnel (dev9net only) }
```

Each entry is either:

- A **scalar** (string, number, boolean) — stringified, no label. `choices: [nginx, sshd, postgres]`.
- A **`{value, label}` map** — the TUI popover shows `label`, submits `value`. `label` is optional (same as a scalar for that entry).

Mixed lists are allowed; scalar entries get `label: null`, map entries get their label.

Behavior:

- **TUI**: the field's choices chip reads `[N choices]` from the first frame — no `[fetching…]` transition. `[space]` opens the popover; selection writes the value. Free-typing still wins (same contract as the dynamic channels).
- **CLI `--complete`**: TAB offers the values directly (labeled maps → values only, matching the choices_cmd+labeled contract). No subprocess spawned.
- **CLI `--exec` missing-required**: the companion `valid <port>: ...` line lists the values when the port is omitted.
- **Cap**: 1024 entries (same as `choices_fn:`). Author-controlled list; past this, narrow the enum.

Mutual exclusion:

- `choices` + `choices_cmd` → **hard parse error.**
- `choices` + `choices_fn` → **hard parse error.**
- `choices` + `choices_labeled` / `choices_timeout` / `depends_on` → warn + drop the modifier (nothing to time out, nothing to re-fire on).

Use `choices:` for a fixed enum; use `choices_cmd:` or `choices_fn:` when the list depends on live state (fs, process, database).

---

## Computed choices — `choices_fn:` + `depends_on:`

Some port values are enumerable but the author can't hard-code the list. The valid section names of an edit target depend on which file. The valid branches of a repo depend on which repo. The valid tables of a database depend on which connection. The list belongs *in code*, computed per invocation.

Declare it like this:

```yaml
edit-section:
  type: run
  script: |
    sed -i "/^## $section/,/^## /c\\$new_body" "$file"
  ports:
    in:
      file:
        type: path
        required: true
        desc: target markdown file
      section:
        type: string
        required: true
        desc: section heading to replace
        choices_fn: edit.sections_of     # ← dotted ref: <component>.<fnName>
        depends_on: [file]                # ← ports this fn's result depends on
      new_body:
        type: string
        required: true
```

Then in the component (any Component or feature plugin that ships `name:`):

```js
'use strict';
const fs = require('fs');

module.exports = {
  name: 'edit',
  groupActions: { /* ... */ },
  choicesFns: {
    // ctx: { values, actionKey, group, signal }
    //   values   — resolved values of the depended-on ports
    //   signal   — AbortSignal; a dep change / form close aborts you
    // return  : string[]  OR  { items: string[], labels?: string[], error?: string }
    //           sync, or a Promise of the same
    sections_of: async ({ values, signal }) => {
      const src = await fs.promises.readFile(values.file, 'utf8');
      if (signal.aborted) return [];
      return src.split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(3));
    },
  },
};
```

What the user sees:

1. Open the form — the computed field's chip reads `[fetching…]` while the fn is in flight; `[N choices]` once ok; `[error]` if the fn threw or rejected.
2. `[space]` on the focused computed field opens an inline popover under the row. Up/Down highlight; Enter picks; Esc closes without picking. The user can also type freely — the choices are a shortcut, never a hard constraint.
3. Tab away from a depended-on port after editing it — the computed field refetches on blur. Tabbing away without editing the dep is a no-op (no flicker).

A few rules the parser enforces (warn+drop, not throw — your YAML keeps loading on upgrade):

- `choices_fn` must be a dotted ref `<component>.<fnName>`. A bare name or anything else is dropped at load.
- `depends_on` must be a list of sibling port names. Entries that aren't strings, aren't declared, or reference the port itself are dropped.
- An unknown ref at run time paints `[error]` on the field with a message pointing to the unregistered name.
- The returned list is capped at 1024 items on **landing** (anything past that is dropped from the WAL + overlay) and the popover paints a `[+more…]` row so you know the cap applied. The cap doesn't limit how much your fn *allocates* — if your fn builds a 10M-item array before returning it, you still pay that cost in your own code; the cap only prevents the overlay/replay-log blowup. Design your fn to short-circuit if the enumeration is unbounded.
- Row-breaking characters (`\n`, `\t`, `\r`) are replaced with a single space in items, labels, and the error text. The overlay is one-row-per-item, so a raw newline would otherwise corrupt the paint. If you need multi-line error context, log it elsewhere and return a one-line summary.

Three things worth knowing before you ship a `choices_fn`:

- **SPACE on a plain port is still a literal space.** The space-opens-popover affordance fires only when the focused field has a `choices_fn:`; any other port treats the key as text input, preserving pre-slice-2 behavior.
- **The returned strings pass through to the overlay AS-IS.** `esc()` neutralizes bracket markup like `[reverse]`, but raw ANSI SGR escape bytes (`\x1b[31m…`) are preserved and render colored in the popover. Treat return values as display content you own — if the fn's upstream is untrusted, strip SGR before returning.
- **The fn is a shortcut, not a hard constraint.** The user can always free-type a value that isn't in the choices list, and that value binds like any other port value at submit time.
- **A port can carry both a `choices_fn:` and an incoming wire.** The wire pre-fills the form field at open, and the user's choice overrides via a one-shot inject (`inject > wire > default` resolution precedence). The source badge on the ports pane shows the wire; the form doesn't surface it, so a user who picks from choices doesn't see the wire they're shadowing. Avoid this combination unless the override is intentional.

Replay stays deterministic. The fn is a side effect — the first live invocation goes through the `fetch_choices` effect channel; its *result* lands as a reducer arm whose payload is captured in the WAL. Replay reproduces frames from the recorded payload without re-executing the fn, so a fn that touches the fs or spawns a child is safe to use.

### When to pick which choices channel

- Static list, same for every invocation → `choices: [a, b, c]` (the "Literal choices" section above).
- List depends on another port's value, or on live state (fs, process, db), reachable from JS → `choices_fn: component.fnName` + `depends_on: [...]`.
- Same, but you're writing pure YAML (no Component) → `choices_cmd:` (next section).
- Need both a static list and dynamic enrichment → use `choices_fn:` and have the fn return a static array.

## Shell-backed choices — `choices_cmd:` + `choices_labeled:` + `choices_timeout:`

The YAML-reachable sibling of `choices_fn:`. Instead of registering a JS function on a Component, declare a shell command whose stdout feeds the choices list — same effect channel, same `[fetching…]` / `[N choices]` / `[error]` / `[timeout]` chips, same popover (with a trailing `[+more…]` row if the result overflows the cap), same free-type-always-wins guarantee. Use this when you're writing pure YAML components (no project JS plugin loader exists).

```yaml
actions:
  inspect:
    label: Inspect container
    script: docker exec -it "$container" sh
    ports:
      in:
        container:
          type: string
          required: true
          choices_cmd: "docker ps --format '{{.Names}}'"
```

Open the form, chip reads `[fetching…]` while `docker ps` runs, then `[N choices]` once the list arrives. `[space]` opens the popover. This recipe is a **one-port** action — the lane rule above routes it through the (one-field) form so the chip + popover are reachable; `choices_cmd:` works on single-port actions and multi-port actions the same way.

Your `choices_cmd:` also powers CLI tab-completion (v0.6.39): typing `./do inspect <TAB>` runs the same command, same `project_dir` cwd, same env binding, same 32-item cap. Keep it fast (<2.5s — tighter cap than the TUI, since a hung TAB freezes the user's prompt) and side-effect-free (TAB may fire many times before an actual invocation). See [`shell-completion.md`](./shell-completion.md).

### Trust and shell binding

`choices_cmd:` runs through `sh -c <cmd>` at the same trust bar as action `script:` — if you can author the YAML you already have arbitrary shell. There is no sandbox. Design your commands as you would an action's `script:`.

The command runs in the component's `project_dir` (same cwd as the action's `script:`), so project-relative paths behave identically in both. The four recipes above assume this — e.g. `jq -r '.repos[].path' sessions.json` reads `sessions.json` from the component directory, same as if the action's script did it.

Dependent ports are bound onto the child env with the **port name as the env var name, verbatim**. The brief's worktree-branch recipe is the pattern:

```yaml
ports:
  in:
    repo:
      type: path
      required: true
      choices_cmd: "jq -r '.repos[].path' sessions.json"
    branch:
      type: string
      required: true
      choices_cmd: 'git -C "$repo" branch --format=%(refname:short)'
      depends_on: [repo]
```

The command sees `$repo` as a plain env var — no `{{repo}}` templating, no new quoting rules. Change `repo` in the form, tab away, and `branch` refetches with the new value.

### Env-shadow composition (why we recommend snake_case)

Port names that would shadow a security-sensitive env var (`PATH`, `SHELL`, `LD_PRELOAD`, `BASH_FUNC_*`, …) go through the same two-layer defense the run path uses: the parser warns at config load (`port.env_shadow`) and the runtime drops the binding at spawn. In practice: a lowercase `path` port binds harmlessly to `$path`; an uppercase `PATH` port warns on load and never reaches the child env. The snake_case recommendation is already in this doc; with `choices_cmd:` the convention quietly does security work for free — no new rule to learn.

The denylist today covers shell-level hijacks (`PATH`, `SHELL`, `LD_*`, `DYLD_*`, `BASH_ENV`, `ENV`, `BASH_FUNC_*`). It does **not** yet cover language-runtime hijack vars (`NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `PERL5LIB`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`). If your `choices_cmd:` or `script:` ever shells out to `node` / `python` / `perl` / `ruby` / `java`, prefer the lowercase convention or an explicit `_` suffix for dep ports whose names would land on one of those variables. Expanding the denylist to cover language runtimes is a planned follow-up.

### Output format

Default (`choices_labeled: false`): one line = one choice. CRLF normalized; blank lines dropped; literal tabs flattened to a single space (the overlay is one row per item, and a `\t` would emit a horizontal-tab escape that misaligns the next cell).

With `choices_labeled: true`: split each line on the FIRST `\t` into `value\tlabel`. The overlay shows `label`, submits `value`. A line without a tab means label falls back to value — convenient for mixed lists where some entries don't need a long label.

The popover is up/down + enter today (no filter). If you expect to add one later, keep the value text inside the label so a filter you'd want to type (`foo`) matches a visible label (`foo (expires 2027-01)`) rather than an invisible value.

### Cap: 32 items

`choices_cmd:` caps the choices list at **32 items** on landing (anything past is dropped and the popover paints a trailing `[+more…]` row). This is lower than `choices_fn:`'s cap (1024) for a reason: humans realistically scan ≤ ~32 items; past that the author's command is mis-shaped and should narrow at the shell (`grep`, `head`, filter) rather than lean on the overlay. The cap is a signal to the *author* to tighten the command, not an invitation for the user to scroll.

If your command regularly returns > 32 items, add filtering at the command — the four dev9 recipes (`docker ps` names, cert CNs, session nodes, `.ovpn` basenames) all fit comfortably because the shell owns the narrowing.

### Timeout: 5s default, per-port override

A `choices_cmd:` command gets 5 seconds by default; declare `choices_timeout:` (ms) on the port to override. Expiry sends SIGTERM to the whole process group (so `sh` wrapping `sleep` dies too) and shows `[timeout]` on the chip. Free-type always works.

Tune up for commands that legitimately run slow on a loaded host (`docker ps` on a dev-swarm, `kubectl get` with a slow API) — the fetch is async behind `[fetching…]`, so a generous timeout costs the user nothing. Keep it tight for commands that should return instantly (local fs globs, `jq` over a small file).

**Author warning — `setsid` / `disown` / `nohup &` escape the process group.** The timeout + abort path kills the SIGTERM-reachable process group, which covers `sh -c 'sleep 10'` and anything the shell spawns normally. A command that explicitly detaches (`setsid longthing &`, `nohup longthing &`, `(cmd &)` with its own session) escapes into a new session that SIGTERM cannot follow. The leak is low-practical-risk (realistic recipes don't detach) but a careless `setsid`/`nohup` leaves an orphan the user won't notice. If you need to invoke something that forks a long-lived helper, do it from an action `script:` with a kill lifecycle you control, not from `choices_cmd:`.

**Process-group kill is POSIX-only.** The handler uses `process.kill(-child.pid, SIGTERM)` to reach grand-children (shell-wrapped binaries). On Windows that call throws `EINVAL` and the fallback sends SIGTERM to just the shell — same propagation gap as before the fix. lazytui's declared targets are Linux/macOS; Windows is best-effort.

### Four recipes

```yaml
# 1. docker ps — zero deps, output set changes between invocations
inspect:
  script: docker exec -it "$container" sh
  ports: { in: { container: { type: string, required: true,
    choices_cmd: "docker ps --format '{{.Names}}'" } } }

# 2. Session node name — one command reused by six actions via YAML anchors
#    (declare the anchor on the first consumer, then reference it from the rest).
enable:
  script: 'session_ctl enable "$node"'
  ports:
    in:
      node: &node
        type: string
        required: true
        choices_cmd: "jq -r '.nodes[].name' sessions.json"
disable: { script: 'session_ctl disable "$node"', ports: { in: { node: *node } } }
remove:  { script: 'session_ctl remove  "$node"', ports: { in: { node: *node } } }
# …and so on for cmd / worktree-rm / worktree.repo — one anchor, six consumers.

# 3. Reissue CN — the command owns the filtering (the CA cert must not appear)
reissue:
  script: 'pki reissue "$cn"'
  ports:
    in:
      cn:
        type: string
        required: true
        choices_cmd: |
          ls pki/issued/ \
            | sed 's/\.crt$//' \
            | grep -v '^ca$'

# 4. .ovpn basenames — simplest fs-glob case
use:
  script: 'openvpn --config "client/$cert_name.ovpn"'
  ports:
    in:
      cert_name:
        type: string
        required: true
        choices_cmd: 'cd client && ls *.ovpn | sed "s/\.ovpn$//"'
```

### Error paths

Four ways `choices_cmd:` can land in a non-OK state:

- **Non-zero exit** → `[error]` chip with the exit code + up to 4 KiB of stderr in the diag log.
- **Timeout** → `[timeout]` chip; SIGTERM to the process group.
- **Overflow** → stdout past 1 MiB kills the child and lands as an `[error]` chip. Defensive against a runaway command (`cat /dev/urandom`) — well above anything a realistic choices command needs.
- **Spawn failure** (EACCES on an exec-forbidden mount, resource limits) → `[error]` chip with the spawn error message.

All error paths also write a `diag-log.error('choices_cmd', …)` entry; chip is UX, diag-log is the trail. See `:diag` in the TUI. Diag entries can contain stderr fragments that echo dep values back — if a port carries anything secret-shaped, be aware that error entries persist.

### A `choices_cmd:` port and a `[default]` chip

A port with a `default:` AND a `choices_cmd:` paints `[N choices]` (or `[fetching…]` / `[error]`) in preference to `[default]`, even when the field's text equals the declared default. The choices chip is more useful (shows the picker is live) but the author loses the "this is pre-filled from `default:`" affordance. If you need to label the default, carry it in `desc:` as the "default: …" hint.

### Shells at form-open time: `confirm:` does NOT gate `choices_cmd:`

Action `confirm:` gates the action's `script:` — not the choices_cmd that fires at form-open. If a user tabs to an action with `confirm: true`, the form opens and any choicesCmd on a required port runs immediately (same as `choices_fn:`'s behavior). Author trust bar is already "YAML write = full shell"; the asymmetry is worth noting so you don't put side-effecting shells in `choices_cmd:` and assume `confirm:` fences them off. If the choices command has a cost (an API call, a slow query), consider adding `depends_on:` on a cheap sibling port so the fetch doesn't fire until the user actually interacts.

## Known limitations

Two cases where the computed-choices surface currently falls short — both apply to `choices_fn:` AND `choices_cmd:`, and both are planned work for later slices, documented here so you can design around them:

- **Sticky-filled forms never open.** If every required port is already filled by a sticky inject (from a prior invocation's ports-pane edit) or a wire, the resolver reports `ready: true` and the form never opens — so the user can't reach the choices popover for a port that *would* have one. The `[a] edit args` keybind (listed under "Looking ahead" below) will open the form on demand even when every port is resolved; until it ships, a user who wants fresh choices has to clear the sticky inject via the ports pane first.
- **Wire-fed deps don't retrigger `choices_fn:` / `choices_cmd:` on new producer output.** The form snapshots a dep's text at open time; if a producer streams a fresh value to a wired dep after the form is up, the computed field keeps serving choices derived from the opened-at value. No reactive refetch fires until the user tabs through the dep (which, for a wire-fed field, they rarely do). A `wire_updated` subscription arm would fix this; it isn't in slice 3 either.

Neither case corrupts data — the submit path binds whatever's currently in the field — but both can leave the user looking at stale choices.

## Looking ahead

Slices after this one add the following, in rough order. All are purely additive — nothing in this doc goes stale.

- `choices: [...]` — static enum ports render as inline-cycle (short list) or anchored popover (long list), reusing the choices chip + popover rendering (now channel-agnostic) as the degenerate case.
- A review page before run — Enter from the form opens a read-only "about to run" screen with the resolved argv/env.
- A `[a] edit args` keybind on actions — opens the form even when nothing's missing, so the user can tweak defaults on a one-shot run.
- `section: '…'` — opt-in grouping key for 10+ port actions.

When any of those land, this doc gains a new section; existing guidance stays correct.

---

## See also

- [`docs/ports-and-wires.md`](ports-and-wires.md) — the fabric reference (ports, wires, injects, resolution, readiness).
- [`docs/msg-routes.md`](msg-routes.md) — the Msg-route catalog, including the `fabric_form_*` family that drives this overlay.
- [`js/overlay/fabric-form.js`](../js/overlay/fabric-form.js) — the overlay renderer; worth skimming if you're wondering exactly how your `desc` is laid out.
