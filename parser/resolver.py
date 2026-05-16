"""Variable and helper resolution for script: actions."""
from __future__ import annotations

import re

from parser.errors import ResolutionError

# Match @use helper_name on its own line (leading whitespace allowed)
_USE_RE = re.compile(r"^(\s*)@use\s+(\w+)\s*$", re.MULTILINE)

# Match $VAR or ${VAR} — captures the variable name
_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)")


def passthrough_cmd(cmd: str) -> tuple[str, dict[str, str], list[str]]:
    """For cmd: actions — return cmd verbatim with no resolution."""
    return cmd, {}, []


def resolve_script(
    raw_script: str,
    vars_block: dict[str, str],
    helpers_block: dict[str, str],
    context: str,
) -> tuple[str, dict[str, str], list[str]]:
    """Resolve @use directives and $VAR references in a script.

    Returns (resolved_script, vars_used, helpers_used).
    Raises ResolutionError for undefined helpers.
    Unknown variables are left as-is (could be shell builtins).
    """
    script, helpers_used = _expand_helpers(raw_script, helpers_block, context)
    script, vars_used = _resolve_vars(script, vars_block)
    return script, vars_used, helpers_used


def _expand_helpers(
    script: str,
    helpers_block: dict[str, str],
    context: str,
) -> tuple[str, list[str]]:
    """Replace @use directives with helper content. Preserves indentation."""
    helpers_used = []

    def _replace(m: re.Match) -> str:
        indent = m.group(1)
        name = m.group(2)
        if name not in helpers_block:
            raise ResolutionError(
                f"undefined helper '{name}'",
                context=context,
            )
        helpers_used.append(name)
        body = helpers_block[name].rstrip("\n")
        # Indent each line of the helper body to match the @use line
        lines = body.split("\n")
        return "\n".join(indent + line if line.strip() else line for line in lines)

    result = _USE_RE.sub(_replace, script)
    return result, helpers_used


def _resolve_vars(
    script: str,
    vars_block: dict[str, str],
) -> tuple[str, dict[str, str]]:
    """Replace $VAR and ${VAR} with values from vars_block.

    Only substitutes variables defined in vars_block.
    Unknown variables are left untouched (shell builtins like $HOME, $1).
    """
    vars_used = {}

    def _replace(m: re.Match) -> str:
        name = m.group(1) or m.group(2)
        if name in vars_block:
            vars_used[name] = vars_block[name]
            return vars_block[name]
        return m.group(0)  # leave as-is

    result = _VAR_RE.sub(_replace, script)
    return result, vars_used
