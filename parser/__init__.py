"""TUI YAML config parser — validates and resolves config into runnable objects."""
from __future__ import annotations

from pathlib import Path

import yaml

from parser.errors import ParseError, ResolutionError, SchemaError
from parser.resolver import passthrough_cmd, resolve_script
from parser.runnable import (
    ConfigFile, DebugInfo, GroupConfig, LayoutConfig, PanelConfig,
    ParsedConfig, RunnableAction, TerminalConfig,
)
from parser.schema import validate

__all__ = [
    "parse",
    "ParsedConfig", "GroupConfig", "RunnableAction", "DebugInfo", "ConfigFile",
    "LayoutConfig", "PanelConfig",
    "ParseError", "SchemaError", "ResolutionError",
]


# Auto-assigned hotkey pools by column. Position-based: top panel takes
# the first key, next takes the second, etc. Users can override per-panel
# via `hotkey:` in YAML (see _assign_hotkeys); explicit overrides are
# removed from the auto-pool first so positional defaults skip them.
_LEFT_HOTKEY_POOL = ["1", "2", "3", "4", "5", "6"]
_RIGHT_HOTKEY_POOL = ["7", "8", "9"]


def _assign_hotkeys(panels_yaml: list, pool: list[str]) -> list[str]:
    """Assign a hotkey to each panel in YAML order.

    Explicit `hotkey:` in YAML wins. Anything left over draws from `pool`
    in order, skipping keys already claimed explicitly. Empty string when
    we run out of pool slots — the panel is reachable only via h/l.
    """
    explicit = {i: str(p["hotkey"]) for i, p in enumerate(panels_yaml) if p.get("hotkey")}
    used = set(explicit.values())
    available = [k for k in pool if k not in used]
    out: list[str] = []
    for i in range(len(panels_yaml)):
        if i in explicit:
            out.append(explicit[i])
        elif available:
            out.append(available.pop(0))
        else:
            out.append("")
    return out


def _default_layout(has_containers: bool, has_files: bool) -> LayoutConfig:
    """Generate default layout based on what data exists in the config."""
    left = []
    hotkey = 1
    if has_containers:
        left.append(PanelConfig(type="containers", title="Containers",
                                hotkey=str(hotkey), column="left"))
        hotkey += 1
    left.append(PanelConfig(type="groups", title="Groups",
                            hotkey=str(hotkey), column="left"))
    hotkey += 1
    if has_files:
        left.append(PanelConfig(type="file-manager", title="Files",
                                hotkey=str(hotkey), column="left"))
    # Right column: positional 7/8/9 (actions=7, detail=8 with the default
    # 2-panel right column). Explicit overrides happen via YAML, not here.
    right = [
        PanelConfig(type="actions", title="Actions", hotkey="7", column="right"),
        PanelConfig(type="detail", title="Detail", hotkey="8", column="right"),
    ]
    return LayoutConfig(
        left_width=30, left_panels=left, right_panels=right,
        detail_height_pct=60,
    )


def _parse_layout(layout_data: dict, has_containers: bool, has_files: bool) -> LayoutConfig:
    """Parse layout section from YAML."""
    left_width = layout_data.get("left", {}).get("width", 30)
    detail_height_pct = 60

    # Reserved keys consumed by the framework; everything else passes
    # through as plugin-specific panel config (e.g. stats panel's `topic`).
    _RESERVED = {"type", "title", "hotkey", "height"}

    def _extras(pdata: dict) -> dict:
        return {k: v for k, v in pdata.items() if k not in _RESERVED}

    left_yaml = layout_data.get("left", {}).get("panels", [])
    right_yaml = layout_data.get("right", {}).get("panels", [])
    left_keys = _assign_hotkeys(left_yaml, _LEFT_HOTKEY_POOL)
    right_keys = _assign_hotkeys(right_yaml, _RIGHT_HOTKEY_POOL)

    left_panels = []
    for i, pdata in enumerate(left_yaml):
        ptype = pdata["type"]
        title = pdata.get("title", ptype.replace("_", " ").title())
        left_panels.append(PanelConfig(
            type=ptype, title=title, hotkey=left_keys[i], column="left",
            config=_extras(pdata)))

    right_panels = []
    for i, pdata in enumerate(right_yaml):
        ptype = pdata["type"]
        title = pdata.get("title", ptype.replace("_", " ").title())
        # detail panel can carry an optional height: 60% — read it once
        # while we're walking the list.
        if ptype == "detail" and "height" in pdata:
            h = pdata["height"]
            if isinstance(h, str) and h.endswith("%"):
                detail_height_pct = int(h[:-1])
            elif isinstance(h, int):
                detail_height_pct = h
        right_panels.append(PanelConfig(
            type=ptype, title=title, hotkey=right_keys[i], column="right",
            config=_extras(pdata)))

    return LayoutConfig(
        left_width=left_width, left_panels=left_panels,
        right_panels=right_panels, detail_height_pct=detail_height_pct,
    )


def _merge_yaml_plugins(data: dict, base_dir: Path) -> None:
    """Load YAML plugins listed in data['plugins'] and merge them into data.

    A plugin YAML uses the same schema as the main dev9.yml but typically
    contains only groups / vars / helpers / files. Anything else
    (layout, theme, plugins) in a plugin file is ignored.

    Merge rules:
    - Groups: new groups added; existing groups have their actions /
      terminals merged in (plugin doesn't override existing keys), and
      containers list extended.
    - Vars / helpers: plugin entries fill gaps only; main YAML wins on conflict.
    - Config files: plugin entries appended.
    """
    plugins = data.get("plugins")
    if not isinstance(plugins, dict):
        return
    for name, conf in plugins.items():
        if not isinstance(conf, dict):
            continue
        plugin_path = conf.get("path", "")
        if not plugin_path.endswith((".yml", ".yaml")):
            continue
        full = (base_dir / plugin_path).resolve()
        try:
            text = full.read_text()
        except FileNotFoundError:
            raise ParseError(f"plugin yaml not found: {full}")
        except OSError as e:
            raise ParseError(f"cannot read plugin yaml '{name}': {e}")
        try:
            pdata = yaml.safe_load(text) or {}
        except yaml.YAMLError as e:
            raise ParseError(f"invalid YAML in plugin '{name}': {e}")
        if not isinstance(pdata, dict):
            raise ParseError(f"plugin '{name}' must be a YAML mapping")
        _merge_plugin_into(data, pdata)
        # Surface the plugin file itself in the Config Files panel so
        # users can see/edit it from the TUI. Relative path (as given).
        data.setdefault("files", []).append({
            "path": plugin_path,
            "desc": f"TUI plugin: {name}",
        })


def _merge_plugin_into(main: dict, plugin: dict) -> None:
    """Merge plugin YAML fields into main config data (in-place)."""
    # Groups: extend existing or add new
    for gname, gdata in (plugin.get("groups") or {}).items():
        if not isinstance(gdata, dict):
            continue
        existing = main.setdefault("groups", {}).get(gname)
        if existing is None:
            main["groups"][gname] = gdata
        else:
            for sub in ("actions", "terminals", "children"):
                if sub in gdata and isinstance(gdata[sub], dict):
                    existing.setdefault(sub, {})
                    for k, v in gdata[sub].items():
                        existing[sub].setdefault(k, v)
            if "containers" in gdata and isinstance(gdata["containers"], list):
                existing.setdefault("containers", []).extend(gdata["containers"])
            for f in ("label", "compose"):
                if f in gdata and f not in existing:
                    existing[f] = gdata[f]
    # Vars / helpers: plugin fills gaps only
    for k, v in (plugin.get("vars") or {}).items():
        main.setdefault("vars", {}).setdefault(k, v)
    for k, v in (plugin.get("helpers") or {}).items():
        main.setdefault("helpers", {}).setdefault(k, v)
    # Config files: append
    if isinstance(plugin.get("files"), list):
        main.setdefault("files", []).extend(plugin["files"])


def _generate_config_copy_to(files: list[ConfigFile]) -> str:
    """Generate shell script to copy config files based on files list.

    Uses $COPY_SRC and $COPY_DST variables set by the calling script.
    """
    lines = []

    # Collect all parent directories that need to exist
    dirs = set()
    for cf in files:
        p = cf.path
        if p.endswith("/"):
            dirs.add(p.rstrip("/"))
        elif "*" in p:
            # glob pattern — parent dir
            dirs.add(str(Path(p).parent))
        else:
            dirs.add(str(Path(p).parent))
    # mkdir -p all destination dirs
    if dirs:
        dir_args = " ".join(f'"$COPY_DST/{d}"' for d in sorted(dirs))
        lines.append(f"mkdir -p {dir_args}")

    # Copy commands per entry
    for cf in files:
        p = cf.path
        if cf.exclude:
            # rsync with excludes (directory with exclude patterns)
            excludes = " ".join(f"--exclude='{e}'" for e in cf.exclude)
            lines.append(
                f'rsync -a {excludes} "$COPY_SRC/{p}" "$COPY_DST/{p}" 2>/dev/null || true'
            )
        elif p.endswith("/"):
            # entire directory
            lines.append(
                f'cp -a "$COPY_SRC/{p}." "$COPY_DST/{p}" 2>/dev/null || true'
            )
        elif "*" in p:
            # glob pattern — no quotes on source so glob expands
            parent = str(Path(p).parent)
            lines.append(
                f'cp -a $COPY_SRC/{p} "$COPY_DST/{parent}/" 2>/dev/null || true'
            )
        else:
            # single file
            parent = str(Path(p).parent)
            lines.append(
                f'cp -a "$COPY_SRC/{p}" "$COPY_DST/{parent}/" 2>/dev/null || true'
            )

    return "\n".join(lines) + "\n"


def _walk_groups(
    raw_groups: dict,
    vars_block: dict,
    helpers_block: dict,
    source: str,
    parent: str | None,
    depth: int,
    out: dict[str, GroupConfig],
) -> None:
    """Recursively materialize raw YAML groups into ParsedConfig.groups.

    `out` is mutated DFS pre-order: parent is inserted before its children
    so that consumers iterating Object.keys / dict order see the natural
    tree layout. Each node's `children` list holds the dotted paths of its
    direct children (also in YAML order).
    """
    for gname, gdata in raw_groups.items():
        path = f"{parent}.{gname}" if parent else gname
        containers = gdata.get("containers", [])

        # actions and children can coexist (a branch may carry aggregate
        # actions alongside its sub-tree). Both code paths run independently;
        # neither short-circuits the other.
        actions: dict[str, RunnableAction] = {}
        if "actions" in gdata:
            for aname, adata in gdata["actions"].items():
                ctx = f"group '{path}', action '{aname}'"
                if "cmd" in adata:
                    script, vars_used, helpers_used = passthrough_cmd(adata["cmd"])
                else:
                    script, vars_used, helpers_used = resolve_script(
                        adata["script"], vars_block, helpers_block, ctx,
                    )
                debug = DebugInfo(
                    source_file=source, action_line=-1,
                    vars_used=vars_used, helpers_used=helpers_used,
                    resolved_script=script,
                )
                actions[aname] = RunnableAction(
                    group=path, key=aname,
                    label=adata["label"],
                    type=adata.get("type", "run"),
                    confirm=adata.get("confirm"),
                    args=adata.get("args"),
                    default_cmd=adata.get("default_cmd"),
                    desc=adata.get("desc"),
                    tab=adata.get("tab", False),
                    script=script, containers=containers, debug=debug,
                )

        terminals: dict[str, TerminalConfig] = {}
        for tname, tdata in gdata.get("terminals", {}).items():
            terminals[tname] = TerminalConfig(
                cmd=tdata["cmd"], label=tdata["label"],
            )

        # Compute child paths up front (without recursing) so the parent
        # node's `children` is populated before we descend. Then recurse.
        child_paths = (
            [f"{path}.{c}" for c in gdata["children"].keys()]
            if "children" in gdata else []
        )

        out[path] = GroupConfig(
            name=path,
            label=gdata["label"],
            compose=gdata.get("compose"),
            containers=containers,
            actions=actions,
            terminals=terminals,
            children=child_paths,
            parent=parent,
            depth=depth,
            quick=bool(gdata.get("quick", False)),
            archive=gdata.get("archive"),
            config_branch=gdata.get("config_branch"),
            images=gdata.get("images"),
        )

        if "children" in gdata:
            _walk_groups(
                raw_groups=gdata["children"],
                vars_block=vars_block, helpers_block=helpers_block,
                source=source, parent=path, depth=depth + 1, out=out,
            )


def parse(yaml_path: str) -> ParsedConfig:
    """Parse a TUI YAML config file into a fully resolved ParsedConfig.

    Raises ParseError (or subclass) on any validation or resolution failure.
    """
    source = str(yaml_path)
    path = Path(yaml_path)

    # Read and parse YAML
    try:
        text = path.read_text()
    except FileNotFoundError:
        raise ParseError(f"config file not found: {source}")
    except OSError as e:
        raise ParseError(f"cannot read config file: {e}")

    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise ParseError(f"invalid YAML: {e}")

    if data is None:
        raise ParseError("config file is empty")

    # Load and merge YAML plugins before validation. Lets users split a
    # large dev9.yml into per-group modules referenced from `plugins:`.
    _merge_yaml_plugins(data, path.resolve().parent)

    # Schema validation
    validate(data, source)

    # Build files list (before groups, needed for helper generation)
    files: list[ConfigFile] = []
    for entry in data.get("files", []):
        if isinstance(entry, str):
            files.append(ConfigFile(path=entry))
        else:
            files.append(ConfigFile(
                path=entry["path"],
                var=entry.get("var"),
                desc=entry.get("desc"),
                exclude=entry.get("exclude", []),
                category=entry.get("category"),
            ))

    # Extract top-level blocks
    vars_block = data.get("vars", {})
    helpers_block = dict(data.get("helpers", {}))  # copy — we may inject generated helpers
    raw_project_dir = data.get("project_dir", ".")

    # Auto-generate config_copy_to helper from files
    if files and "config_copy_to" not in helpers_block:
        helpers_block["config_copy_to"] = _generate_config_copy_to(files)

    # Resolve project_dir relative to the YAML file's directory
    yaml_dir = path.resolve().parent
    project_dir = str((yaml_dir / raw_project_dir).resolve())

    # Build groups — flat dict keyed by dotted path, DFS pre-order so parent
    # is inserted before its children. Layouts and the JS side rely on this
    # ordering (see plugins/core/groups.js#flattenedGroups).
    groups: dict[str, GroupConfig] = {}
    _walk_groups(
        raw_groups=data["groups"], vars_block=vars_block, helpers_block=helpers_block,
        source=source, parent=None, depth=0, out=groups,
    )

    # Build layout
    has_containers = any(g.containers for g in groups.values())
    has_files = bool(files)
    if "layout" in data:
        layout = _parse_layout(data["layout"], has_containers, has_files)
    else:
        layout = _default_layout(has_containers, has_files)

    return ParsedConfig(
        project_dir=project_dir,
        groups=groups,
        source_file=source,
        files=files,
        layout=layout,
        theme=data.get("theme", "monokai"),
    )
