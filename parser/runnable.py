from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class DebugInfo:
    source_file: str
    action_line: int  # -1 when line number unavailable
    vars_used: dict[str, str] = field(default_factory=dict)
    helpers_used: list[str] = field(default_factory=list)
    resolved_script: str = ""


@dataclass
class RunnableAction:
    group: str
    key: str
    label: str
    type: str  # "run" | "spawn" | "background"
    confirm: str | None
    args: str | None  # arg hint for CLI/TUI, e.g. "client-name", "[name]"
    default_cmd: str | None  # shell snippet computing the prompt's default value
    desc: str | None  # description shown in output panel on browse
    tab: bool  # show as output panel tab
    script: str  # fully resolved shell script
    containers: list[str]
    debug: DebugInfo

    def info(self) -> list[str]:
        """Detail lines for output panel."""
        lines = [self.label]
        if self.desc:
            lines.extend(["", self.desc, ""])
        else:
            lines.append("")
        lines.append(f"type: {self.type}")
        if self.args:
            lines.append(f"args: <{self.args}>")
        if self.confirm:
            lines.append(f"confirm: {self.confirm}")
        # Script preview
        script_lines = self.script.strip().splitlines()
        preview = script_lines[:8]
        lines.append("")
        for sl in preview:
            lines.append(f"  {sl}")
        if len(script_lines) > 8:
            lines.append(f"  ... ({len(script_lines)} lines total)")
        return lines


@dataclass
class ConfigFile:
    path: str
    var: str | None = None
    desc: str | None = None
    exclude: list[str] = field(default_factory=list)
    # Free-form string used by the config-status plugin to bucket entries
    # (e.g. "secret" / "config"). The schema doesn't enforce a vocabulary —
    # any value is accepted. None = uncategorized.
    category: str | None = None

    def info(self) -> list[str]:
        """Detail lines for output panel."""
        lines = [self.path]
        if self.desc:
            lines.extend(["", self.desc, ""])
        else:
            lines.append("")
        if self.category:
            lines.append(f"category: {self.category}")
        if self.var:
            lines.append(f"var: ${self.var}")
        if self.exclude:
            lines.append(f"exclude: {', '.join(self.exclude)}")
        return lines


@dataclass
class TerminalConfig:
    cmd: str
    label: str


@dataclass
class GroupConfig:
    """One node in the group tree.

    `name` is the dotted path from root (e.g. 'base.network.ssh'); `parent`
    is the parent's path or None for top-level groups; `depth` is 0-indexed
    so the renderer can indent without walking the chain.

    A node must declare actions, children, or both — schema requires at
    least one. Branches with actions are aggregate nodes whose actions
    typically compose their descendants (e.g. a `service:up` aggregate
    that fans out to `service.core:up` → `service.dev9:up`). Pure leaves
    (actions, no children) and pure branches (children, no actions) are
    both still valid; "both" is the third shape.
    """
    name: str
    label: str
    compose: str | None
    containers: list[str]
    actions: dict[str, RunnableAction]
    terminals: dict[str, TerminalConfig] = field(default_factory=dict)
    children: list[str] = field(default_factory=list)  # dotted-path keys into ParsedConfig.groups
    parent: str | None = None
    depth: int = 0
    quick: bool = False  # surface in the groups panel's Quick tab (flat list)
    archive: dict | None = None  # plugin payload — see archive.js groupActions
    config_branch: dict | None = None  # plugin payload — see config-branch.js groupActions
    images: dict | None = None  # plugin payload — see image-backup.js groupActions

    def info(self) -> list[str]:
        """Detail lines for output panel."""
        lines = [self.label, ""]
        if self.compose:
            lines.append(f"compose: {self.compose}")
        if self.containers:
            lines.append(f"containers: {len(self.containers)}")
            for c in self.containers:
                lines.append(f"  {c}")
        if self.children:
            lines.extend(["", f"children: {len(self.children)}"])
            for c in self.children:
                # Strip the parent prefix so the detail panel shows just the
                # child's local key, not the redundant full path.
                local = c.split(".")[-1]
                lines.append(f"  {local}")
        if self.actions:
            lines.extend(["", f"actions: {len(self.actions)}"])
            for key, action in self.actions.items():
                tag = {"spawn": " ⧉", "background": " ⇱"}.get(action.type, "")
                lines.append(f"  {action.label}{tag}")
        return lines


@dataclass
class PanelConfig:
    type: str       # "containers", "groups", "file-manager", "actions", "detail"
    title: str
    hotkey: str     # auto-assigned: left "1"-"6", actions "0", detail "o"
    column: str     # "left" or "right"
    # Plugin-specific panel options (e.g. `topic`, `select_from`, `metrics`,
    # `window` for the stats panel). Schema-agnostic on the parser side —
    # the consuming plugin validates whatever it cares about.
    config: dict = field(default_factory=dict)


@dataclass
class LayoutConfig:
    left_width: int
    left_panels: list[PanelConfig]
    right_panels: list[PanelConfig]
    detail_height_pct: int  # percent of right column for detail panel

    @property
    def all_panels(self) -> list[PanelConfig]:
        return self.left_panels + self.right_panels

    @property
    def panel_order(self) -> list[str]:
        """Focusable panels in ←→ traversal order (excludes detail)."""
        return [p.type for p in self.all_panels if p.type != "detail"]


@dataclass
class ParsedConfig:
    project_dir: str
    groups: dict[str, GroupConfig]
    source_file: str
    files: list[ConfigFile] = field(default_factory=list)
    layout: LayoutConfig | None = None
    theme: str = "monokai"
