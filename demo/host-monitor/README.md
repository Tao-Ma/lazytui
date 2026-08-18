# host-monitor demo — a btop-style system monitor

A small **system monitor** for the host: live CPU / memory / network graphs with
per-core, disk-usage, and per-interface bars, a sorted process table with a
per-process detail card, and disk-I/O throughput. It looks like `btop`/`top`, but
every graph, bar, and column is declared in YAML — no plugin code.

```
╭─ (1) CPU ─────────╮╭─ (3) Network ────────╮╭─ (4) Processes ‹cpu↓› ──╮
│ CPU        47.2%  ││ ⣀⣠⣴⣶⣾ up/down        ││   cpu↓  mem comm        │
│ █████████▏        ││ Iface rx/s           ││ 240 90.0% 0.3% node     │
│ ⣠⣴⣾⣿⣿⣷⣄⡀ (graph)  ││ eth0 ███░ 20K        ││ 404 62.0% 4.0% claude   │
│ Cores             │╰──────────────────────╯│ 771  3.0% 1.2% sshd     │
│ c0 ███████░ 72%   │╭─ Selected ───────────╮╰─────────────────────────╯
│ c1 ████░░░░ 41%   ││ ▁▂▃▄▅▆▇ cpu/mem      │╭─ (6) Host ──────────────╮
╰───────────────────╯╰──────────────────────╯│ > top (live)            │
╭─ (2) Memory ──────╮╭─ (5) Disk I/O ‹w↓› ──╮│   processes   uptime    │
│ MEM        24.1%  ││ vda   1M    2M       │╰─────────────────────────╯
│ ██████▊           ││ sda 512K  128K       │╭─ Output · Info ─────────╮
│ ⣀⣠⣤ (graph)       │╰──────────────────────╯│ pid 240                 │
│ Disk usage        │                        │ command node …          │
│ / ████░ 77%       │                        │ cpu    90.0%            │
╰───────────────────╯                        ╰─────────────────────────╯
```

*(Simplified sketch.) The CPU / Memory / Network dashboards are **composite** boxes
— the density move (docs/compact-panes.md): each stacks a line **graph** and a
**bar** strip in one bordered pane. **CPU** = busy% graph + per-core bars;
**Memory** = used% graph + disk-usage bars; **Network** = up/down graph +
per-interface bars. Column 1 is a fixed-narrow stack of the CPU + Memory boxes;
columns 2 & 3 are `width: flex`, so they share the terminal's leftover width evenly
(no single ballooning column). Column 2 holds the Network box, the **Selected**
drill-down, and the **Disk I/O** table; the elastic column 3 leads with the
always-populated **Processes** table, then host actions and the **Output** pane
whose Info tab is the process detail card.*

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

Three concern-grouped columns, sized with **flex widths** so slack on a wide
terminal spreads instead of ballooning one column. **Column 1** is fixed-narrow
(`width: 34`) and stacks the **CPU** and **Memory** composite boxes (each a `graph`
+ `bars`). **Columns 2 and 3** are `width: flex` — they split the remaining width
evenly (e.g. a 200-col terminal gives `34 / 83 / 83`, not `34 / 46 / 120`).
**Column 2** holds the **Network** composite box (anchored so its up/down graph +
per-interface bars fit), the selected-process **Selected** drill-down, and the
**Disk I/O** throughput table. The elastic **Column 3** leads with the
width-hungry, always-populated **Processes** `table` (sorted, columnar; click the
`‹ cpu↓ ›` control to re-sort — its command column expands into the room), then the
host actions and the **Output** pane. Putting the busy table in the growing column
means the widest pane is the fullest, not an empty drill-down.

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
