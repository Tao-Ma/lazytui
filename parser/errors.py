from __future__ import annotations


class ParseError(Exception):
    """Base error for all parser failures."""

    def __init__(
        self,
        message: str,
        context: str | None = None,
        line: int | None = None,
    ):
        self.context = context
        self.line = line
        full = message
        if context:
            full = f"{context}: {message}"
        if line is not None:
            full = f"line {line}: {full}"
        super().__init__(full)


class SchemaError(ParseError):
    """Structure or type validation failure."""


class ResolutionError(ParseError):
    """Variable or helper resolution failure."""
