/**
 * `/`-filter mode sub-reducer (#D12). The caller (dispatch) resolves the panel
 * + filterable gate + committed seed text, since the filterable check is
 * plugin-API (can't live in the reducer). The transforms are pure model writes.
 * The handler stamps `msg.route = route.bundle(msg.panel)` at filter_enter; it's
 * stored on the modal so filter_key / filter_exit reuse it without re-resolving
 * (the filtered pane is fixed for the whole session). `update(model, msg) →
 * [model, cmds]`.
 */
'use strict';

const { withModes: _withModes, withModal: _withModal } = require('../model-ops');
const route = require('../../../panel/route');

const TYPES = ['filter_enter', 'filter_key', 'filter_exit'];

function update(model, msg) {
  switch (msg.type) {
    case 'filter_enter': {
      // v0.6.5 blessed-A — store the route bundle so filter_key/exit reuse it.
      const r = msg.route || null;
      const next = {
        ..._withModes(model, { filterMode: true }),
        modal: { ...model.modal, filter: { text: msg.text || '', panel: msg.panel, route: r } },
      };
      // v0.6.3 Round-2 — clear multiSel on filter-session entry. Selections
      // made before entering filter mode reference items the filter may hide;
      // carrying them across the commit surfaces as ghost selections when the
      // filter is later cleared. multisel_clear is a no-op when the panel had
      // no selection, so the Cmd is free in the common case.
      if (!r) return [next, []];
      return [next, [{
        type: 'msg',
        msg: route.wrap(r.target, { type: 'multisel_clear', panel: r.panelType }),
      }]];
    }
    case 'filter_key': {
      const f = model.modal.filter;
      let text = f.text;
      if (msg.seq === '\x7f') {
        if (!text) return [model, []];
        text = text.slice(0, -1);
      } else if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32) {
        text = text + msg.seq;
      // T26 — paste support: bracketed-paste content arrives as
      // key='paste', seq=<full content>. Single-line modal — collapse
      // line breaks to single spaces.
      } else if (msg.key === 'paste' && typeof msg.seq === 'string') {
        text = text + msg.seq.replace(/[\r\n]+/g, ' ');
      } else {
        return [model, []];
      }
      const next = _withModal(model, { filter: { ...f, text } });
      // Re-home the cursor as the filter narrows; the panel's nav slice
      // is the writer. v0.6.5 blessed-A — reuse the session route bundle
      // stored at filter_enter (f.route) rather than re-resolving here.
      const r = f.route;
      if (!r) return [next, []];
      return [next, [{ type: 'msg', msg: route.wrap(r.target, { type: 'set_cursor', panel: r.panelType, index: 0 }) }]];
    }
    case 'filter_exit': {
      const f = model.modal.filter;
      const text = f.text;
      const keep = !!msg.keep;
      const next = {
        ..._withModes(model, { filterMode: false }),
        modal: { ...model.modal, filter: { text: '', panel: '', route: null } },
      };
      // v0.6.5 blessed-A — reuse the session route bundle stored at
      // filter_enter (f.route); commit/clear the filter + re-home
      // cursor/scroll on THAT instance's nav slice (keyed by its panel-type).
      const r = f.route;
      // #D11 — the body-refresh that exiting filter triggers is the reducer's
      // decision (emit the show_selected_info Cmd), not a second imperative
      // dispatch in handleFilterKey. One gesture (Esc/Enter in filter) → one
      // Msg → reducer-decided cascade.
      if (!r) return [next, [{ type: 'show_selected_info' }]];
      const { target, panelType } = r;
      // Commit/clear the filter on the panel's nav slice; the owning
      // Component is the single writer.
      const filterMsg = (keep && text)
        ? { type: 'set_filter',   panel: panelType, text }
        : { type: 'clear_filter', panel: panelType };
      return [next, [
        { type: 'msg', msg: route.wrap(target, filterMsg) },
        { type: 'msg', msg: route.wrap(target, { type: 'set_cursor', panel: panelType, index: 0 }) },
        { type: 'msg', msg: route.wrap(target, { type: 'set_scroll', panel: panelType, offset: 0 }) },
        { type: 'show_selected_info' },
      ]];
    }
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
