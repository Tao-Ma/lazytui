# host-monitor demo — a btop-style system monitor

A small **system monitor** for the host: live CPU, memory, and load-average
graphs, plus a live process view. It looks like `btop`/`top`, but every graph
is declared in YAML — no plugin code.

```
╭─(1)─CPU──────────────────────────╮╭─(4)─Host─────────────────────╮
│ CPU          47.2%  peak 92  avg 38││ > top (live)           spawn │
│ ⣀⣠⣴⣾⣿⣷⣄⡀⣀⣠⣶⣿⣿⣷⣄        ││   processes (snapshot)   tab │
│ MEM                     24.1%     ││   uptime                 tab │
│ ▂▃▃▄▄▄▅▅▅▅▆▆▆▆▆              ││                              │
│ LOAD (1m)               0.56      │╰──────────────────────────────╯
│ ▁▁▂▂▃▃▃▃▃▃                   │╭─(o)─Output───────────────────╮
╰────────────────────────────────────╯│ PID  %CPU %MEM COMMAND       │
                                       ╰──────────────────────────────╯
```

## What it shows

This is the first demo with **no container at all**. It exercises the
`metrics:` producer feature ([docs/metrics-producer.md](../../docs/metrics-producer.md)):
a top-level `metrics:` block turns plain host commands into live hub data that
the `stats` panel graphs — the same braille line-graphs that used to be
docker-only.

Three producers, each a one-line host command:

| Topic | Command (summarised) | Graph |
|---|---|---|
| `host.cpu` | two `/proc/stat` samples → busy% | CPU line graph + meter |
| `host.mem` | `free` → used% | Memory line graph + meter |
| `host.load` | `/proc/loadavg` → 1-min load | Load line graph |

Plus three host actions: **top** (live process view in an embedded terminal
tab), **processes** (a `ps` snapshot into the Output panel), and **uptime**.

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
  (`mpstat -P ALL` for per-core). A *browsable* per-core / process **table**
  (like btop's process list) needs a table consumer that isn't built yet;
  today a single-stream metric graphs with `row: _`, and a live process list
  is the `top` tab.
- Change a poll rate by editing `interval:` on a producer, or repoint a
  producer's `cmd:` at any command that prints a number.
