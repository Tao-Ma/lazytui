# Global user config

App-behavior preferences that follow the USER across projects, layered under
every project's config at boot.

## Location

`~/.config/lazytui/config.yml` — honoring `$XDG_CONFIG_HOME` when set
(`$XDG_CONFIG_HOME/lazytui/config.yml`). `LAZYTUI_GLOBAL_CONFIG` overrides
the path outright; the empty string disables the lookup entirely (the test
harness sets this so runs stay hermetic).

## What may live there

Only the app-behavior sections are honored (`parser/schema.js
GLOBAL_TOP_KEYS`):

```yaml
theme: nord                 # wholesale — a project theme: wins
selection: true             # wholesale — global text-selection default
editor: nvim                # wholesale — see §editor below
color_depth: auto           # wholesale — auto | truecolor | 256 | 16 (see below)
keyboard_protocol: auto     # wholesale — auto | legacy | kitty (see below)
action_status:              # global-only — action-status chip (see below)
  segments: [status, duration, time]
keys:                       # entry-level merge — per key-sequence
  "<space>g": { command: "grep TODO" }
keymap:                     # entry-level merge on normal:, version project-wins
  normal: { G: cursor_bottom }
mouse:                      # entry-level merge — per gesture
  right-click: context
context-menu:               # list — global entries first, project's appended
  - { label: "My Refresh", builtin: refresh }
```

Project content (`groups`, `layout`, `vars`, `helpers`, `files`, `plugins`,
`panels`, `register`, `project_dir`) belongs to the per-project config; any
such key in the global file warns (`global.ignored_key` in the boot ⚠
diagnostics) and is ignored.

## Merge rules

The global file layers UNDER the project config:

- **Keyed sections** (`keys`, `keymap.normal`, `mouse`) merge at the ENTRY
  level — a global binding applies everywhere unless the project rebinds
  that same key/gesture.
- **`context-menu`** is a list: global entries first, project entries after.
- **Scalars** (`theme`, `selection`, `editor`, `color_depth`,
  `keyboard_protocol`) are wholesale — a project value wins; absent, the
  global value applies. For `color_depth` and `keyboard_protocol`, a project
  `auto` ALSO counts as absent: `auto` means "no override opinion, decide
  from the environment", so an explicit global value applies under it.
- **`action_status`** is global-only (not a project top key), so it is simply
  lifted onto the merged config — a display preference that follows the user.

### color_depth

Render color depth (truecolor arc, docs/truecolor.md P3). The pipeline is
canonically truecolor; this key overrides the DEVICE adaptation applied at
the write boundary. `auto` (the default) detects from the environment:
`COLORTERM=truecolor|24bit` → `TERM` (`*direct*`/`*truecolor*` →
truecolor, `*256color*` → 256, else 16). Set an explicit
`truecolor`/`256`/`16` only when detection gets your terminal wrong (e.g.
tmux without the RGB capability advertising a truecolor-less TERM).

Precedence: a valid `LAZYTUI_COLOR` env value beats EVERYTHING, including
an explicit config depth — it's the one-shot "test this terminal at depth
X" knob (`LAZYTUI_COLOR=16 lazytui …` works even with `color_depth:
truecolor` configured). Then config, then detection. Depth never changes
the frame — only the emitted bytes.

### keyboard_protocol

Keyboard input protocol (kitty-keyboard arc, docs/kitty-keyboard.md). `auto`
(the default) runs the boot detection handshake (a CSI-u flags query fenced
by a Primary-DA request) and enables the "disambiguate escape codes" mode
only on a confirmed reply; `legacy` stays on the tokenizer path and never
probes or enables; `kitty` force-enables without the handshake (for terminals
that support the protocol but don't answer the query). Terminals without the
protocol are unaffected either way.

Precedence mirrors `color_depth`: a valid `LAZYTUI_KBD` env value beats the
config (`LAZYTUI_KBD=legacy lazytui …` disables it for one run even with
`keyboard_protocol: kitty` configured). The flags are pushed on a save/restore
stack and popped on suspend (Ctrl+Z) and exit, so a shell or editor spawned
from lazytui is never left in the protocol.

Note on multiplexers: inside **tmux / screen / zellij**, lazytui talks to the
multiplexer, not your outer terminal — and those answer the detection fence
themselves without negotiating the kitty protocol for the inner app, so `auto`
falls back to legacy even under a kitty-capable terminal (Ghostty, kitty,
foot, WezTerm…). The `<leader> e` hint names the multiplexer in that case. To
use the protocol, run lazytui outside the multiplexer. (SSH and container
shells are transparent — only the multiplexer layer matters.)

### action_status

A powerline-style, right-aligned status stamp at the end of an action's output
pane — the routed tab of a `tab:`-routed action and the Transcript. It shows,
for the job that produced that pane's output:

- a status glyph — `✓` (exit 0), `✗ N` (non-zero, with the code), `✗ ?` (no
  exit code, e.g. a spawn failure), `⊗ SIG` (killed by signal), or a braille
  spinner while running;
- the run **duration** (ticking live while running, final on completion);
- the **finish** clock time (shown once the action has ended).

Segments are middot-joined, e.g. `✓ · 4.1s · 14:32:07`.

While the action runs, a **live** line floats at the end of the output (spinner
+ ticking duration) and is pushed down by new output. On completion it becomes a
line **in the pane's scrollback** (not an ephemeral chrome cell), so it scrolls
with the output rather than being overwritten in place, and each routed action's
own tab keeps its stamp; a re-run reseeds its pane like any output does. It
**replaces** the classic plain `Done.` / `Exit N` footer, and is right-aligned
at render so it stays flush-right across pane resizes.

```yaml
action_status:
  enabled: true                     # master on/off (default true)
  segments: [status, duration, time]  # which chips + their left→right order
  live: true                        # tick the running line while it runs
```

- `enabled` — set `false` (or `action_status: false` as a shorthand) to turn it
  off; the plain left-aligned `Done.` / `Exit N` footer is used instead.
- `segments` — any subset of `status` / `duration` / `time`, in the order you
  want them to appear; unknown tokens are rejected at load. Defaults to all
  three. `time` is omitted while a job is still running (no finish time yet).
- `live` — when `true` (default), the 1-second frame clock is armed while a
  streamed action runs so the floating line's duration and spinner advance
  between output chunks; the *permanent* stamp is correct either way, so `false`
  just makes a long, silent run's live duration refresh only when it next
  prints.

Terminal (`type: spawn` / `terminal`) panes are not covered.

The merge happens inside `parse()`: the project config validates STANDALONE
first (its errors surface unchanged, global file or not), the pre-validated
global sections then layer in before the output assembly, so `theme:` /
`selection:` defaulting applies to the merged result. It all happens BEFORE
the `set_config` Msg, so a recording carries the merged config and replay
never re-reads the file. `--keymap` dumps the effective (merged) bindings.

## JSON configs

A `.json` config is the parser's RESOLVED output shape, so it always carries
explicit `theme`/`selection` values — the global scalars can't apply there
(nothing is "absent"); `editor: null` counts as unset, so a global `editor:`
still lands, and the stamped `color_depth: 'auto'` / `keyboard_protocol:
'auto'` / `action_status: null` likewise count as unset (auto / null = "no
override opinion"), so a global override of any of them still applies. The keyed
sections (`keys`, `keymap`,
`mouse`, `context-menu`) layer exactly as they do for YAML.

## Failure contract

A global file must never brick a project:

- missing file / empty file — silently fine;
- unreadable or invalid YAML — `global.unreadable` warning, project-only;
- a malformed HONORED section (e.g. `editor: 42`) — `global.invalid`
  warning, project-only;
- unknown/project keys — per-key `global.ignored_key` warning, key dropped.

All warnings ride the normal boot-diagnostics path (`config.warnings` →
event log + the footer's ⚠ notice + `<leader> e`).

## editor

`editor:` names the command that opens files for editing (a program name or
path, optionally with arguments — `nvim`, `code --wait`). Resolution chain:
project `editor:` → global `editor:` → `$VISUAL` → `$EDITOR` → `vi`.

The edit affordances that consume it ride the embedded-PTY spawn seam
(`dispatch/runtime/edit.js` — mint a terminal tab, auto-zoom, return on
quit; exit-0 auto-closes the tab):

- **`e`** on a files-pane row (host files only — a docker-sourced row has
  no local path to hand an editor);
- **`:edit <path>`** (host-path TAB completion, resolved against
  `project_dir`);
- **`:config`** — the project config; **`:config global`** — this file,
  created with a commented skeleton on first use.

On a clean editor exit, a serializable `onExit` continuation on the minted
tab refreshes an open doc tab showing that file (gated — it never opens
one) and, after a config edit, prints "changes apply on the next lazytui
start" on the Transcript. No live reload — deliberate (2026-08-02): a
mid-session re-parse conflicts with every piece of state derived from the
boot config. Under tmux the editor opens in a `tmux new-window` lazytui
doesn't own; the continuation doesn't fire there.

## Tests

`js/test/test-global-config.js` — path resolution, the tolerant-load
contract, the merge rules, the parse()/loadConfig end-to-end layer, and the
`selection:` pass-through fix that rode along with this arc.
