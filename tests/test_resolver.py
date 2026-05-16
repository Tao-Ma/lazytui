from __future__ import annotations

import pytest

from parser.errors import ResolutionError
from parser.resolver import passthrough_cmd, resolve_script


# --- passthrough_cmd ---

def test_passthrough_cmd():
    script, vars_used, helpers_used = passthrough_cmd("docker compose up -d")
    assert script == "docker compose up -d"
    assert vars_used == {}
    assert helpers_used == []


# --- Variable resolution ---

def test_resolve_single_var():
    script, vu, _ = resolve_script(
        "ssh -i $KEY_FILE root@localhost",
        {"KEY_FILE": "client/id_ed25519"}, {}, "test",
    )
    assert script == "ssh -i client/id_ed25519 root@localhost"
    assert vu == {"KEY_FILE": "client/id_ed25519"}


def test_resolve_braced_var():
    script, vu, _ = resolve_script(
        "echo ${KEY_FILE}",
        {"KEY_FILE": "foo"}, {}, "test",
    )
    assert script == "echo foo"
    assert vu == {"KEY_FILE": "foo"}


def test_resolve_multiple_vars():
    script, vu, _ = resolve_script(
        "ssh -i $KEY -p $PORT host",
        {"KEY": "k", "PORT": "22"}, {}, "test",
    )
    assert script == "ssh -i k -p 22 host"
    assert vu == {"KEY": "k", "PORT": "22"}


def test_unknown_var_left_alone():
    script, vu, _ = resolve_script(
        "echo $HOME $MY_VAR",
        {"MY_VAR": "x"}, {}, "test",
    )
    assert script == "echo $HOME x"
    assert vu == {"MY_VAR": "x"}


def test_shell_special_vars_untouched():
    """$1, $?, $@ etc. are not valid identifiers for our regex, left alone."""
    script, vu, _ = resolve_script(
        'echo $? $1 "$@"',
        {}, {}, "test",
    )
    assert script == 'echo $? $1 "$@"'
    assert vu == {}


def test_vars_used_only_tracks_used():
    """vars_block may have extra vars; only used ones appear in vars_used."""
    _, vu, _ = resolve_script(
        "echo $A",
        {"A": "1", "B": "2", "C": "3"}, {}, "test",
    )
    assert vu == {"A": "1"}


# --- Helper resolution ---

def test_resolve_helper():
    script, _, hu = resolve_script(
        "@use greet\necho done\n",
        {}, {"greet": "echo hello\n"}, "test",
    )
    assert "echo hello" in script
    assert "echo done" in script
    assert hu == ["greet"]


def test_resolve_helper_not_found():
    with pytest.raises(ResolutionError, match="undefined helper 'nope'"):
        resolve_script("@use nope\n", {}, {}, "test")


def test_helper_vars_resolved():
    """Variables inside helper bodies get resolved after expansion."""
    script, vu, hu = resolve_script(
        "@use setup\n",
        {"FILE": "x.txt"},
        {"setup": "cat $FILE\n"},
        "test",
    )
    assert "cat x.txt" in script
    assert vu == {"FILE": "x.txt"}
    assert hu == ["setup"]


def test_multiple_helpers():
    script, _, hu = resolve_script(
        "@use a\n@use b\n",
        {},
        {"a": "echo A\n", "b": "echo B\n"},
        "test",
    )
    assert "echo A" in script
    assert "echo B" in script
    assert hu == ["a", "b"]


def test_helpers_used_tracking():
    _, _, hu = resolve_script(
        "@use x\n", {}, {"x": "echo\n", "y": "echo\n"}, "test",
    )
    assert hu == ["x"]


def test_use_must_be_whole_line():
    """@use in the middle of a line should NOT trigger expansion."""
    script, _, hu = resolve_script(
        "echo @use foo\n",
        {}, {"foo": "REPLACED\n"}, "test",
    )
    assert "echo @use foo" in script
    assert hu == []


def test_no_vars_no_helpers():
    script, vu, hu = resolve_script(
        "echo plain\n", {}, {}, "test",
    )
    assert script == "echo plain\n"
    assert vu == {}
    assert hu == []


def test_helper_preserves_indentation():
    """@use with leading whitespace should indent the helper body."""
    script, _, _ = resolve_script(
        "if true; then\n    @use body\nfi\n",
        {}, {"body": "echo ok\n"}, "test",
    )
    assert "    echo ok" in script


def test_error_includes_context():
    with pytest.raises(ResolutionError, match="action 'init'"):
        resolve_script("@use missing\n", {}, {}, "action 'init'")
