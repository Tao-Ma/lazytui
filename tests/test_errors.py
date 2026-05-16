from __future__ import annotations

from parser.errors import ParseError, ResolutionError, SchemaError


def test_parse_error_message():
    e = ParseError("bad input")
    assert str(e) == "bad input"


def test_parse_error_with_context():
    e = ParseError("missing field", context="group 'core'")
    assert str(e) == "group 'core': missing field"


def test_parse_error_with_line():
    e = ParseError("bad type", line=42)
    assert str(e) == "line 42: bad type"


def test_parse_error_with_context_and_line():
    e = ParseError("oops", context="action 'up'", line=10)
    assert str(e) == "line 10: action 'up': oops"


def test_parse_error_attributes():
    e = ParseError("msg", context="ctx", line=7)
    assert e.context == "ctx"
    assert e.line == 7


def test_parse_error_no_context_no_line():
    e = ParseError("plain")
    assert e.context is None
    assert e.line is None


def test_schema_error_is_parse_error():
    e = SchemaError("bad schema")
    assert isinstance(e, ParseError)
    assert isinstance(e, SchemaError)


def test_resolution_error_is_parse_error():
    e = ResolutionError("undefined var")
    assert isinstance(e, ParseError)
    assert isinstance(e, ResolutionError)


def test_schema_error_with_context():
    e = SchemaError("wrong type", context="group 'vpn', action 'up'")
    assert "group 'vpn', action 'up'" in str(e)


def test_resolution_error_with_context():
    e = ResolutionError("no helper 'foo'", context="action 'init'")
    assert "action 'init'" in str(e)
