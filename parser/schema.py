"""YAML schema validation for TUI config."""
from __future__ import annotations

from parser.errors import SchemaError

VALID_ACTION_TYPES = {"run", "spawn", "background"}

VALID_TOP_KEYS = {"project_dir", "groups", "vars", "helpers", "files", "layout", "theme", "plugins"}
VALID_FILE_KEYS = {"path", "var", "desc", "exclude", "category"}
VALID_GROUP_KEYS = {"label", "compose", "containers", "actions", "terminals", "children", "quick", "archive", "config_branch", "images"}
VALID_ARCHIVE_KEYS = {"target", "output_dir", "name"}
VALID_CONFIG_BRANCH_KEYS = {"branch", "paths", "excludes", "source", "categories"}
VALID_IMAGES_KEYS = {"list", "output_dir"}
VALID_TERMINAL_KEYS = {"cmd", "label"}
VALID_ACTION_KEYS = {"cmd", "script", "label", "type", "confirm", "args", "default_cmd", "desc", "tab"}


def validate(data: dict, source_file: str) -> None:
    """Validate raw YAML data against the TUI config schema.

    Raises SchemaError on any structural or type violation.
    """
    if not isinstance(data, dict):
        raise SchemaError("config must be a YAML mapping")

    _check_unknown_keys(data, VALID_TOP_KEYS, "top level")

    # groups: required, non-empty dict
    if "groups" not in data:
        raise SchemaError("'groups' is required")
    groups = data["groups"]
    if not isinstance(groups, dict) or not groups:
        raise SchemaError("'groups' must be a non-empty mapping")

    # project_dir: optional str
    if "project_dir" in data and not isinstance(data["project_dir"], str):
        raise SchemaError("'project_dir' must be a string")

    # vars: optional dict[str, str]
    if "vars" in data:
        _validate_vars(data["vars"])

    # helpers: optional dict[str, str]
    if "helpers" in data:
        _validate_helpers(data["helpers"])

    # files: optional list
    if "files" in data:
        _validate_files(data["files"])

    for gname, gdata in groups.items():
        _validate_group(gname, gdata)


def _join_path(parent_path: str, name: str) -> str:
    """Dotted path for nested-group context strings: 'a.b.c'."""
    return f"{parent_path}.{name}" if parent_path else name


def _validate_vars(vars_block: object) -> None:
    if not isinstance(vars_block, dict):
        raise SchemaError("'vars' must be a mapping")
    for k, v in vars_block.items():
        if not isinstance(k, str):
            raise SchemaError(f"var key must be a string, got {type(k).__name__}")
        if not isinstance(v, str):
            raise SchemaError(
                f"var '{k}' value must be a string, got {type(v).__name__}",
                context=f"vars",
            )


def _validate_helpers(helpers_block: object) -> None:
    if not isinstance(helpers_block, dict):
        raise SchemaError("'helpers' must be a mapping")
    for k, v in helpers_block.items():
        if not isinstance(k, str):
            raise SchemaError(f"helper key must be a string, got {type(k).__name__}")
        if not isinstance(v, str):
            raise SchemaError(
                f"helper '{k}' value must be a string",
                context=f"helpers",
            )


def _validate_files(files: object) -> None:
    if not isinstance(files, list):
        raise SchemaError("'files' must be a list")
    for i, entry in enumerate(files):
        ctx = f"files[{i}]"
        if isinstance(entry, str):
            continue  # bare path string is fine
        if isinstance(entry, dict):
            if "path" not in entry:
                raise SchemaError("'path' is required", context=ctx)
            if not isinstance(entry["path"], str):
                raise SchemaError("'path' must be a string", context=ctx)
            _check_unknown_keys(entry, VALID_FILE_KEYS, ctx)
            if "var" in entry and not isinstance(entry["var"], str):
                raise SchemaError("'var' must be a string", context=ctx)
            if "desc" in entry and not isinstance(entry["desc"], str):
                raise SchemaError("'desc' must be a string", context=ctx)
            if "exclude" in entry:
                if not isinstance(entry["exclude"], list):
                    raise SchemaError("'exclude' must be a list", context=ctx)
            if "category" in entry and not isinstance(entry["category"], str):
                raise SchemaError("'category' must be a string", context=ctx)
        else:
            raise SchemaError("must be a string or mapping", context=ctx)


def _validate_group(gname: str, gdata: object, parent_path: str = "") -> None:
    full = _join_path(parent_path, gname)
    ctx = f"group '{full}'"
    if not isinstance(gdata, dict):
        raise SchemaError("must be a mapping", context=ctx)

    _check_unknown_keys(gdata, VALID_GROUP_KEYS, ctx)

    # label: required str
    if "label" not in gdata:
        raise SchemaError("'label' is required", context=ctx)
    if not isinstance(gdata["label"], str):
        raise SchemaError("'label' must be a string", context=ctx)

    # containers: optional list[str], defaults to [] if absent.
    # (Was required pre-tree; relaxed so branch nodes don't need to repeat
    # the empty list at every level. Leaves still typically declare them.)
    if "containers" in gdata:
        containers = gdata["containers"]
        if not isinstance(containers, list):
            raise SchemaError("'containers' must be a list", context=ctx)
        for c in containers:
            if not isinstance(c, str):
                raise SchemaError(
                    f"container name must be a string, got {type(c).__name__}",
                    context=ctx,
                )

    # A node must declare actions (executable surface) or children
    # (sub-tree) or both. A branch with actions is an aggregate node —
    # the actions typically compose its descendants (e.g. `service:up`
    # → core up → dev9 up). Earlier the schema enforced actions-XOR-
    # children; that's been relaxed so do.md-style aggregates can live
    # on branch groups without spawning sibling leaves.
    has_actions = "actions" in gdata
    has_children = "children" in gdata
    if not has_actions and not has_children:
        raise SchemaError(
            "must have 'actions', 'children', or both",
            context=ctx,
        )

    # compose: optional str
    if "compose" in gdata and not isinstance(gdata["compose"], str):
        raise SchemaError("'compose' must be a string", context=ctx)

    # archive: optional mapping — declares the input + output for the
    # archive plugin's `groupActions` synthesis (tar+xz+sha256 backup).
    # Required: target (dir to archive), name (archive base filename).
    # Optional: output_dir (where to write; defaults to "." at action time).
    if "archive" in gdata:
        archive = gdata["archive"]
        if not isinstance(archive, dict):
            raise SchemaError("'archive' must be a mapping", context=ctx)
        _check_unknown_keys(archive, VALID_ARCHIVE_KEYS, f"{ctx}, archive")
        for required in ("target", "name"):
            if required not in archive:
                raise SchemaError(f"'archive.{required}' is required", context=ctx)
            if not isinstance(archive[required], str) or not archive[required]:
                raise SchemaError(f"'archive.{required}' must be a non-empty string", context=ctx)
        if "output_dir" in archive and not isinstance(archive["output_dir"], str):
            raise SchemaError("'archive.output_dir' must be a string", context=ctx)

    # config_branch: optional mapping — declares the branch + paths for
    # the config-branch plugin's `groupActions` synthesis (git-branch-as-
    # config-store: save / load / check-stale). Required: branch (str),
    # paths (non-empty list of strings).
    if "config_branch" in gdata:
        cb = gdata["config_branch"]
        if not isinstance(cb, dict):
            raise SchemaError("'config_branch' must be a mapping", context=ctx)
        _check_unknown_keys(cb, VALID_CONFIG_BRANCH_KEYS, f"{ctx}, config_branch")
        if "branch" not in cb or not isinstance(cb["branch"], str) or not cb["branch"]:
            raise SchemaError("'config_branch.branch' must be a non-empty string", context=ctx)
        # State source: exactly one of `paths:` or `source:`. `source: files`
        # references the top-level files: registry — keeps the plugin from
        # holding user state and avoids re-declaring the same path set.
        has_source = "source" in cb
        has_paths = "paths" in cb
        if has_source and has_paths:
            raise SchemaError(
                "'config_branch' cannot set both 'source' and 'paths' — pick one",
                context=ctx,
            )
        if not has_source and not has_paths:
            raise SchemaError(
                "'config_branch' must declare 'paths' (explicit list) or 'source' (reference)",
                context=ctx,
            )
        if has_source:
            if cb["source"] != "files":
                raise SchemaError(
                    "'config_branch.source' must be \"files\" (the only supported reference)",
                    context=ctx,
                )
            if "excludes" in cb:
                raise SchemaError(
                    "'config_branch.excludes' cannot be combined with 'source: files' — "
                    "declare per-file 'exclude:' on the relevant 'files:' entries instead",
                    context=ctx,
                )
            if "categories" in cb:
                cats = cb["categories"]
                if not isinstance(cats, list) or not cats:
                    raise SchemaError(
                        "'config_branch.categories' must be a non-empty list",
                        context=ctx,
                    )
                for i, c in enumerate(cats):
                    if not isinstance(c, str) or not c:
                        raise SchemaError(
                            f"'config_branch.categories[{i}]' must be a non-empty string",
                            context=ctx,
                        )
        elif "categories" in cb:
            raise SchemaError(
                "'config_branch.categories' is only valid with 'source: files'",
                context=ctx,
            )
        else:
            paths = cb["paths"]
            if not isinstance(paths, list) or not paths:
                raise SchemaError("'config_branch.paths' must be a non-empty list", context=ctx)
            for i, p in enumerate(paths):
                if not isinstance(p, str) or not p:
                    raise SchemaError(f"'config_branch.paths[{i}]' must be a non-empty string", context=ctx)
            if "excludes" in cb:
                excludes = cb["excludes"]
                if not isinstance(excludes, list):
                    raise SchemaError("'config_branch.excludes' must be a list", context=ctx)
                for i, e in enumerate(excludes):
                    if not isinstance(e, str) or not e:
                        raise SchemaError(f"'config_branch.excludes[{i}]' must be a non-empty string", context=ctx)

    # images: optional mapping — declares the list of docker images and
    # output dir for the image-backup plugin's `groupActions` synthesis
    # (docker save / load with gzip). Required: list (non-empty list of
    # image refs). Optional: output_dir (default ".").
    if "images" in gdata:
        images = gdata["images"]
        if not isinstance(images, dict):
            raise SchemaError("'images' must be a mapping", context=ctx)
        _check_unknown_keys(images, VALID_IMAGES_KEYS, f"{ctx}, images")
        ilist = images.get("list")
        if not isinstance(ilist, list) or not ilist:
            raise SchemaError("'images.list' must be a non-empty list", context=ctx)
        for i, img in enumerate(ilist):
            if not isinstance(img, str) or not img:
                raise SchemaError(f"'images.list[{i}]' must be a non-empty string", context=ctx)
        if "output_dir" in images and not isinstance(images["output_dir"], str):
            raise SchemaError("'images.output_dir' must be a string", context=ctx)

    # quick: optional bool — surfaces this node in the groups panel's
    # "Quick" tab (flat pinned list, no tree expansion). Works on any
    # depth: a deep leaf marked `quick: true` is reachable in one row.
    if "quick" in gdata and not isinstance(gdata["quick"], bool):
        raise SchemaError("'quick' must be a boolean", context=ctx)

    if has_actions:
        actions = gdata["actions"]
        if not isinstance(actions, dict) or not actions:
            raise SchemaError("'actions' must be a non-empty mapping", context=ctx)
        for aname, adata in actions.items():
            _validate_action(full, aname, adata)

    if has_children:
        children = gdata["children"]
        if not isinstance(children, dict) or not children:
            raise SchemaError("'children' must be a non-empty mapping", context=ctx)
        for cname, cdata in children.items():
            _validate_group(cname, cdata, parent_path=full)

    # terminals: optional dict (allowed on either leaves or branches today —
    # the runtime only consumes them off the currently-selected group anyway).
    if "terminals" in gdata:
        terminals = gdata["terminals"]
        if not isinstance(terminals, dict):
            raise SchemaError("'terminals' must be a mapping", context=ctx)
        for tname, tdata in terminals.items():
            _validate_terminal(full, tname, tdata)


def _validate_action(group_path: str, aname: str, adata: object) -> None:
    ctx = f"group '{group_path}', action '{aname}'"
    if not isinstance(adata, dict):
        raise SchemaError("must be a mapping", context=ctx)

    _check_unknown_keys(adata, VALID_ACTION_KEYS, ctx)

    # exactly one of cmd or script
    has_cmd = "cmd" in adata
    has_script = "script" in adata
    if has_cmd and has_script:
        raise SchemaError("must have exactly one of 'cmd' or 'script', not both", context=ctx)
    if not has_cmd and not has_script:
        raise SchemaError("must have exactly one of 'cmd' or 'script'", context=ctx)

    if has_cmd and not isinstance(adata["cmd"], str):
        raise SchemaError("'cmd' must be a string", context=ctx)
    if has_script and not isinstance(adata["script"], str):
        raise SchemaError("'script' must be a string", context=ctx)

    # label: required str
    if "label" not in adata:
        raise SchemaError("'label' is required", context=ctx)
    if not isinstance(adata["label"], str):
        raise SchemaError("'label' must be a string", context=ctx)

    # type: optional, must be valid
    if "type" in adata:
        if adata["type"] not in VALID_ACTION_TYPES:
            raise SchemaError(
                f"'type' must be one of {sorted(VALID_ACTION_TYPES)}, "
                f"got '{adata['type']}'",
                context=ctx,
            )

    # confirm: optional str
    if "confirm" in adata and not isinstance(adata["confirm"], str):
        raise SchemaError("'confirm' must be a string", context=ctx)

    # desc: optional str
    if "desc" in adata and not isinstance(adata["desc"], str):
        raise SchemaError("'desc' must be a string", context=ctx)

    # args: optional str
    if "args" in adata and not isinstance(adata["args"], str):
        raise SchemaError("'args' must be a string", context=ctx)

    # default_cmd: optional str — a small shell command the TUI runs at
    # prompt-open to compute the default value, which is then pre-filled
    # into the input field. Useful when the default is dynamic (parsed
    # out of an env file, etc). Only meaningful if `args:` is also set.
    if "default_cmd" in adata:
        if not isinstance(adata["default_cmd"], str):
            raise SchemaError("'default_cmd' must be a string", context=ctx)
        if "args" not in adata:
            raise SchemaError(
                "'default_cmd' requires 'args' to be set (default fills the prompt)",
                context=ctx,
            )

    # tab: optional bool
    if "tab" in adata and not isinstance(adata["tab"], bool):
        raise SchemaError("'tab' must be a boolean", context=ctx)


def _validate_terminal(group_path: str, tname: str, tdata: object) -> None:
    ctx = f"group '{group_path}', terminal '{tname}'"
    if not isinstance(tdata, dict):
        raise SchemaError("must be a mapping", context=ctx)
    _check_unknown_keys(tdata, VALID_TERMINAL_KEYS, ctx)
    if "cmd" not in tdata:
        raise SchemaError("'cmd' is required", context=ctx)
    if not isinstance(tdata["cmd"], str):
        raise SchemaError("'cmd' must be a string", context=ctx)
    if "label" not in tdata:
        raise SchemaError("'label' is required", context=ctx)
    if not isinstance(tdata["label"], str):
        raise SchemaError("'label' must be a string", context=ctx)


def _check_unknown_keys(data: dict, valid: set[str], context: str) -> None:
    unknown = set(data.keys()) - valid
    if unknown:
        raise SchemaError(
            f"unknown key(s): {', '.join(sorted(unknown))}",
            context=context,
        )
