# host-monitor demo — a btop-style system monitor

A small **system monitor** for the host: live CPU / memory / load graphs, disk
usage + I/O, network throughput, and a sorted process table with a per-process
detail card. It looks like `btop`/`top`, but every graph, bar, and column is
declared in YAML — no plugin code.

```
╭─(1)─CPU──────────╮╭──CPU bars──────────────╮╭─Selected──────╮
│ CPU        47.2% ││ node   ████████░░ 90%   ││ ▁▂▃▄▅▆▇       │
│ █████████▏       ││ claude ██████░░░░ 62%   │╰───────────────╯
│ MEM        24.1% │╰────────────────────────╯╭─(7)─Host──────╮
│ ██████▊          │╭─Processes───‹ cpu↓ ›────╮│ > top (live)  │
├──────────────────┤│      cpu↓  mem comm      ││   processes   │
│ Disk / ████░ 77% ││ 240 90.0% 0.3% node      ││   uptime      │
│ Disk I/O rd  wr  ││ 404 62.0% 4.0% claude    │╰───────────────╯
│ vda   1M   2M    │├──────────────‹ rx↓ ›────┤╭─Output─Info───╮
│                  ││ Network  rx     tx       ││ pid 240       │
│                  ││ eth0    20K    5K        ││ command node… │
│                  ││ Net (sel) ▁▂▃▅▆          ││ cpu    90.0%  │
╰──────────────────╯╰────────────────────────╯╰───────────────╯
```

*(Simplified sketch. Column 1 stacks the CPU/MEM/LOAD graphs, the **Disk** usage
gauge and **Disk I/O** table; column 2 the **CPU bars** gauge, **Processes**
table, **Network** table + **trend graph**; column 3 the **Selected** drill-down,
host actions, and the **Output** pane whose Info tab is the process detail card.)*

## What it shows

This is the first demo with **no container at all**. It exercises the
`metrics:` producer feature ([docs/metrics-producer.md](../../docs/metrics-producer.md)):
a top-level `metrics:` block turns plain host commands into live hub data —
graphed by the `stats` panel and listed by the `table` panel, no plugin code.

Seven producers, each a one-line host command:

| Topic | Command (summarised) | Rendered as |
|---|---|---|
| `host.cpu` | two `/proc/stat` samples → busy% | CPU line graph |
| `host.mem` | `free` → used% | Memory line graph |
| `host.load` | `/proc/loadavg` → 1-min load | Load line graph |
| `host.proc` | `ps` top-by-CPU (pid/cpu/mem/comm + state/rss/…/cmdline) | **Processes table** + **CPU bars** + **detail card** |
| `host.net` | `/proc/net/dev` rx/tx **counters** → rates | **Network table** + **trend graph** (`B/s`) |
| `host.disk` | `df` → used% per mount | **Disk gauge** (usage bars) |
| `host.diskio` | `/proc/diskstats` sectors **counters** → rates | **Disk I/O table** (`B/s`) |

Three concern-grouped columns. **Column 1** is system + storage: the CPU / memory
/ load graphs, the **Disk** usage gauge (one bar per mount), and the **Disk I/O**
table (per-device read/write `B/s`). **Column 2** is the process column — the
**CPU bars** `gauge` (a btop-style bar chart, one meter bar per process) above the
**Processes** `table` (sorted, columnar; click the `‹ cpu↓ ›` control to re-sort),
then the **Network** throughput table and its **trend graph**. **Column 3** holds
the selected-process drill-down, the host actions, and the **Output** pane.

Select a process and two things happen: the **Selected** graph drills into that
process's own CPU/memory history via `select_from:`, and the **Output** pane's
**Info tab** shows a **detail card** — the full command line, state, RSS, thread
count, parent pid, and user (btop's process-detail popup). That card is just the
process topic carrying a few extra `schema:` columns; the `table`/`gauge`
`getInfo` projects them, no plugin code. The network graph works the same way —
it `select_from:` the network table, graphing the selected interface's rate.
Plus host actions: **top** (live view in a terminal tab), **processes** (a `ps`
snapshot), and **uptime**.

## Requirements

- **Linux** — the producers read `/proc/stat`, `/proc/loadavg`,
  `/proc/net/dev`, `/proc/diskstats`, and run `free` / `df` / `ps`. (`awk` and
  `sh` are assumed present.)
- `top` for the live process tab (optional — the graphs work without it).
- No Docker, no build step.

## Run

```sh
cd demo/host-monitor && ./run
```

Keys: `up`/`dn` select an action, `Enter` run, `h`/`l` move between panels,
`?` help, `q` quit. The graphs update every 2 seconds on their own.

## Extending it

- **Per-core CPU** is a natural next producer — see the worked example in
  [docs/metrics-producer.md](../../docs/metrics-producer.md) (`mpstat -P ALL`).
  Per-core would drop straight into a second `table` (row per core) the same way
  `host.proc` does, or a `gauge` (a bar per core) like `host.disk`.
- Change a poll rate by editing `interval:` on a producer, or repoint a
  producer's `cmd:` at any command that prints a number.
