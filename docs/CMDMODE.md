# `:` Command Mode

A modeline-style command bar (vim / k9s style) that resolves any panel,
item, action, or Component-supplied command from a single keystroke.
Replaces multi-step navigation with one fuzzy-matched name.

## UX

```
:work bro|              ← cursor; bottom row of the screen
  work browse  — Chrome with work VPN proxy        ← top match (highlighted)
  work logs    — tail work-vpn container logs
  work up      — start work VPN proxy
```

- `:` (in normal mode) enters cmdline mode. Bottom screen row becomes the
  prompt. A dropdown of up-to-N best matches floats above it.
- Type to filter. Backspace edits. `Tab` accepts the top match into the
  buffer (lets you keep refining).
- `↑` / `↓` move the dropdown selection.
- `Enter` runs the highlighted match.
- `Esc` cancels — leaves state unchanged.
- Empty buffer → dropdown shows recent / pinned / all (capped) so the user
  can browse.

## Candidate registry

The resolver walks four sources, in this order, and produces a flat list
of `{ name, desc, run() }` records:

| Source                      | Name              | Effect on Enter             |
|-----------------------------|-------------------|-----------------------------|
| Layout panels               | `<panel.title>`   | Focus that panel            |
| Items in current group's actions panel | `<action.label>` | Run the action |
| Items in any panel's `getItems()` (filtered by panel) | `<item display>` | Focus panel + select item |
| Component `commands` array  | `<cmd.name>`      | Call `cmd.run(args)`        |

### Disambiguation

- Names live in a **flat namespace**. The fuzzy ranker handles collisions
  by scoring; the dropdown shows the ambiguous matches and the user picks.
- For deterministic disambiguation users can prefix-qualify:
  `panel:name` (e.g. `actions:up`, `containers:dev9-env`). v1 ships
  fuzzy-only; the prefix grammar is reserved for a follow-up.

### Help text

Every candidate has a `desc` field (right column of the dropdown). Sources:
- Panel: `panel.title` (no desc — the name *is* the help)
- Action: action's `desc` field from YAML (already authored)
- Item: `getInfo()[0]` line stripped of markup, or `String(item)` fallback
- Component command: `command.desc`

No new authoring is required for anything that already exists in YAML.

## Component extension contract

Components extend the registry by exporting `commands`:

```javascript
// js/panel/foo.js
module.exports = {
  name: 'foo',
  init: () => ({ ... }),
  update: (msg, slice) => slice,
  panelTypes: { ... },

  // Static commands — array of { name, desc, run, args? }
  commands: [
    {
      name: 'foo refresh',
      desc: 'Refresh foo data',
      run: (args) => { /* ... */ },
    },
  ],

  // OR dynamic — function returning an array (called every cmdline open).
  // Use this when commands depend on runtime state (e.g. a list of
  // available themes, profiles, recent items).
  getCommands(model) {
    return THEMES.map(t => ({
      name: `theme ${t}`,
      desc: `Switch to ${t} theme`,
      run: () => setTheme(t),
    }));
  },
};
```

Both `commands` (static) and `getCommands(model)` (dynamic) are walked
by `api.getCommands()` and merged. Static is fine for fixed verbs;
dynamic is fine when the candidate list depends on state.

### Built-in commands (framework defaults)

| Name              | Effect                                       |
|-------------------|----------------------------------------------|
| `quit`            | Exit the TUI                                 |
| `refresh`         | Re-fan a refresh Msg to every Component      |
| `help`            | Show help text in detail panel               |
| `save-layout`     | Persist current panel layout to YAML         |
| `restore-layout`  | Reload panel layout from YAML                |
| `theme <name>`    | Switch theme (one entry per theme)           |
| `focus <panel>`   | Focus a panel (one entry per layout panel)   |
| `design`          | Open layout design mode (when `--design`)    |

These live in `panel/api.js#FRAMEWORK_COMMANDS` + a small
`_frameworkDynamicCommands` builder; they appear in the cmdline registry
with the source tag `<framework>`.

## YAML extension

The user's YAML extends the registry **passively**. Every action defined under
`groups.*.actions.*` is automatically a `:` candidate; its `desc` field
becomes the dropdown help line. No new schema.

### Positional args

The cmdline buffer splits at the first whitespace: the leading token
fuzzy-matches a registry entry; everything past it becomes positional
args. Both YAML actions and Component commands receive them — actions
via `sh -c "$script" -- arg1 arg2 ...` (so script bodies use `$1`,
`$@`, `${1:-default}`); Component commands via the documented
`run(args)`.

```yaml
tail:
  script: docker logs --tail "${1:-20}" tui-test-running
  type: run
  label: Tail logs
  args: "[lines]"     # display annotation in actions panel
```

`:tail` → 20 lines (default). `:tail 100` → 100 lines.

Whitespace-split only — no shell-style quoting in v1. Use the script
body to recombine if you need spaces inside a single argument.

**Two entry paths** for an `args:`-declared action:

- `:` cmdline — args ride inline (`:tail 50`)
- Actions panel + Enter — opens a prompt overlay (see `prompt.js`); the
  `args:` field is shown as the input spec, Enter submits the parsed
  list, Esc cancels. Same parsing rule (whitespace-split).

Empty submit (Enter with no input in the prompt) behaves like `:tail`
with no args — the script gets called with `$#=0`, so use
`${1:-default}` if you want a default value.

Out of scope for v1 (deferred until a real use case shows up):
- Top-level `commands:` block in the user's YAML for project-wide
  commands not tied to a group. Could be done as a thin wrapper that
  adds entries to the resolver via the same shape as Component
  `commands`.

## Architecture

```
┌─ dispatch.js ─────────────────────────────────────────┐
│  ':' in handleNormalKey → cmdline_enter Msg            │
│  modeChain: { active: () => cmdMode flag,              │
│               handler: handleCmdlineKey }              │
├─ cmdline.js ──────────────────────────────────────────┤
│  buildRegistry()              — walk panels/actions/   │
│                                  items/Component cmds  │
│  rebuild(text)                — fuzzy score + sort     │
│  renderCmdline()              — bottom-row prompt +    │
│                                  matches dropdown      │
│  runAt(sel, args)             — dispatch to source     │
├─ panel/api.js ─────────────────────────────────────┤
│  getCommands() → [{name,desc,run,_source}]             │
│    walks FRAMEWORK_COMMANDS +                          │
│          static component.commands +                   │
│          dynamic component.getCommands(model)          │
└────────────────────────────────────────────────────────┘
```

### Render integration

Render path mirrors the existing menu/copy/design overlays:

1. `model.modes.cmdMode` flag flips on `:` (cmdline_enter Msg).
2. `layout.render()` paints main columns, then footer; if cmdMode,
   `renderCmdline()` overwrites the bottom row and paints the dropdown
   directly above it.
3. `_wasOverlayActive` already drives a force-full repaint on overlay
   close — cmdMode is included so the dropdown wipe is clean.

### State (root model)

```javascript
model.modes.cmdMode           // true while cmdline is open
model.modal.cmdline = {
  text: '',                   // current input buffer
  sel: 0,                     // dropdown selection index
  matches: [],                // cached render-safe match projection
                              // ({display, desc, kind} — closures stay
                              //  module-held in cmdline.js)
}
```

## Sizing — what costs what

| Layer                           | LOC |
|---------------------------------|-----|
| State fields + dispatch wiring  | ~15 |
| `cmdline.js` mode + render      | ~40 |
| Resolver (registry + fuzzy)     | ~30 |
| `api.getCommands()` + plugin hook | ~15 |
| Built-in commands in core       | ~25 |
| **Total**                       | ~125 |

Scope conscious: ~125 LOC for full mode (autocomplete dropdown +
descriptions). Bare prefix-match could ship at ~60, but the dropdown is
the part that turns this from "a fancy keybinding" into "discoverable
quick-jump", so the budget is worth it.

## Testing

Manual smoke flows (no automated input-mode harness):
1. `:` then `gro` `Enter` → focuses Groups panel
2. `:` then `up` `Enter` → runs `up` action in current group
3. `:` then `theme dra` `Enter` → switches to dracula theme
4. `:` then `Esc` → no state change
5. `:` then `Tab` → top match expands buffer, dropdown filters further
