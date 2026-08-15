# host-monitor demo — a btop-style system monitor

A small **system monitor** for the host: live CPU, memory, and load-average
graphs alongside a sorted process table with per-process drill-down. It looks
like `btop`/`top`, but every graph and column is declared in YAML — no plugin
code.

```
╭─(1)─CPU──────────╮╭─(4)─Processes────‹ cpu↓ ›─╮╭─(7)─Host──────╮
│ CPU        47.2% ││        cpu↓   mem comm     ││ > top (live)  │
│ ⣀⣠⣴⣾⣿⣷⣄⡀⣀⣠⣶  ││ 240   50.0%  0.3% node     ││   processes   │
│ MEM        24.1% ││ 404    2.2%  4.0% claude   ││   uptime      │
│ ▂▃▃▄▄▅▅▅▆▆▆    ││ 166    2.1%  0.4% agent    │╰───────────────╯
│ LOAD       0.56  │╰──────────────────1 of 20──╯╭─(o)─Output────╮
│ ▁▁▂▂▃▃▃▃      ││ Selected: 240              ││ ...           │
│                  ││ CPU  50.0%  ████████       ││               │
╰──────────────────╯╰────────────────────────────╯╰───────────────╯
```

*(Simplified sketch. The shipped middle column stacks the **CPU bars** `gauge`
above the **Processes** table (both views of `host.proc`) and a **Network**
throughput table below; the **Selected** drill-down sits in the right column.)*

## What it shows

This is the first demo with **no container at all**. It exercises the
`metrics:` producer feature ([docs/metrics-producer.md](../../docs/metrics-producer.md)):
a top-level `metrics:` block turns plain host commands into live hub data —
graphed by the `stats` panel and listed by the `table` panel, no plugin code.

Five producers, each a one-line host command:

| Topic | Command (summarised) | Rendered as |
|---|---|---|
| `host.cpu` | two `/proc/stat` samples → busy% | CPU line graph + meter |
| `host.mem` | `free` → used% | Memory line graph + meter |
| `host.load` | `/proc/loadavg` → 1-min load | Load line graph |
| `host.proc` | `ps` top-by-CPU (pid/cpu/mem/comm) | **Processes table** + **CPU bars** |
| `host.net` | `/proc/net/dev` rx/tx **counters** → rates | **Network table** (`B/s`) |

The middle column shows the same `host.proc` topic **two ways at once**: the
**CPU bars** `gauge` (a btop-style bar chart — one meter bar per process, ordered
by CPU) above the **Processes** `table` (sorted, columnar; click the `‹ cpu↓ ›`
control on its border to re-sort). Select a row in the table and the **Selected**
graph drills into that process's own CPU/memory history via `select_from:`. Plus host
actions: **top** (live view in a terminal tab), **processes** (a `ps` snapshot),
and **uptime**.

## Requirements

- **Linux** — the CPU and load producers read `/proc/stat` and
  `/proc/loadavg`; memory uses `free`. (`awk` and `sh` are assumed present.)
- `top` for the live process tab (optional — the graphs work without it).
- No Docker, no build step.

## Run

```sh
cd demo/host-monitor && ./run
```

Keys: `up`/`dn` select an action, `Enter` run, `h`/`l` move between panels,
`?` help, `q` quit. The graphs update every 2 seconds on their own.

## Extending it

- **Per-core CPU**, network, or disk are natural next producers — see the
  worked examples in [docs/metrics-producer.md](../../docs/metrics-producer.md)
  (`mpstat -P ALL` for per-core). Per-core would drop straight into a second
  `table` (row per core) the same way `host.proc` does.
- Change a poll rate by editing `interval:` on a producer, or repoint a
  producer's `cmd:` at any command that prints a number.
