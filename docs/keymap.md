# Configurable keybindings (`keymap:`)

The `keymap:` block in your config remaps **normal-mode single keys**. It is a
thin, versioned container; the bindings inside read like the thought —
*"this key does this verb."* It may also live in the global user config
(`~/.config/lazytui/config.yml`, [global-config.md](global-config.md)):
global bindings apply in every project, merged per key under the project's
own `keymap:`.

```yaml
keymap:
  version: 1            # format version (see "Versioning" below)
  normal:               # normal-mode single-key bindings
    F: refresh          # bare string  = a built-in verb (`F` is free)
    "?": show_help
    g: { action: grep } # mapping form = an action / command target
    ",": noop           # disable a default binding
```

> **Discover the vocabulary:** run `lazytui --keymap [config.yml]` — it prints
> every verb with a one-line summary, the reserved keys, and the **effective**
> bindings (defaults ⊕ the global user config ⊕ your config). That dump is
> generated from the same source the app dispatches from, so it is always
> current. Prefer it over this list.

## Binding forms

A value under `normal:` is one of:

| Form | Meaning |
|------|---------|
| `key: verb` | a built-in **verb** (bare string) — the common case |
| `key: { builtin: verb }` | the same, explicit |
| `key: { action: <short-key> }` | run a configured **action** (its `$1` prompt, etc.) |
| `key: { command: <name> }` | run a `:`-cmdline **command** |
| `key: noop` | **disable** a default binding |

To **move** a verb to a different key, bind the new key and `noop` the old one:

```yaml
keymap:
  normal:
    F: refresh          # bind the new key
    r: noop             # disable the old default
```

## Verbs

Run `--keymap` for the authoritative, always-current list with summaries. As of
format v1 the built-in verbs are: `refresh`, `show_help`, `page_up`,
`page_down`, `goto_top`, `goto_bottom`, `register`, `cmdline`, `copy_mode`,
`edit_args`, `action_palette`, `repeat_run`. (Plus any of your config's
actions via `{ action: … }` and commands via `{ command: … }`.)

**`repeat_run`** (default `R`) re-invokes the last `type:run` action
through the standard invoke path — confirm fires again (repeat never
bypasses the gate), the ports form opens again if required or if any
field was collected on the first run (pre-filled by the `[last]`
chip), and ports declared `remember: false` come up blank so secret-
ish ports never auto-replay. The slot is session-scoped (cleared on
`set_config`) and session-persistent (survives tab switches, group
switches, pane focus moves). Only `type:run` actions are recorded —
`type:spawn` terminal panes and other non-run actions are not. If the
slot is empty or the remembered `group:action` no longer resolves, a
transcript notice fires and nothing runs.

The **fuzzy action palette** (`action_palette`, default `p`) opens a
centered type-to-jump list of every `group:action`. Narrow by typing
(matches on path AND label, case-insensitive, order-preserving); `↑/↓`
nav; `Enter` invokes the selected action through the standard invoke
path (same confirm gate / missing-required prompting / ports form as
selecting it in the actions pane); `Esc` is two-step while a filter is
non-empty — first `Esc` clears the filter, second `Esc` closes. The
walker is the same `iterActions` that `--list` and `--complete` use,
so the palette can never drift from what the CLI sees.

## Reserved keys

Keys whose behavior **branches on focus or mode** stay built-in and **cannot be
remapped** — binding one is a boot error that names the remappable keys. These
include the navigation keys (`j k h l` / arrows), `return`, `escape`, `x`, `T`,
`v`, `*`, `<space>` (the leader), the view-resize keys `+` / `_`, the tab keys
`[` / `]` (they fork to the groups quick-tab), and `/` (the content panes claim
it for search). Run `--keymap` for the exact set.

A key not listed as reserved and not a built-in default is **free** — bind it to
anything (e.g. `C: cmdline`).

## Relationship to `keys:`

`keys:` is a **separate** block for **leader chords** (`<leader>g g`, etc.).
`keymap:` is for **normal-mode single keys**. They don't overlap; a future
format version may fold leader chords under `keymap.leader`.

## Versioning

`keymap.version` lets the format evolve without breaking your config. The policy
matches the session-log schema (no hard fail):

- **missing** → treated as the current version;
- **older** than this build → loaded best-effort;
- **newer** than this build → loaded best-effort with a loud warning (some keys
  may be ignored).

## Errors

Bad bindings are reported at boot as actionable messages (and the binding is
skipped — the app still starts):

- unknown verb → names the valid verbs (and the likely typo);
- reserved key → names the remappable keys;
- malformed value → shows the expected shape;
- empty or whitespace-containing key → flagged (not a pressable key);
- multi-character key (`gg`, `Rx`, or a named key like `paste`) → flagged (not a
  single key) — normal-mode bindings are single keys; chords go in `keys:`;
- an `action:` target that doesn't resolve → flagged as a silent no-op.

A `command:` target is **not** checked at boot — the command registry is
state-derived (it varies by group), so a static check would mis-warn. A typo'd
command is a silent no-op at invoke time; verify it with `--keymap` and by
running the command from `:`.
