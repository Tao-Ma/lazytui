from __future__ import annotations

from parser.runnable import DebugInfo, GroupConfig, ParsedConfig, RunnableAction


def _make_debug(**kw):
    defaults = dict(
        source_file="test.yml", action_line=-1,
        vars_used={}, helpers_used=[], resolved_script="echo hi",
    )
    defaults.update(kw)
    return DebugInfo(**defaults)


def _make_action(**kw):
    defaults = dict(
        group="g", key="k", label="L", type="run",
        confirm=None, args=None, default_cmd=None, desc=None, tab=False,
        script="echo hi",
        containers=[], debug=_make_debug(),
    )
    defaults.update(kw)
    return RunnableAction(**defaults)


def test_debug_info_defaults():
    d = DebugInfo(source_file="f.yml", action_line=10)
    assert d.source_file == "f.yml"
    assert d.action_line == 10
    assert d.vars_used == {}
    assert d.helpers_used == []
    assert d.resolved_script == ""


def test_debug_info_with_data():
    d = DebugInfo(
        source_file="x.yml", action_line=5,
        vars_used={"A": "1"}, helpers_used=["h1"],
        resolved_script="echo 1",
    )
    assert d.vars_used == {"A": "1"}
    assert d.helpers_used == ["h1"]
    assert d.resolved_script == "echo 1"


def test_runnable_action_fields():
    a = _make_action(group="core", key="up", label="Start", type="run",
                     confirm="Sure?", script="docker up", containers=["c1"])
    assert a.group == "core"
    assert a.key == "up"
    assert a.label == "Start"
    assert a.type == "run"
    assert a.confirm == "Sure?"
    assert a.script == "docker up"
    assert a.containers == ["c1"]
    assert isinstance(a.debug, DebugInfo)


def test_runnable_action_confirm_none():
    a = _make_action(confirm=None)
    assert a.confirm is None


def test_runnable_action_default_cmd_carried():
    """default_cmd should pass through unchanged for the JS side to read."""
    a = _make_action(args="[host]", default_cmd='grep DOMAINS conf/noip.env')
    assert a.default_cmd == 'grep DOMAINS conf/noip.env'
    b = _make_action()
    assert b.default_cmd is None


def test_group_config_fields():
    a = _make_action()
    g = GroupConfig(name="core", label="Core", compose="dc.yml",
                    containers=["c1", "c2"], actions={"k": a})
    assert g.name == "core"
    assert g.label == "Core"
    assert g.compose == "dc.yml"
    assert g.containers == ["c1", "c2"]
    assert g.actions["k"] is a


def test_group_config_no_compose():
    g = GroupConfig(name="cfg", label="Config", compose=None,
                    containers=[], actions={})
    assert g.compose is None


def test_parsed_config_fields():
    g = GroupConfig(name="g", label="G", compose=None, containers=[], actions={})
    pc = ParsedConfig(project_dir="/tmp", groups={"g": g}, source_file="f.yml")
    assert pc.project_dir == "/tmp"
    assert pc.source_file == "f.yml"
    assert "g" in pc.groups
    assert pc.groups["g"] is g
