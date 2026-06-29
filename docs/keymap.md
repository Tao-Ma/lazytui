# Configurable keybindings (`keymap:`)

The `keymap:` block in your config remaps **normal-mode single keys**. It is a
thin, versioned container; the bindings inside read like the thought —
*"this key does this verb."*

```yaml
keymap:
  version: 1            # format version (see "Versioning" below)
  normal:               # normal-mode single-key bindings
    R: refresh          # bare string  = a built-in verb
    "?": show_help
    g: { action: grep } # mapping form = an action / command target
    ",": noop           # disable a default binding
```

> **Discover the vocabulary:** run `lazytui --keymap [config.yml]` — it prints
> every verb with a one-line summary, the reserved keys, and the **effective**
> bindings (defaults ⊕ your config). That dump is generated from the same source
> the app dispatches from, so it is always current. Prefer it over this list.

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
    R: refresh
    r: noop
```

## Verbs

Run `--keymap` for the authoritative, always-current list with summaries. As of
format v1 the built-in verbs are: `refresh`, `show_help`, `page_up`,
`page_down`, `goto_top`, `goto_bottom`, `register`, `cmdline`, `copy_mode`.
(Plus any of your config's actions via `{ action: … }` and commands via
`{ command: … }`.)

## Reserved keys

Keys whose behavior **branches on focus or mode** stay built-in and **cannot be
remapped** — binding one is a boot error that names the remappable keys. These
include the navigation keys (`j k h l` / arrows), `return`, `escape`, `x`, `T`,
`v`, `*`, `<space>` (the leader), the view-resize keys `+` / `_`, the tab keys
`[` / `]` (they fork to the groups quick-tab), and `/` (the viewer claims it for
search). Run `--keymap` for the exact set.

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
- an `action:` target that doesn't resolve → flagged as a silent no-op.

A `command:` target is **not** checked at boot — the command registry is
state-derived (it varies by group), so a static check would mis-warn. A typo'd
command is a silent no-op at invoke time; verify it with `--keymap` and by
running the command from `:`.
