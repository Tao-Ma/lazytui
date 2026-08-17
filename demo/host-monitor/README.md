# host-monitor demo — a btop-style system monitor

A small **system monitor** for the host: live CPU / memory / network graphs with
per-core, disk-usage, and per-interface bars, a sorted process table with a
per-process detail card, and disk-I/O throughput. It looks like `btop`/`top`, but
every graph, bar, and column is declared in YAML — no plugin code.

```
╭─(1)─CPU───────────╮╭─(3)─Network────────────╮╭─Selected──────╮
│ CPU        47.2%  ││ ⣀⣠⣴⣶⣾ (up/down graph)  ││ ▁▂▃▄▅▆▇       │
│ █████████▏        ││ Iface rx/s             │╰───────────────╯
│ ⣠⣴⣾⣿⣿⣷⣄⡀ (graph)  ││ eth0 ███░ 20K          │╭─(6)─Host──────╮
│ Cores             │├─(4)─Processes─‹ cpu↓ ›──┤│ > top (live)  │
│ core0 ███████░ 72%││      cpu↓  mem comm     ││   processes   │
│ core1 ████░░░░ 41%││ 240 90.0% 0.3% node     ││   uptime      │
├─(2)─Memory────────┤│ 404 62.0% 4.0% claude   │╰───────────────╯
│ MEM        24.1%  │├─(5)─Disk I/O─‹ write↓ ›─┤╭─Output─Info───╮
│ ██████▊           ││ vda    1M     2M        ││ pid 240       │
│ ⣀⣠⣤ (graph)       │╰────────────────────────╯│ command node… │
│ Disk usage        │                          │ cpu    90.0%  │
│ / ████░ 77%       │                          ╰───────────────╯
╰───────────────────╯
```

*(Simplified sketch.) The CPU / Memory / Network dashboards are **composite** boxes
— the density move (docs/compact-panes.md): each stacks a line **graph** and a
**bar** strip in one bordered pane. **CPU** = busy% graph + per-core bars;
**Memory** = used% graph + disk-usage bars; **Network** = up/down graph +
per-interface bars. Column 1 stacks the CPU + Memory boxes; column 2 the Network
box above the interactive **Processes** and **Disk I/O** tables; column 3 the
**Selected** drill-down, host actions, and the **Output** pane whose Info tab is
the process detail card.*

## What it shows

This is the first demo with **no container at all**. It exercises two features:

- the **`metrics:` producer** ([docs/metrics-producer.md](../../docs/metrics-producer.md)):
  a top-level `metrics:` block turns plain host commands into live hub data —
  graphed, barred, or tabled, no plugin code;
- **composite panels** ([docs/compact-panes.md](../../docs/compact-panes.md)):
  `type: composite` stacks several border-less widget bodies (a `graph` + `bars`)
  in one pane, so the CPU / Memory / Network dashboards read like btop's boxes
  instead of one pane per metric.

Eight producers, each a one-line host command:

| Topic | Command (summarised) | Rendered as |
|---|---|---|
| `host.cpu` | two `/proc/stat` samples → busy% | CPU graph (in the **CPU** box) |
| `host.core` | `mpstat -P ALL` → busy% per core | **per-core bars** (CPU box) |
| `host.mem` | `free` → used% | Memory graph (in the **Memory** box) |
| `host.disk` | `df` → used% per mount | **disk-usage bars** (Memory box) |
| `host.nettotal` | `/proc/net/dev` summed → one stream | **Network graph** (up/down) |
| `host.net` | `/proc/net/dev` per-iface **counters** → rates | **per-interface bars** (Network box) |
| `host.proc` | `ps` top-by-CPU (pid/cpu/mem/comm + state/rss/…/cmdline) | **Processes table** + **detail card** |
| `host.diskio` | `/proc/diskstats` sectors **counters** → rates | **Disk I/O table** (`B/s`) |

Three concern-grouped columns. **Column 1** stacks the **CPU** and **Memory**
composite boxes (each a `graph` + `bars`). **Column 2** leads with the **Network**
composite box (anchored taller so its up/down graph + per-interface bars fit),
then the interactive data tables: the **Processes** `table` (sorted, columnar;
click the `‹ cpu↓ ›` control to re-sort) and the **Disk I/O** throughput table.
**Column 3** holds the selected-process drill-down, the host actions, and the
**Output** pane.

Select a process and two things happen: the **Selected** graph drills into that
process's own CPU/memory history via `select_from:`, and the **Output** pane's
**Info tab** shows a **detail card** — the full command line, state, RSS, thread
count, parent pid, and user (btop's process-detail popup). That card is just the
process topic carrying a few extra `schema:` columns; the `table`'s `getInfo`
projects them, no plugin code. Plus host actions: **top** (live view in a terminal
tab), **processes** (a `ps` snapshot), and **uptime** (system uptime + load).

## Requirements

- **Linux** — the producers read `/proc/stat`, `/proc/net/dev`, `/proc/diskstats`,
  and run `free` / `df` / `ps` / `awk`.
- `mpstat` (from **sysstat**) for the per-core CPU bars — **optional**: without it
  that one producer's poll fails and the per-core bars read "(no data yet)"; every
  other panel is unaffected.
- `top` for the live process tab (optional — the graphs work without it).
- No Docker, no build step.

## Run

```sh
cd demo/host-monitor && ./run
```

Keys: `up`/`dn` select an action, `Enter` run, `h`/`l` move between panels,
`?` help, `q` quit. The graphs update every 2 seconds on their own.

## Extending it

- **A composite box is a stack of widgets.** Add a `graph` or `bars` widget to any
  `type: composite` panel (each widget is a today-pane's config minus the border,
  plus `height: N%`) — see [docs/compact-panes.md](../../docs/compact-panes.md).
- Change a poll rate by editing `interval:` on a producer, or repoint a producer's
  `cmd:` at any command that prints a number.
