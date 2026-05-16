from __future__ import annotations

from pathlib import Path

import pytest

from parser import parse


FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def fixtures_dir():
    return FIXTURES_DIR


@pytest.fixture
def tmp_yaml(tmp_path):
    """Factory fixture: write YAML string to a temp file, return its path."""

    def _write(content: str, name: str = "test.yml") -> Path:
        p = tmp_path / name
        p.write_text(content)
        return p

    return _write


def parse_fixture(name: str):
    """Parse a fixture YAML file by name and return ParsedConfig."""
    return parse(str(FIXTURES_DIR / name))
