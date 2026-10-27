/**
 * Fuzzy action palette sub-reducer (v0.6.44 Brief 2).
 *
 * A type-to-jump list of every `group:action` discoverable through the
 * SAME walker the CLI uses — `iterActions` from `js/app/cli.js` — so the
 * palette and `--list`/`--complete` can't drift (parity asserted by
 * `test-action-palette.js`). Pure reducer: items are NOT stored on
 * `model.modal.palette`; the dispatch handler walks `model.config` at
 * render / pick time and threads the needed slice into each Msg
 * (`total` on nav, `{groupPath, actionKey}` on pick). This keeps the
 * modal state tiny (`{filter, idx}`) and config-change safe — the
 * walker always sees the live `model.config`.
 *
 * Esc two-step mirrors the v0.6.43 choices-filter popover: first Esc
 * clears a non-empty filter, second Esc closes.
 *
 * Pick path: `palette_pick` closes the modal and emits a Cmd
 * descriptor the effects layer interprets to switch `currentGroup`
 * (mirroring "the user selected the action in the actions pane") and
 * call `runAction` through the standard invoke path (confirm gate,
 * missing-required prompting, ports form — identical to selecting it
 * in the actions pane).
 */
'use strict';

const { withModalMode, withModal } = require('../model-ops');

const TYPES = [
  'palette_open',
  'palette_close',
  'palette_filter',
  'palette_filter_clear',
  'palette_nav',
  'palette_pick',
];

const CLOSED = { filter: '', idx: 0 };

// Paste-cap on the filter buffer. Same shape + rationale as the v0.6.43
// choices-filter popover (Brief 2 pre-release round-1 fix): a long paste
// lands as one Msg, so the clamp has to run POST-concat, not against the
// pre-concat length. 128 code units is far longer than any sane action-
// path filter needle.
const MAX_FILTER_LEN = 128;

function _appendClamp(cur, add) {
  if (!add) return cur;
  let next = cur + add;
  if (next.length <= MAX_FILTER_LEN) return next;
  next = next.slice(0, MAX_FILTER_LEN);
  // Surrogate guard: if the cut lands between a high + low surrogate,
  // drop the lone high so the string stays well-formed UTF-16.
  if (next.length && /[\uD800-\uDBFF]$/.test(next)) next = next.slice(0, -1);
  return next;
}

function update(model, msg) {
  switch (msg.type) {
    case 'palette_open': {
      return [withModalMode(model, { paletteMode: true },
        { palette: { ...CLOSED } }), []];
    }
    case 'palette_close': {
      if (!model.modes.paletteMode) return [model, []];
      return [withModalMode(model, { paletteMode: false },
        { palette: { ...CLOSED } }), []];
    }
    case 'palette_filter': {
      if (!model.modes.paletteMode) return [model, []];
      const cur = model.modal.palette.filter;
      let next;
      if (msg.seq === '\x7f') {
        // Backspace — pop one code unit. Surrogate-safe is overkill for
        // a user-typed filter; the paste path (append) is where the
        // guard matters.
        next = cur.slice(0, -1);
      } else {
        next = _appendClamp(cur, typeof msg.seq === 'string' ? msg.seq : '');
      }
      if (next === cur) return [model, []];
      // Reset idx to 0 on every filter change — the narrowed view can
      // be shorter than the previous one, and 0 is the user's "best
      // match" expectation anyway.
      return [withModal(model, { palette: { filter: next, idx: 0 } }), []];
    }
    case 'palette_filter_clear': {
      if (!model.modes.paletteMode) return [model, []];
      if (!model.modal.palette.filter) return [model, []];
      return [withModal(model, { palette: { filter: '', idx: 0 } }), []];
    }
    case 'palette_nav': {
      if (!model.modes.paletteMode) return [model, []];
      // `total` is threaded by the dispatch handler (which walks
      // iterActions through the filter leaf). The reducer stays pure of
      // config walking; it just clamps the cursor against the view size.
      const total = Math.max(0, (msg.total | 0));
      if (total === 0) return [model, []];
      const cur = model.modal.palette.idx | 0;
      const step = (msg.dir | 0) >= 0 ? 1 : -1;
      let next = cur + step;
      if (next < 0) next = 0;
      if (next >= total) next = total - 1;
      if (next === cur) return [model, []];
      return [withModal(model, { palette: { ...model.modal.palette, idx: next } }), []];
    }
    case 'palette_pick': {
      if (!model.modes.paletteMode) return [model, []];
      // `{groupPath, actionKey}` are threaded by the dispatch handler
      // (which has already resolved the row at idx against the filtered
      // view). Defensive close-only when the pair is absent — e.g. a
      // keyboard Enter on a `(no match)` row that the handler should
      // have swallowed, but let's not crash if it slips through.
      const nextModel = withModalMode(model, { paletteMode: false },
        { palette: { ...CLOSED } });
      if (!msg.groupPath || !msg.actionKey) return [nextModel, []];
      return [nextModel, [{
        type: 'palette_run_action',
        groupPath: String(msg.groupPath),
        actionKey: String(msg.actionKey),
      }]];
    }
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update, CLOSED, MAX_FILTER_LEN };
