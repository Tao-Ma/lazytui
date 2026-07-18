# Panes as tab-containers (unification arc)

> **Status:** planning. Not started. This captures the direction and a
> gate-green phasing; it is not a commitment to build now.

## One line

Make *every* pane a tab-container — a pane with no explicit tabs holds one
**implicit tab** — so per-tab state (cursor / scroll / filter / multi-select /
selection / search) is the **uniform** shape across all panes, dissolving the
viewer's tab speciality and letting the two text-selection backends collapse
into one.

## Why

This finishes a job the codebase has half-done and resolves a tension the
selection work hit head-on:

- **Finishes "panes-as-containers, tabs-as-content"** (v0.6.1). That arc split
  container from content *for the viewer*. Today the viewer is the only pane
  that is a tab-container; every other pane is flat content. Extending the split
  to all panes removes the last big pane speciality — the project's stated arch
  goal (correct / consistent / simple, minimal speciality).
- **Resolves the Stage 2 selection tension** ([pane-selection.md](pane-selection.md)).
  The per-pane selection shares a geometry core with the viewer but keeps a
  *different state shape*: the shared `model.selection` is single-owner, while
  the viewer's `slice.select` is **per-content-tab persisted** and keyboard-
  driven. Stage 2 settled for "one core, two state shapes." If **per-tab** is
  the universal shape, selection unifies *upward* onto it — the "per-tab doesn't
  fit a single-owner field" objection disappears because per-tab is what every
  pane now has.

Selection unification is the *payoff*. The *work* is a pane-model refactor.

## Current state (what's actually there)

**Viewer (detail) — a tab-container.** Content lives in
`slice.contentTabs[group][key]`; each tab carries `{ lines, scroll, search,
select, cursor }`. Non-content tab state is keyed in `slice.tabState` under
`<group>:<kind>:<key>` and persisted lazily (dropped on tab removal — pane-tabs
R5). The visible strip is `[Info] [Transcript] [action tabs…] [term tabs…]
[content tabs…]` (`panel/viewer/tab-strip.js`, `leaves/wm/pane-tabs.js#tabInfo`).
Mouse tab hit-testing rides `tabBoundsFor`.

**Every other pane — flat.** One nav state per instance:
`slice.nav = { cursor, scroll, multiSel, filter }` (single-panel) or
`slice.nav[panelType]` (multi-panel: docker, files) — `leaves/wm/nav.js`. No tab
concept, no strip.

So "tab" today means *viewer content tab*, and the per-tab state machinery
(`pane-tabs.js`, `tab-strip.js`, `tabState`) is viewer-only.

## Target model

- A pane is a **tab-container**. Its content is always *in a tab*.
- A pane with a single tab has an **implicit tab** — created lazily, **no strip
  shown** (chrome only appears at ≥2 tabs), so nothing changes visually or
  behaviourally for today's flat panes until they gain a second tab.
- **Per-tab state** is the uniform home for `cursor / scroll / filter /
  multiSel / selection / search`. The flat `slice.nav` becomes the *active
  tab's* state; the general `tabState` keyed store generalizes beyond the viewer.
- Selection unifies onto the per-tab model: retire the split between
  `model.selection` (single-owner) and the viewer's `slice.select`. There is one
  selection notion — "the active tab's selection" — for every pane.

## Design decisions (to pin before building)

**D1 — Implicit tab is invisible until ≥2.** A single-tab pane shows no strip
and behaves exactly as today. *Rationale:* zero UX regression; the strip is
opt-in by having real tabs. Non-negotiable — a strip on every pane is chrome
noise.

**D2 — Scope: unify ALL per-tab state, not just selection.** Move
`cursor/scroll/filter/multiSel/selection/search` into per-tab state uniformly.
*Rationale:* selection-only would leave two half-migrated state homes (nav flat,
selection per-tab) — worse than either endpoint. The win is one state shape.
*Cost:* this is the bulk of the arc — the `nav.js` → per-tab migration, not the
selection change.

**D3 — Generalize `pane-tabs`/`tabState`, don't fork it.** Lift the viewer's
tab store into a pane-agnostic home (a `leaves/wm/` tab model) that the viewer
and every other pane share, rather than copying it. The viewer's Info/Transcript
/action/term tab *kinds* stay viewer-specific; the *container + per-tab-state*
mechanism generalizes.

**D4 — Multi-panel Components keep their per-panelType split.** docker/files
address state by `slice.nav[panelType]`; implicit tabs compose *under* each
panelType (each logical panel is a tab-container). *Open:* confirm this composes
cleanly or whether multi-panel Components fold into multi-tab instead (see Q1).

**D5 — Selection retires onto per-tab; `model.selection` is removed.** The
shared `model.selection` + `sel_*` arms fold into "active tab's selection." The
per-pane mouse pipeline and the viewer's keyboard visual-mode both write the
active tab's selection. `select-core` (the geometry) is unchanged — it already
takes an explicit selection object. *Rationale:* one selection notion; the
group-switch/tab-switch clear becomes automatic (a different tab = a different
selection).

**D6 — Replay/purity preserved.** Per-tab state stays pure model state written
only by the reducer (as `slice.nav`/`slice.select`/`model.selection` are today),
so WAL + checkpoint replay reconstruct it. No new off-model stores.

## Phasing (each phase ships behind the gate: suite · smoke · acyclic · DEAD 0)

- **P0 — Design doc + decisions.** This file; pin D1–D6 and Q1–Q3 with the user.
- **P1 — Generalize the tab store (no behaviour change).** Lift `contentTabs`/
  `tabState` into a pane-agnostic tab model (D3). Viewer keeps working through
  it. Pure refactor; no pane gains tabs yet.
- **P2 — Implicit single tab for flat panes.** Every pane gets one implicit tab;
  `slice.nav` reads/writes route through "active tab's state." Strip stays hidden
  at 1 tab (D1). Behaviour identical; this is the state-home migration (D2), the
  riskiest phase — do it pane-family by pane-family (navigators, then fabric,
  then monitor) with the gate green each step.
- **P3 — Unify selection onto per-tab (D5).** Retire `model.selection` +
  `viewer/select.js`'s `slice.select` split into "active tab's selection." The
  mouse pipeline + viewer visual-mode both target it. Retire the two-state-shape
  note in pane-selection.md.
- **P4 — (Optional) real multi-tab for non-viewer panes.** Now that any pane can
  hold >1 tab, expose it where useful (e.g. a navigator pinning two filtered
  views as tabs). Pure additive; not required by the unification.

Selection unification (the original motivation) lands in **P3** and is only safe
*after* P1–P2 make per-tab the universal shape.

## Non-goals

- No visual tab strip on single-tab panes (D1).
- Not changing the viewer's tab *kinds* (Info/Transcript/action/term) — only
  generalizing the container mechanism (D3).
- Not a new persistence/serialization surface — per-tab state stays in-model,
  session-transient like today (D6).

## Open questions

- **Q1:** Do multi-panel Components (docker/files) stay `nav[panelType]` with
  implicit tabs *under* each (D4), or is a multi-panel Component just a
  multi-tab pane? The latter is cleaner but a bigger blast radius.
- **Q2:** Does group-switch still *clear* transient state (selection/filter), or
  does per-tab state mean each group keeps its own tab set (so switching back
  restores it)? Today the viewer persists per (group, tab); flat panes reset per
  group. Uniform per-tab could make list-pane filters/selection survive a group
  round-trip — decide if that's desired or a surprise.
- **Q3:** What action creates a *second* tab on a today-flat pane (P4)? Until
  there's a real one, P2's implicit tab is invisible plumbing — fine, but the
  arc's user-visible payoff (beyond the internal unification) waits on P4.

## Relationship to shipped work

Builds on [pane-selection.md](pane-selection.md) (the per-pane selection +
`select-core`) and the v0.6.1 panes-as-containers split. P3 supersedes the
"one core, two state shapes" compromise recorded there.
