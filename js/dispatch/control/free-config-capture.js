/**
 * Free-config mouse — the layout drags on pointer capture (docs/mouse-hit-map.md
 * Release 3, step 4). Replaces input.js's `_mouseHandleFreeConfigMode`.
 *
 *   act `free-config-press`  the panel-list descriptor's below-chrome backdrop
 *                            press (free-config owns the mouse outside the
 *                            list): close the list if it is open, then start the
 *                            `free-config` capture.
 *   capture `free-config`    press → free_config_mouse_press (the reducer picks
 *                            resize vs move from the point); motion →
 *                            free_config_mouse_motion while a drag is in flight;
 *                            release → free_config_mouse_release.
 *   capture `pool-drag`      a panel-list item row's press: move the list cursor
 *                            to it, pool_drag_start; motion → pool_drag_motion;
 *                            release → pool_drag_release (drop).
 *
 * The drag state itself lives in the layout slice (freeConfig.drag) — the
 * capture only routes motion / release to the right Msgs; each step re-checks
 * the slice so a drag the keyboard ended makes the remaining motion a no-op.
 */
'use strict';

const api = require('../../panel/api');
const loop = require('../runtime/loop');
const mpool = require('../../leaves/wm/pool');
const { cols } = require('../../io/term');
const acts = require('./mouse-acts');
const capture = require('./pointer-capture');

const toLayout = (msg) => loop.dispatchMsg(api.wrap('layout', msg));
const layout = () => api.getInstanceSlice('layout');
const dragOf = (s) => (s && s.freeConfig && s.freeConfig.drag) || null;
const isPoolDrag = (d) => !!d && (d.kind === 'pool-armed' || d.kind === 'pool-dragging');

acts.register('free-config-press', () => {
  const s = layout();
  if (s && s.panelList && s.panelList.open) toLayout({ type: 'panel_list_close' });
  return { capture: 'free-config' };
});

capture.register('free-config', {
  start(args, ev) {
    toLayout({ type: 'free_config_mouse_press', mx: ev.mx, my: ev.my, cols: cols() });
    return {};
  },
  // Motion without an in-flight drag is a no-op in the leaf — skip the
  // dispatch AND the paint (P5.10).
  motion(st, ev) {
    const d = dragOf(layout());
    if (!d || isPoolDrag(d)) return false;
    toLayout({ type: 'free_config_mouse_motion', mx: ev.mx, my: ev.my, cols: cols() });
    return true;
  },
  release() {
    if (isPoolDrag(dragOf(layout()))) return false;
    toLayout({ type: 'free_config_mouse_release' });
    return true;
  },
  pressWhileHeld: 'drop',   // a lost release: the capture ends (cancel 'lost'), the press routes
  // Never leave a layout drag stuck in the slice. A lost release ('lost') —
  // a press arrived, in ANY scope, or replay is starting — DISCARDS the
  // unreleased drag (releasing it would commit a move the user never
  // released). The discard is explicit: it must not depend on where the next
  // press lands (today the backdrop's own reducer press would replace the
  // drag), and replay enter's abandon has no press at all. Abandoned by a mode
  // change while the button is still held ('scope' — motion / release under
  // title-edit): end it as its release would.
  cancel(st, ev, reason) {
    const d = dragOf(layout());
    if (!d || isPoolDrag(d)) return false;
    toLayout({ type: reason === 'scope' ? 'free_config_mouse_release' : 'free_config_drag_discard' });
    return true;
  },
});

capture.register('pool-drag', {
  // args: { idx, id } — the row's item at paint. Re-resolved against the live
  // list: the item must still be at idx and still draggable (not essential).
  start(args, ev) {
    const s = layout();
    if (!s || !s.panelList || !s.panelList.open) return null;
    const items = mpool.panelListItems(s.arrange);
    const item = items[args.idx];
    if (!item || item.id !== args.id || item.status === 'essential') return null;
    if (args.idx !== s.panelList.cursor) toLayout({ type: 'panel_list_open', cursor: args.idx });
    toLayout({ type: 'pool_drag_start', id: item.id, mx: ev.mx, my: ev.my });
    return { id: item.id };
  },
  motion(st, ev) {
    if (!isPoolDrag(dragOf(layout()))) return false;
    toLayout({ type: 'pool_drag_motion', mx: ev.mx, my: ev.my, cols: cols() });
    return true;
  },
  release() {
    if (!isPoolDrag(dragOf(layout()))) return false;
    toLayout({ type: 'pool_drag_release' });
    return true;
  },
  // While the pool drag is live a press is swallowed (as before Release 3);
  // once the slice no longer holds it, the capture lets the press through.
  pressWhileHeld: () => (isPoolDrag(dragOf(layout())) ? 'swallow' : 'drop'),
  // Abandoned by a mode change while the button is still held ('scope'): end
  // the pool drag the slice still holds, as its release would. A lost release
  // ('lost' — a press in a changed scope, or replay starting; in the same scope
  // a press is swallowed while the drag is live) discards it, dropping nothing.
  cancel(st, ev, reason) {
    if (!isPoolDrag(dragOf(layout()))) return false;
    toLayout({ type: reason === 'scope' ? 'pool_drag_release' : 'free_config_drag_discard' });
    return true;
  },
});

module.exports = {};
