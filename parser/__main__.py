"""CLI entry point — parse a YAML config and print resolved JSON to stdout.

Used by the TUI's Node side via `python -m parser <config-path>`. Replaces
an earlier scheme that wrote a temp .py wrapper to /tmp on every launch.

Exit codes:
  0 — success, JSON printed to stdout
  1 — parse error (file missing, schema violation, resolution failure);
       human-readable message on stderr
  2 — bad usage
"""
from __future__ import annotations

import json
import sys
from dataclasses import asdict

from parser import parse
from parser.errors import ParseError, ResolutionError, SchemaError


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("Usage: python -m parser <config.yml>", file=sys.stderr)
        return 2
    try:
        config = parse(argv[0])
    except (ParseError, SchemaError, ResolutionError) as e:
        print(f"parser: {e}", file=sys.stderr)
        return 1
    json.dump(asdict(config), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
