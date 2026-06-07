# Terminal Tabs Design

> **Note.** This doc is the original design rationale, written before
> the v0.5 architectural arc. Code snippets reference the retired `S`
> shim — substitute as you read:
>
> - `S.config.*`, `S.currentGroup`, `S.terminalMode`, `S.activeTab` →
>   `getModel().config.*` / `.currentGroup` / `.modes.terminalMode` /
>   `getInstanceSlice('detail').tab` respectively (every read goes
>   through `getModel()` / `getInstanceSlice(<tabId>)` now; v0.6.1
>   Phase 8 retired the `getComponentSlice` shim — for singleton
>   instances the tab id equals the Component name).
> - `S.detailLines` → `getInstanceSlice('detail').lines`.
> - `S.paneBounds` → `getInstanceSlice('layout').paneBounds`.
> - Direct assignment like `S.terminalMode = true` → dispatch the
>   appropriate Msg (`terminal_enter` / `terminal_exit` for the flag,
>   wrapped Msgs into the owning Component for slice writes).
>
> The live source is the authoritative reference:
> `js/panel/viewer/tabs.js`, `js/panel/viewer/viewer.js`,
> `js/io/terminal.js`, `js/render/layout.js#renderTerminalOverlay`.

Embed interactive terminal sessions (SSH, SQL editor, REPL) as tabs
in the detail panel. Users configure `terminals:` per group in YAML.
The framework manages PTY sessions transparently — no tmux knowledge
required.

## Concept

```
╭─(0)─Actions────────────────────────────────────────────╮
│   Status                                                │
│   Restart                                  [confirm]    │
│   Logs                                          ⧉      │
╰────────────────────────────────────1 of 3──────────────╯
╭─(o)─Info─Status─SQL─SSH────────────────────────────────╮
│ mysql> SELECT * FROM users LIMIT 5;                     │
│ +----+-------+-------------------+                      │
│ | id | name  | email             |                      │
│ +----+-------+-------------------+                      │
│ |  1 | alice | alice@example.com |                      │
│ |  2 | bob   | bob@example.com   |                      │
│ +----+-------+-------------------+                      │
│ 2 rows in set (0.01 sec)                                │
│                                                         │
│ mysql> _                                                │
╰─────────────────────────────────────────────────────────╯
 Ctrl+\ return to TUI ── terminal: SQL
```

Tabs in order: **Info** → **Transcript** (always, both implicit
globals) → **action tabs** (`tab: true`) → **terminal tabs**
(`terminals:`) → **content tabs** (file/docker opens). Cycle with
`]`/`[`. Transcript was added in v0.6.2 to host the unrouted
accumulator that pre-fix double-booked Info; details in
`docs/DATAFLOW.md` § Unrouted accumulator.

## Why tabs, not panels

- Detail panel **already has tabs** — `]`/`[` cycling, tab bar in title
- No panel identity refactor needed (detail is a singleton)
- Terminals are long-lived sessions — tabs match the "switch context" UX
- Existing layout, rendering, key handling all stay intact
- Users see one thing at a time, focused — not a cluttered split view

## YAML Configuration

```yaml
groups:
  database:
    label: Database
    containers: [db-postgres, db-redis]
    actions:
      status:
        cmd: docker compose ps
        label: Status
        tab: true                  # existing: action tab
      restart:
        script: docker compose restart
        label: Restart
        confirm: "Restart database?"
    terminals:                     # new: terminal tabs
      sql:
        cmd: "psql -h localhost -U admin mydb"
        label: "SQL Editor"
      redis:
        cmd: "redis-cli -h localhost"
        label: "Redis CLI"

  servers:
    label: Servers
    actions: { ... }
    terminals:
      ssh:
        cmd: "ssh user@prod"
        label: "SSH"
      logs:
        cmd: "ssh user@prod tail -f /var/log/app.log"
        label: "Live Logs"
```

Result tab bars:
- database group: `[Info]─Status─SQL─Redis`
- servers group: `[Info]─Status─SSH─Live Logs`

## Architecture

```
  detail panel
  ┌──────────────────────────────────────┐
  │  Tab 0: Info          S.detailLines  │  ← Rich markup pipeline
  │  Tab 1: Status        S.detailLines  │  ← action tab (execSync)
  │  Tab 2: SQL           PTY overlay    │  ← terminal tab
  │  Tab 3: Redis         PTY overlay    │  ← terminal tab
  └──────────────────────────────────────┘
         ↓ (terminal tabs)
  ┌──────────────────────────────────────┐
  │  terminal.js                         │
  │    sessions = {                      │
  │      "database_sql":  { pty, xterm } │
  │      "database_redis": { pty, xterm }│
  │      "servers_ssh":   { pty, xterm } │
  │    }                                 │
  └──────────────────────────────────────┘
         ↓                    ↓
      node-pty          @xterm/headless
    (real PTY)       (terminal emulator)
```

## Tab System Changes

### Current tab model

```
Tab 0:  Info            always present
Tab 1+: action tabs     group.actions where tab: true
Total:  1 + actionTabs.length
```

`S.activeTab` indexes into this flat list. The `tab_cycle` Msg cycles
and executes action scripts.

### New tab model

```
Tab 0:          Info            always present
Tab 1..N:       action tabs     group.actions where tab: true
Tab N+1..N+M:   terminal tabs   group.terminals entries
Total:          1 + N + M
```

Terminal tabs are **passive** — switching to one doesn't execute
anything. The PTY session runs continuously. Content updates via
the 100ms overlay refresh.

### Tab type detection

```javascript
function getTabInfo() {
  const group = S.config.groups[S.currentGroup];
  if (!group) return { actionTabs: [], termTabs: [], total: 1 };
  const actionTabs = Object.entries(group.actions || {})
    .filter(([, a]) => a.tab);
  const termTabs = Object.entries(group.terminals || {});
  return {
    actionTabs,
    termTabs,
    total: 1 + actionTabs.length + termTabs.length,
  };
}

function isTerminalTab() {
  const { actionTabs } = getTabInfo();
  return S.activeTab > actionTabs.length;
}

function activeTerminalId() {
  const { actionTabs, termTabs } = getTabInfo();
  const idx = S.activeTab - 1 - actionTabs.length;
  if (idx < 0 || idx >= termTabs.length) return null;
  return `${S.currentGroup}_${termTabs[idx][0]}`;
}
```

## Input Routing

### Three modes

```
                    ]  [  (cycle tabs)
                  ┌───────────────────┐
                  │                   │
  ┌────────┐    focus    ┌──────────┐│   Enter    ┌──────────────┐
  │  TUI   │ ──────────→ │ Terminal ││ ────────→  │  Terminal    │
  │  Mode  │             │ Tab View ││            │  Input Mode  │
  │        │ ←────────── │ (passive)│← ────────── │  (active)    │
  └────────┘   ] [ or    └──────────┘   Ctrl+\    └──────────────┘
             leave tab                             all keys → PTY
```

**TUI Mode** (normal): all keys handled by TUI. `]`/`[` cycles tabs.

**Terminal Tab View** (passive): on a terminal tab, content shows
live PTY output. TUI keys still work (navigate other panels, cycle
tabs). You see the terminal but aren't typing into it.

**Terminal Input Mode** (active): press `Enter` on a terminal tab to
activate. All keystrokes forwarded to PTY via `pty.write()`. Only
`Ctrl+\` (0x1c) intercepted to exit back to passive view.

### Why Enter to activate, not auto-activate

- `]`/`[` must work to cycle past terminal tabs
- User can browse terminal output without capturing input
- Explicit activation matches vim's terminal mode pattern
- Clear mental model: view vs interact

### Key handling (keys.js)

```javascript
// In handleKey, before normal mode:
if (S.terminalMode) {
  if (seq === '\x1c') {
    // Ctrl+\ — exit terminal mode
    S.terminalMode = false;
    render();
    return;
  }
  // Forward everything else to PTY
  const id = activeTerminalId();
  if (id) writeToSession(id, data);  // raw stdin data
  return;
}

// In normal mode, Enter on a terminal tab:
case 'run_selected':
  if (isTerminalTab()) {
    S.terminalMode = true;
    render();  // update footer
  } else { ... }
```

## Rendering Pipeline

### Two-phase render for terminal tabs

**Phase 1** — normal render (existing pipeline):
When active tab is a terminal tab, `renderDetailPanel` returns panel
with blank content lines. Borders and tab title render normally.

**Phase 2** — terminal overlay (new):
After main render, `renderTerminalOverlay()` writes PTY screen buffer
content directly to the detail panel's content area coordinates.

```
render()
  ├─ renderNormal/Half/Full()    ← phase 1 (all panels)
  ├─ renderTerminalOverlay()     ← phase 2 (if terminal tab active)
  └─ renderFooter()
```

### Overlay implementation

```javascript
function renderTerminalOverlay() {
  if (!isTerminalTab()) return;
  const id = activeTerminalId();
  const session = getSession(id);
  if (!session) return;

  const bounds = S.paneBounds.detail;
  if (!bounds) return;
  const innerW = bounds.w - 2;
  const innerH = bounds.h - 2;

  const buffer = session.xterm.buffer.active;
  for (let row = 0; row < innerH; row++) {
    const line = buffer.getLine(row + buffer.viewportY);
    moveTo(bounds.y + row + 2, bounds.x + 2);
    if (line) {
      stdout.write(line.translateToString(true, 0, innerW) + RESET);
    }
  }
}
```

### Detail panel changes

```javascript
function renderDetailPanel(panel, w) {
  // Terminal tab: blank content (overlay fills it)
  if (isTerminalTab()) {
    return renderPanel({
      width: w, height: h, lines: [],
      title: detailTitle(), hotkey: 'o',
      focused: S.terminalMode,  // highlight border in terminal mode
    });
  }
  // Info/action tab: existing behavior
  return renderPanel({ ... S.detailLines ... });
}
```

### Refresh interval

```javascript
// In tui.js — fast refresh for terminal content
if (hasTerminals()) {
  setInterval(() => {
    if (isTerminalTab()) renderTerminalOverlay();
  }, 100);
}
```

Only the overlay refreshes at 100ms — borders, other panels, footer
are NOT re-rendered. Minimal CPU cost.

## Session Lifecycle

### Creation (lazy)

Sessions are created on first access, not at startup. When the user
switches to a terminal tab for the first time:

```javascript
function ensureSession(id, cmd, cols, rows) {
  if (sessions[id]) return sessions[id];
  const pty = spawn(shell, ['-c', cmd], { cols, rows });
  const xterm = new Terminal({ cols, rows });
  pty.onData(data => xterm.write(data));
  sessions[id] = { pty, xterm, cmd };
  return sessions[id];
}
```

### Persistence across group switches

Terminal sessions persist for the TUI lifetime. Switching from
database group to servers group hides the SQL tab but does NOT kill
the psql session. Switching back shows it again, with state intact.

Session key: `${groupName}_${terminalKey}` (e.g., `database_sql`).

### Resize

On terminal resize or layout change:

```javascript
function resizeSession(id, cols, rows) {
  const s = sessions[id];
  if (!s) return;
  s.pty.resize(cols, rows);
  s.xterm.resize(cols, rows);
}
```

Called after `calcLayout()` when detail panel dimensions change.

### Cleanup

On TUI exit (`q`, `Ctrl+C`, cleanup):

```javascript
function destroyAll() {
  for (const [id, s] of Object.entries(sessions)) {
    s.pty.kill();
    s.xterm.dispose();
    delete sessions[id];
  }
}
```

### Session death

If the PTY process exits (user types `exit`, command finishes):
- Show exit status in the detail panel: `[Process exited: 0]`
- Tab stays visible but becomes passive (no terminal mode)
- Press Enter on a dead session could restart it

## New Module: terminal.js

```
js/io/terminal.js (~80 lines)
  sessions = {}                            // id → { pty, xterm, cmd }
  ensureSession(id, cmd, cols, rows)       // lazy create
  destroySession(id)                       // kill one
  destroyAll()                             // kill all (cleanup)
  getSession(id)                           // lookup
  resizeSession(id, cols, rows)            // resize PTY + xterm
  writeToSession(id, data)                 // forward keystroke
  hasTerminals()                           // any groups have terminals?
  isTerminalTab()                          // active tab is terminal?
  activeTerminalId()                       // current terminal session id
  getTabInfo()                             // { actionTabs, termTabs, total }
```

## Dependencies

```
node-pty           native C++ addon, real PTY allocation
                   ~500KB, requires node-gyp to build
                   used by: VS Code, Hyper, Tabby

@xterm/headless    pure JS terminal emulator (no DOM)
                   ~300KB, xterm.js project
                   maintains virtual screen buffer
```

These are terminal emulation deps — fundamentally different from
"framework deps". The TUI framework itself stays zero-dep.

Install in tools build pipeline alongside Node.js:

```bash
# In Dockerfile.download or build-all.sh
npm install --omit=dev node-pty @xterm/headless
```

## Files Changed

| File | Change |
|------|--------|
| **terminal.js** (new) | Session management, tab helpers |
| **detail.js** | Tab cycling includes terminals, terminal tab detection |
| **renderers.js** | `detailTitle()` includes terminal tabs, blank content for terminal tabs |
| **keys.js** | Terminal input mode (Ctrl+\ escape), Enter activates |
| **layout.js** | `renderTerminalOverlay()` after main render |
| **tui.js** | 100ms interval, destroyAll on cleanup |
| **state.js** | `S.terminalMode` flag |
| **parser/** | Allow `terminals:` section in group schema |

No panel identity refactor. No layout changes. The existing detail
panel tab system extends naturally.

## Implementation Order

1. **npm setup** — package.json with node-pty + @xterm/headless
2. **terminal.js** — session management module
3. **State** — add `S.terminalMode` to state.js
4. **Tab system** — extend detail.js with terminal tab support
5. **Rendering** — blank content + overlay in renderers.js/layout.js
6. **Input routing** — terminal mode in keys.js
7. **Lifecycle** — lazy create, resize, cleanup in tui.js
8. **Parser** — `terminals:` in group schema (or test with JSON first)
9. **Build** — integrate npm install into tools build pipeline
