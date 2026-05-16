"""Integration tests for the full parse() pipeline."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from parser import parse
from parser.errors import ParseError, ResolutionError, SchemaError
from parser.runnable import DebugInfo, GroupConfig, ParsedConfig, RunnableAction
from tests.conftest import FIXTURES_DIR, parse_fixture


# --- Successful parsing ---

def test_parse_minimal_cmd():
    cfg = parse_fixture("minimal_cmd.yml")
    assert isinstance(cfg, ParsedConfig)
    assert len(cfg.groups) == 1
    assert "mygroup" in cfg.groups
    g = cfg.groups["mygroup"]
    assert g.label == "My Group"
    assert len(g.actions) == 1
    a = g.actions["hello"]
    assert a.script == "echo hello"
    assert a.type == "run"
    assert a.confirm is None


def test_parse_full_cmd():
    cfg = parse_fixture("full_cmd.yml")
    assert len(cfg.groups) == 4
    assert set(cfg.groups.keys()) == {"dev9-core", "dev9-vpn", "work", "config"}

    # dev9-core has 7 actions
    core = cfg.groups["dev9-core"]
    assert len(core.actions) == 7
    assert core.label == "Core Services"
    assert core.compose == "docker-compose.yml"

    # All cmd: actions have script == cmd
    for a in core.actions.values():
        assert isinstance(a.script, str)
        assert len(a.script) > 0

    # Check specific action
    ssh = core.actions["ssh"]
    assert ssh.script == "./do.sh dev9-core ssh"
    assert ssh.type == "spawn"
    assert ssh.confirm is None

    init = core.actions["init"]
    assert init.confirm == "Initialize SSH keys + VPN server?"


def test_parse_with_vars():
    cfg = parse_fixture("with_vars.yml")
    a = cfg.groups["test"].actions["connect"]
    assert "client/id_ed25519" in a.script
    assert "2222" in a.script
    assert a.type == "spawn"
    assert a.debug.vars_used == {"KEY_FILE": "client/id_ed25519", "PORT": "2222"}


def test_parse_with_helpers():
    cfg = parse_fixture("with_helpers.yml")
    a = cfg.groups["test"].actions["init"]
    assert "ssh-keygen" in a.script
    assert "echo \"Done.\"" in a.script
    assert a.debug.helpers_used == ["init_ssh"]
    assert a.confirm == "Initialize?"


def test_parse_mixed_cmd_script():
    cfg = parse_fixture("mixed_cmd_script.yml")
    svc = cfg.groups["svc"]

    # cmd action: passthrough
    up = svc.actions["up"]
    assert up.script == "docker compose up -d"
    assert up.debug.vars_used == {}
    assert up.debug.helpers_used == []

    # script action: resolved
    status = svc.actions["status"]
    assert "docker compose -f docker-compose.yml ps --format json" in status.script
    assert "echo \"Done checking.\"" in status.script
    assert status.debug.helpers_used == ["check_ready"]
    assert status.debug.vars_used == {"COMPOSE_FILE": "docker-compose.yml"}


# --- Defaults ---

def test_action_type_defaults_to_run():
    cfg = parse_fixture("minimal_cmd.yml")
    a = cfg.groups["mygroup"].actions["hello"]
    assert a.type == "run"


def test_confirm_absent_is_none():
    cfg = parse_fixture("minimal_cmd.yml")
    a = cfg.groups["mygroup"].actions["hello"]
    assert a.confirm is None


def test_compose_absent_is_none():
    cfg = parse_fixture("full_cmd.yml")
    assert cfg.groups["config"].compose is None


def test_compose_present():
    cfg = parse_fixture("full_cmd.yml")
    assert cfg.groups["dev9-core"].compose == "docker-compose.yml"


def test_containers_populated():
    cfg = parse_fixture("full_cmd.yml")
    assert "dev9-env" in cfg.groups["dev9-core"].containers
    assert len(cfg.groups["dev9-core"].containers) == 7


def test_containers_empty():
    cfg = parse_fixture("minimal_cmd.yml")
    assert cfg.groups["mygroup"].containers == []


# --- Debug info ---

def test_debug_info_populated():
    cfg = parse_fixture("minimal_cmd.yml")
    a = cfg.groups["mygroup"].actions["hello"]
    assert isinstance(a.debug, DebugInfo)
    assert "minimal_cmd.yml" in a.debug.source_file
    assert a.debug.action_line == -1
    assert a.debug.resolved_script == "echo hello"


# --- project_dir ---

def test_project_dir_resolved_absolute():
    cfg = parse_fixture("minimal_cmd.yml")
    assert os.path.isabs(cfg.project_dir)


def test_project_dir_relative_to_yaml(tmp_yaml):
    p = tmp_yaml("""\
project_dir: subdir
groups:
  g:
    label: G
    containers: []
    actions:
      a:
        cmd: echo
        label: A
""")
    cfg = parse(str(p))
    expected = str((p.parent / "subdir").resolve())
    assert cfg.project_dir == expected


# --- Groups preserve YAML order ---

def test_groups_preserve_order():
    cfg = parse_fixture("full_cmd.yml")
    keys = list(cfg.groups.keys())
    assert keys == ["dev9-core", "dev9-vpn", "work", "config"]


# --- Nested groups (tree) ---

def test_parse_nested_groups_flat_dict():
    """All nodes (root, branches, leaves) live in cfg.groups keyed by dotted path."""
    cfg = parse_fixture("nested_groups.yml")
    keys = list(cfg.groups.keys())
    # DFS pre-order: parent before children, siblings in YAML order.
    assert keys == [
        "root",
        "root.branch",
        "root.branch.leaf",
        "root.sibling-leaf",
    ]


def test_nested_groups_metadata():
    cfg = parse_fixture("nested_groups.yml")
    root = cfg.groups["root"]
    assert root.parent is None
    assert root.depth == 0
    assert root.children == ["root.branch", "root.sibling-leaf"]
    assert root.actions == {}

    branch = cfg.groups["root.branch"]
    assert branch.parent == "root"
    assert branch.depth == 1
    assert branch.children == ["root.branch.leaf"]

    leaf = cfg.groups["root.branch.leaf"]
    assert leaf.parent == "root.branch"
    assert leaf.depth == 2
    assert leaf.children == []
    assert leaf.containers == ["cont-a"]
    assert set(leaf.actions.keys()) == {"hi", "bye"}


def test_nested_action_carries_full_path_as_group():
    cfg = parse_fixture("nested_groups.yml")
    a = cfg.groups["root.branch.leaf"].actions["hi"]
    assert a.group == "root.branch.leaf"


def test_panel_hotkeys_positional_default(tmp_yaml):
    """Without explicit hotkeys, left panels get 1-6 and right get 7-9 by position."""
    p = tmp_yaml("""\
groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
layout:
  left:
    panels:
      - { type: containers, title: C }
      - { type: groups, title: G }
  right:
    panels:
      - { type: actions, title: A }
      - { type: stats, title: S }
      - { type: detail, title: D }
""")
    cfg = parse(str(p))
    left = [(pp.hotkey, pp.type) for pp in cfg.layout.left_panels]
    right = [(pp.hotkey, pp.type) for pp in cfg.layout.right_panels]
    assert left == [("1", "containers"), ("2", "groups")]
    assert right == [("7", "actions"), ("8", "stats"), ("9", "detail")]


def test_panel_hotkey_explicit_override(tmp_yaml):
    """Explicit `hotkey:` wins; remaining panels skip claimed keys."""
    p = tmp_yaml("""\
groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
layout:
  left:
    panels:
      - { type: groups, title: G, hotkey: g }
  right:
    panels:
      - { type: actions, title: A }
      - { type: detail, title: D, hotkey: o }
""")
    cfg = parse(str(p))
    assert cfg.layout.left_panels[0].hotkey == "g"
    # actions takes 7 (first in pool, 'o' isn't in the right pool); detail keeps 'o'.
    rights = [(pp.hotkey, pp.type) for pp in cfg.layout.right_panels]
    assert rights == [("7", "actions"), ("o", "detail")]


def test_quick_field_defaults_false_and_round_trips(tmp_yaml):
    """quick: bool flows through to GroupConfig.quick (default False)."""
    p = tmp_yaml("""\
groups:
  pinned:
    label: Pinned
    quick: true
    actions:
      a: { cmd: 'echo', label: A }
  unpinned:
    label: Unpinned
    actions:
      b: { cmd: 'echo', label: B }
""")
    cfg = parse(str(p))
    assert cfg.groups["pinned"].quick is True
    assert cfg.groups["unpinned"].quick is False


# --- Error propagation ---

def test_parse_invalid_yaml_syntax(tmp_yaml):
    p = tmp_yaml("groups:\n  - bad: [unclosed")
    with pytest.raises(ParseError):
        parse(str(p))


def test_parse_file_not_found():
    with pytest.raises(ParseError, match="not found"):
        parse("/nonexistent/path.yml")


def test_parse_empty_file(tmp_yaml):
    p = tmp_yaml("")
    with pytest.raises(ParseError, match="empty"):
        parse(str(p))


def test_schema_error_propagates(tmp_yaml):
    p = tmp_yaml("project_dir: .\n")
    with pytest.raises(SchemaError, match="'groups' is required"):
        parse(str(p))


def test_resolution_error_propagates(tmp_yaml):
    p = tmp_yaml("""\
groups:
  g:
    label: G
    containers: []
    actions:
      a:
        label: A
        script: |
          @use nonexistent
""")
    with pytest.raises(ResolutionError, match="undefined helper"):
        parse(str(p))


# --- Args ---

def test_parse_args_present(tmp_yaml):
    p = tmp_yaml("""\
groups:
  g:
    label: G
    containers: []
    actions:
      gen:
        label: Generate
        args: client-name
        script: |
          echo $1
""")
    cfg = parse(str(p))
    assert cfg.groups["g"].actions["gen"].args == "client-name"


def test_parse_args_absent(tmp_yaml):
    p = tmp_yaml("""\
groups:
  g:
    label: G
    containers: []
    actions:
      up:
        cmd: echo up
        label: Up
""")
    cfg = parse(str(p))
    assert cfg.groups["g"].actions["up"].args is None


def test_parse_default_cmd_carried(tmp_yaml):
    p = tmp_yaml("""\
groups:
  g:
    label: G
    containers: []
    actions:
      ping:
        label: Ping
        args: '[host]'
        default_cmd: 'echo example.com'
        script: 'echo $1'
""")
    cfg = parse(str(p))
    a = cfg.groups["g"].actions["ping"]
    assert a.default_cmd == 'echo example.com'
    assert a.args == '[host]'


def test_parse_default_cmd_absent_is_none(tmp_yaml):
    p = tmp_yaml("""\
groups:
  g:
    label: G
    containers: []
    actions:
      up:
        cmd: echo up
        label: Up
""")
    cfg = parse(str(p))
    assert cfg.groups["g"].actions["up"].default_cmd is None


# --- Parse real dev9.yml ---

def test_parse_real_dev9_yml():
    """Parse the actual project dev9.yml as a regression test."""
    real_yml = Path(__file__).parents[3] / "dev9.yml"
    if not real_yml.exists():
        pytest.skip("dev9.yml not found at project root")
    cfg = parse(str(real_yml))
    assert len(cfg.groups) == 7
    assert "dev9-core" in cfg.groups
    assert "dev9" in cfg.groups
    assert "dev9-vpn" in cfg.groups
    assert "work" in cfg.groups
    assert "config" in cfg.groups
    assert "build" in cfg.groups
    assert "maintenance" in cfg.groups
    # All actions should have non-empty scripts
    for g in cfg.groups.values():
        for a in g.actions.values():
            assert isinstance(a.script, str)
            assert len(a.script) > 0
