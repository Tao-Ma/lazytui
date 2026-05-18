# Decorators

Generic plugin extension framework for adding text to any UI surface in
the TUI — list rows, panel titles, detail tabs, and the footer (left
and right segments). One contract for what was historically a scatter
of one-off render hooks.

## Why

Three features in the codebase already do this informally:

- **Group status dot** (`●` in groups panel rows) — core asks docker via
  `statusFor`, paints the dot inline.
- **Container CPU%** (`12%` next to container name) — docker renders
  inline from its own stats cache.
- (Reverted) **CPU sparkline** — docker plugin proposed a one-off
  `decorateRow` hook; HUB.md §0 retrospective explains why that bundling
  was wrong.

All three are the same shape: data about a row's entity, rendered
alongside the entity's primary identity. Once you accept that, the
right move is one decorator framework that subsumes the pattern, not
N one-off hooks. Bonus: the same framework cleanly handles non-row
surfaces — titles, tabs, footers — that today are renderer-hardcoded.

## Slots

A **slot** is a named UI surface position. Renderers `decorate(slot,
ctx) → string` and append the result to whatever they're already
rendering. Plugins register handlers per slot.

| Slot                       | Where it appears                            | Per-render frequency |
|----------------------------|---------------------------------------------|----------------------|
| `row:left:<panelType>`     | Prepended after the gutter, before base row | once per visible row |
| `row:right:<panelType>`    | Appended after base row content             | once per visible row |
| `title:<panelType>`        | Panel title bar, after the title text       | once per panel render |
| `tab:<tabId>`              | Detail panel tab label                      | once per tab in tab bar |
| `footer:left`              | Leading segments of the footer              | once per render |
| `footer:right`             | Trailing segments of the footer             | once per render |

`row:left:*` and `row:right:*` are symmetric — same composition rule
(single space separator), same ctx shape. They differ only in **where
the renderer splices the result** into the row template:

```
[gutter] [row:left] [base content] [row:right]
```

This split lets the existing inline left-side glyphs (status dot in
`row:left:containers`, running-count+dot in `row:right:groups`) become
plugin-supplied decorators rather than renderer-hardcoded artifacts.
Without registered handlers both sides stay empty — same zero-overhead
contract as everywhere else.

Slot names are strings. New slots can be added by any future renderer
without changes to the framework — pick a name, add one `decorate(...)`
call site, document the ctx shape.

### `<panelType>` placeholders

`row:containers`, `row:groups`, `row:actions`, `row:file-manager`,
`row:history`, plus any plugin-defined panel types. Same for `title:*`.

`tab:*` uses tab IDs that come from the detail panel's tab system
(`tab:info`, `tab:logs`, etc. — exact list TBD; renderer call site is
`decorate('tab:' + tabId, ctx)`).

## Plugin registration

Plugins export a `decorators` object keyed by slot name, value is the
handler:

```javascript
module.exports = {
  name: 'docker',
  decorators: {
    'row:containers': (ctx) => `${ctx.cpuPct.toFixed(0)}%`,
    'footer:right':   (ctx) => `${ctx.runningCount}/${ctx.totalCount}`,
  },
};
```

`registerPlugin` walks the map at load time and pushes each handler
into the registry under its slot. Static registration only — no runtime
add/remove (a handler that wants to disable itself returns `''`,
costing a function call but matching the "zero overhead" goal as long
as it's truly idle).

## Handler signature

```
handler(ctx) → string | { text, weight } | null | undefined | ''
```

- Plain string → joined with the slot's separator (see Composition).
- `{ text, weight }` → ordering hint. Default weight is 0.
- `null` / `undefined` / `''` → handler abstains; framework drops it.

Handlers are sync. No I/O, no expensive computation — same rule as
plugin `getItems`/`render`/etc. (PLUGINS.md async contract). Handlers
that need data should pull from already-cached state (plugin local,
hub history, statusFor) — never compute on-the-fly inside a handler.

## Context shapes per slot

| Slot              | ctx fields                                            |
|-------------------|-------------------------------------------------------|
| `row:left:*`      | `{ panelType, item, selected, width, S }`             |
| `row:right:*`     | `{ panelType, item, selected, width, S }`             |
| `title:*`         | `{ panelType, S, width }`                             |
| `tab:*`           | `{ tabId, item, active, S }`                          |
| `footer:left`     | `{ S, focus, view, width }`                           |
| `footer:right`    | `{ S, focus, view, width }`                           |

Every ctx carries `S` — even title decorators, which earlier drafts
omitted it from. The decorator framework's contract is uniform: any
handler can read the global state if it needs to.

`width` is the remaining horizontal budget for the slot (accounting for
content already rendered). Decorators must self-clip; the framework
also enforces an outer truncate at the slot boundary as a safety net.

## Composition

When multiple handlers register for the same slot, results combine per
slot-specific rules:

| Slot          | Separator | Default position  |
|---------------|-----------|-------------------|
| `row:left:*`  | ` ` (space) | between gutter and base |
| `row:right:*` | ` ` (space) | append after base content |
| `title:*`     | `, `        | after title text |
| `tab:*`       | ` ` (space) | after tab label  |
| `footer:left` | ` │ `       | left-to-right    |
| `footer:right`| ` │ `       | right-to-left (renderer reverses) |

Within a slot, ordering follows:
1. Sort by `weight` (ascending — lower weights first; default 0).
2. Stable sort, so handlers with the same weight keep registration order.
3. Empty / nullish results are dropped before separator insertion.

A handler that wants to be the rightmost segment of `footer:right` can
return `{ text: '12:34', weight: 999 }`; one that wants to be near the
left of `footer:left` can return `{ text: 'edit', weight: -10 }`.

## Markup safety

`row:*` slots are embedded inside a `[reverse]` block when the row is
selected. A handler that emits Rich markup with `[/]` would close the
reverse mid-line and break the highlight (PRINCIPLES §8).

**Rule for `row:*` handlers:**
- If `ctx.selected === true`, return plain text (no `[`/`]` markup).
- Otherwise, Rich markup is allowed.

Other slots aren't inside reverse blocks; markup is always allowed.

The framework does **not** strip markup — the rule is the handler's
responsibility, just like every other place that emits into a
selectable row in this codebase.

## Width safety

A decorator that overflows the panel/footer width causes layout
breakage — selected-row truncation drops markup, footer wraps, etc.
Two layers of defense:

- **Cooperative**: `ctx.width` carries remaining budget. Handlers
  should self-clip.
- **Backstop**: framework truncates the combined slot output at the
  slot's natural width boundary before returning.

## Performance contract — zero overhead when idle

This is a hard requirement. The framework must be free for users who
don't have any decorators registered for a given slot.

Implementation:

```javascript
const registry = new Map();        // slot → handler[]

function decorate(slot, ctx) {
  const handlers = registry.get(slot);
  if (!handlers) return '';        // ← hot path: 1 map lookup, drop
  // ...iterate, sort, compose, return
}
```

Cost when no handlers registered for a slot:
- One `Map.get` lookup (returns `undefined`).
- One falsiness check.
- Return empty string.

That's all. A list panel with 50 rows calling `decorate('row:foo', ctx)`
for each row costs ~50 map lookups per render. At 10Hz refresh that's
500/s — well below noise.

`Map.get` for an unregistered slot doesn't allocate; the registry stays
empty until something subscribes. **No allocation ever happens for slots
nobody listens to.**

## Renderer call sites

Each renderer adds two `decorate()` calls per row (left + right) and
splices results into the row template. Examples:

```javascript
// containers panel — left of name (status dot etc.) + right of name
const ctx = { panelType: 'containers', item: name, selected: isSel, S };
const left  = decorate('row:left:containers',  { ...ctx, width: leftBudget });
const right = decorate('row:right:containers', { ...ctx, width: rightBudget });

const lhead = left  ? `${left} `  : '';   // dot+space, or empty
const rtail = right ? ` ${right}` : '';
return `${gutter}${lhead}${esc(name)}${rtail}`;
```

```javascript
// panel.js renderPanel — append to title bar
const titleExtra = decorate('title:' + panelType,
                            { panelType, panel, S, width: titleBudget });
const fullTitle = titleExtra ? `${title}, ${titleExtra}` : title;
```

```javascript
// layout.js renderFooter — left and right segments
const leftExtra  = decorate('footer:left',  { S, focus, view, width: leftBudget });
const rightExtra = decorate('footer:right', { S, focus, view, width: rightBudget });
```

Renderers always handle the empty-string case — empty extras don't
render the separator.

## Status quo decorators (shipped)

- **`row:left:containers`** — docker plugin, container status dot
  (data source: `cachedStatus`).
- **`row:right:groups`** — core plugin, running-count + group dot
  (data source: `statusFor` over the group's containers).

`statusFor` stays as the *data contract* (name → status); the decorator
framework is the *display contract* (slot → text). Decorators that need
status pull from `statusFor` or any plugin-internal cache.

## Open questions (deferred)

- **Dynamic registration** (plugin adds/removes a handler at runtime,
  e.g. when a panel becomes visible). v1 is static-only at load.
  Workaround: handler returns `''` when inactive.
- **Slot introspection** (`:decorators list`). Useful for debugging
  which plugins decorate where. ~20 LOC if wanted.
- **Conditional handlers** (declare which slots based on config).
  Today: single object literal at module load. Could become a function
  that returns the map. Not needed yet.
- **Migration of `statusFor` to a decorator**. Mostly cosmetic — the
  dot itself is one character and re-implementation as a decorator is
  trivial; doing it without a forcing function would be churn. Wait
  for a second, third use case to clarify whether the migration earns
  its keep.
