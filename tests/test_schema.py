from __future__ import annotations

import yaml
import pytest

from parser.errors import SchemaError
from parser.schema import validate


def _load(path):
    with open(path) as f:
        return yaml.safe_load(f)


# --- Valid configs ---

def test_validate_minimal_cmd(fixtures_dir):
    validate(_load(fixtures_dir / "minimal_cmd.yml"), "minimal_cmd.yml")


def test_validate_full_cmd(fixtures_dir):
    validate(_load(fixtures_dir / "full_cmd.yml"), "full_cmd.yml")


def test_validate_with_vars(fixtures_dir):
    validate(_load(fixtures_dir / "with_vars.yml"), "with_vars.yml")


def test_validate_with_helpers(fixtures_dir):
    validate(_load(fixtures_dir / "with_helpers.yml"), "with_helpers.yml")


def test_compose_optional(fixtures_dir):
    """Groups without compose: should pass (config group in dev9.yml has none)."""
    data = _load(fixtures_dir / "full_cmd.yml")
    # config group has no compose
    assert "compose" not in data["groups"]["config"]
    validate(data, "full_cmd.yml")


def test_type_optional():
    """Action without type: should pass (defaults handled by parser, not schema)."""
    data = {
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
                "actions": {"a": {"cmd": "echo", "label": "A"}},
            }
        }
    }
    validate(data, "test")


def test_empty_containers_ok():
    data = {
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
                "actions": {"a": {"cmd": "echo", "label": "A"}},
            }
        }
    }
    validate(data, "test")


# --- Invalid configs ---

def test_reject_no_groups(fixtures_dir):
    with pytest.raises(SchemaError, match="'groups' is required"):
        validate(_load(fixtures_dir / "invalid_no_groups.yml"), "test")


def test_reject_both_cmd_and_script(fixtures_dir):
    with pytest.raises(SchemaError, match="exactly one of 'cmd' or 'script'"):
        validate(_load(fixtures_dir / "invalid_both_cmd_script.yml"), "test")


def test_reject_neither_cmd_nor_script(fixtures_dir):
    with pytest.raises(SchemaError, match="exactly one of 'cmd' or 'script'"):
        validate(_load(fixtures_dir / "invalid_neither_cmd_script.yml"), "test")


def test_reject_bad_type(fixtures_dir):
    with pytest.raises(SchemaError, match="'type' must be one of"):
        validate(_load(fixtures_dir / "invalid_bad_type.yml"), "test")


def test_reject_missing_action_label(fixtures_dir):
    with pytest.raises(SchemaError, match="'label' is required"):
        validate(_load(fixtures_dir / "invalid_missing_label.yml"), "test")


def test_reject_unknown_action_key(fixtures_dir):
    with pytest.raises(SchemaError, match="unknown key.*comand"):
        validate(_load(fixtures_dir / "invalid_unknown_key.yml"), "test")


def test_reject_empty_groups():
    with pytest.raises(SchemaError, match="non-empty mapping"):
        validate({"groups": {}}, "test")


def test_reject_groups_not_dict():
    with pytest.raises(SchemaError, match="non-empty mapping"):
        validate({"groups": "nope"}, "test")


def test_containers_optional():
    """containers is optional (defaults to []) — relaxed for nested groups."""
    data = {
        "groups": {
            "g": {
                "label": "G",
                "actions": {"a": {"cmd": "echo", "label": "A"}},
            }
        }
    }
    validate(data, "test")  # no raise


def test_reject_missing_actions_and_children():
    """A node must declare actions, children, or both — neither is invalid."""
    data = {
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
            }
        }
    }
    with pytest.raises(SchemaError, match="must have 'actions', 'children', or both"):
        validate(data, "test")


def test_allow_actions_and_children_both():
    """A branch can carry aggregate actions alongside its children — used
    for do.md-style composites (e.g. service:up which fans out to
    service.core:up → service.dev9:up)."""
    data = {
        "groups": {
            "g": {
                "label": "G",
                "actions": {"up": {"cmd": "echo aggregate", "label": "Up all"}},
                "children": {
                    "sub": {
                        "label": "Sub",
                        "actions": {"up": {"cmd": "echo sub", "label": "Up"}},
                    },
                },
            }
        }
    }
    validate(data, "test")  # no raise


def test_reject_unknown_top_key():
    data = {
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
                "actions": {"a": {"cmd": "echo", "label": "A"}},
            }
        },
        "bogus": True,
    }
    with pytest.raises(SchemaError, match="unknown key.*bogus"):
        validate(data, "test")


def test_reject_not_a_dict():
    with pytest.raises(SchemaError, match="must be a YAML mapping"):
        validate("not a dict", "test")


# --- Context in error messages ---

def test_error_includes_group_context():
    data = {
        "groups": {
            "mygrp": {
                "label": "L",
                # neither actions nor children — schema error names the group
            }
        }
    }
    with pytest.raises(SchemaError, match="group 'mygrp'"):
        validate(data, "test")


def test_error_includes_action_context():
    data = {
        "groups": {
            "g": {
                "label": "L",
                "containers": [],
                "actions": {
                    "myact": {"cmd": "echo"},  # missing label
                },
            }
        }
    }
    with pytest.raises(SchemaError, match="action 'myact'"):
        validate(data, "test")


# --- vars / helpers validation ---

def test_reject_vars_not_dict():
    data = {
        "vars": "nope",
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
                "actions": {"a": {"cmd": "echo", "label": "A"}},
            }
        },
    }
    with pytest.raises(SchemaError, match="'vars' must be a mapping"):
        validate(data, "test")


def test_reject_helpers_not_dict():
    data = {
        "helpers": ["bad"],
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
                "actions": {"a": {"cmd": "echo", "label": "A"}},
            }
        },
    }
    with pytest.raises(SchemaError, match="'helpers' must be a mapping"):
        validate(data, "test")


# --- args validation ---

def test_args_accepted():
    data = {
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
                "actions": {"a": {"cmd": "echo $1", "label": "A", "args": "name"}},
            }
        }
    }
    validate(data, "test")


def test_args_optional():
    data = {
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
                "actions": {"a": {"cmd": "echo", "label": "A"}},
            }
        }
    }
    validate(data, "test")


def test_reject_args_not_string():
    data = {
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
                "actions": {"a": {"cmd": "echo", "label": "A", "args": 123}},
            }
        }
    }
    with pytest.raises(SchemaError, match="'args' must be a string"):
        validate(data, "test")


# --- default_cmd validation ---

def test_default_cmd_accepted():
    data = {
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
                "actions": {"a": {
                    "cmd": "echo $1", "label": "A",
                    "args": "[host]", "default_cmd": "echo example.com",
                }},
            }
        }
    }
    validate(data, "test")


def test_reject_default_cmd_not_string():
    data = {
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
                "actions": {"a": {
                    "cmd": "echo", "label": "A",
                    "args": "[h]", "default_cmd": 42,
                }},
            }
        }
    }
    with pytest.raises(SchemaError, match="'default_cmd' must be a string"):
        validate(data, "test")


def test_reject_default_cmd_without_args():
    data = {
        "groups": {
            "g": {
                "label": "G",
                "containers": [],
                "actions": {"a": {
                    "cmd": "echo", "label": "A",
                    "default_cmd": "echo x",
                }},
            }
        }
    }
    with pytest.raises(SchemaError, match="'default_cmd' requires 'args'"):
        validate(data, "test")


def _minimal_with_files(entries):
    return {
        "groups": {"g": {"label": "G", "actions": {"a": {"cmd": "echo", "label": "A"}}}},
        "files": entries,
    }


def test_files_category_accepted():
    """category: is a valid optional field on `files:` entries."""
    data = _minimal_with_files([
        {"path": "client/", "category": "secret"},
        {"path": "data/dev9/bashrc", "category": "config"},
        {"path": "data/no-category"},  # category absent — fine
        "client/bare-string",          # bare-string entry — fine
    ])
    validate(data, "test")  # no raise


def test_reject_category_not_string():
    data = _minimal_with_files([
        {"path": "client/", "category": ["secret"]},
    ])
    with pytest.raises(SchemaError, match="'category' must be a string"):
        validate(data, "test")
