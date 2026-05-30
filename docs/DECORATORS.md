# Decorators — retired (v0.5 Phase 5)

The slot-keyed decorator framework that used to live in `js/decorators.js`
was retired on the `v0.5-tea` branch (Phase 5 of the layout-Component
arc, spec: `docs/v0.5-layout-component.md`). Nothing in tree subscribed
to it cross-Component; every "decoration" was a Component contributing
to its own panel.

The replacement is **`viewContributions`** — a Component-only surface
exposed by `components/api.js`:

```js
module.exports = {
  name: 'my-component',
  init: () => ({ ... }),
  update: (msg, slice) => ...,
  viewContributions: {
    footerLeft:  (slice, ctx) => 'segment text',
    footerRight: (slice, ctx) => ({ text: '...', weight: 100 }),
  },
};
```

The layout renderer calls `api.collectViewContributions('footerLeft', ctx)`
each frame; contributors are composed in registration order (stable sort
by weight; `footerRight` reversed so highest weight sits rightmost on
screen), joined with the heavy pipe ` │ `, and truncated to `ctx.width`.

Row / title / tab decorations are now inlined directly in each
Component's `render(panel, w, h, slice)`. The Plugin-side
`decorators: { ... }` map is no longer supported (logged + ignored on
register).

Use this file to discover the migration; the live API doc is the
`viewContributions` block in `components/api.js`.
