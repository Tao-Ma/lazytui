# User Project Contract

This document specifies what a *TUI user project* is — the directory
shape, discovery rules, and boundary between framework code (the
lazytui repo) and user code (everything else). Read this if you are
adopting the TUI in a new project, or deciding where to put a new
file in an existing one.

The framework reads exactly one entry point — a YAML config — and
discovers everything else by paths declared inside it. Nothing is
implicit. There is no convention-over-configuration: if the YAML
doesn't mention it, the framework doesn't see it.

## What a user project is

A directory that contains:

- One YAML config file (the entry point — pass it to `tui.js`)
- Any plugins, scripts, data, or services the YAML refers to
- Anything else the project needs (the framework doesn't care)

The framework imposes no naming or layout beyond that — `services.yml`
and `mythings.yml` are both valid entry points. A project may live
inside a larger monorepo or be a standalone directory.

## Discovery rules

The YAML file's directory is the **anchor**. Everything resolves
from there.

| Path declared in YAML | Resolved against |
|---|---|
| `project_dir:` (default `.`) | The YAML's parent directory |
| `plugins.<name>.path:` (`.yml`/`.yaml`) | The YAML's parent directory |
| `plugins.<name>.path:` (`.js`) | The YAML's parent directory |
| `plugins.<name>` with no `path:` | Built-in: `js/plugins/<name>.js` in the lazytui repo |
| `files[].path:` | Used as-is — typically a project-relative string for display |
| Action `script:` cwd | `project_dir` (resolved absolute at parse time) |

Two consequences worth internalizing:

- **The YAML's location anchors discovery, not the user's cwd.** Run
  `tui.js` from anywhere; paths inside the YAML still resolve the
  same way.
- **`project_dir` is for *script execution*, not for path discovery.**
  Plugins and nested YAMLs always anchor to the entry-point YAML's
  directory. `project_dir` only changes where action scripts run.

## What the framework owns

The framework guarantees, regardless of project:

- YAML schema validation, var/helper resolution (parser/)
- Layout, panel rendering, navigation, themes, design mode
- Action execution by `type` (`run` / `spawn` / `background`)
- Built-in panels: `groups`, `actions`, `file-manager`, `history`, `detail`
- Built-in `:` commands: `:quit`, `:refresh`, `:help`
- Plugin loading and lifecycle (`refresh`, `groupActions`, `panelTypes`)
- Hub pub/sub, decorators, copy menu, filter, multi-select

Things the framework will never know:

- What your services are called
- What your actions do
- Where your data lives
- What containers (if any) you run

These come from the user project's YAML and plugins.

## What the user project owns

The project provides:

- **The YAML** — source of truth; describes groups, actions, layout, plugins
- **Domain plugins (optional)** — JS for new panel types or runtime
  behavior; YAML for declarative config splits (see PLUGINS.md)
- **Scripts and data** the actions invoke
- **A way to invoke `tui.js`** — typically a thin wrapper script in the
  project root (e.g. `./do tui` or `make tui`) that calls
  `node <path-to-lazytui/js/tui.js> <path-to-config.yml>`

A project that doesn't provide these is just an empty directory the
framework refuses to start in. The framework is a renderer; the
project is the application.

## Minimal worked example

```
my-services/                  ← user project
├─ services.yml               ← entry point (pass to tui.js)
├─ tui-plugins/
│  └─ extras.yml              ← optional declarative split
└─ scripts/
   └─ deploy.sh
```

`services.yml` (~20 lines):

```yaml
project_dir: .

vars:
  REGION: us-west-2

groups:
  prod:
    label: Production
    actions:
      deploy:
        label: Deploy
        type: spawn
        confirm: "Deploy to $REGION?"
        script: ./scripts/deploy.sh $REGION

plugins:
  extras:
    path: tui-plugins/extras.yml
```

Run it (from anywhere):

```sh
node /path/to/lazytui/js/tui.js my-services/services.yml
```

The framework finds `tui-plugins/extras.yml` relative to
`services.yml`, runs `./scripts/deploy.sh` with cwd
`my-services/` (because `project_dir: .`), and renders the `prod`
group's `Deploy` action.

That's the entire contract. Everything else — multiple groups, custom
panel types, hub-fed status panels, confirmation prompts — is
additive on top.

## Splitting a large YAML

When `services.yml` outgrows one file, split groups into per-module
YAMLs and reference them via `plugins:`. Merge rules and a worked
example are in **PLUGINS.md** (YAML plugins section). The split is
transparent to the framework: it sees a single merged config.

## Adding runtime behavior

When the project needs panel types or behavior not covered by the
built-ins (a custom dashboard, per-item shortcuts, group-action
synthesis), write a JS plugin. Contract and examples are in
**PLUGINS.md** (JS plugins section).

## Boundary check

After this contract is in place, this should hold:

```sh
git grep -i '<your-project-name>' js parser   # inside the lazytui repo
# → only test fixtures, no production code matches
```

If framework code mentions your project by name, the framework has
leaked. Move the reference into your YAML or plugin and clean it
out — the framework is reusable only as long as it's generic.
