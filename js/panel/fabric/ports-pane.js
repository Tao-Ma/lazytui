/**
 * Core Component — component-ports pane (docs/ports-and-wires.md, "P1.5 —
 * Component-ports pane"). A follows-focus INSPECTOR over a fabric component's
 * whole port surface: the operate-half (input ports — resolved value + source
 * badge + readiness) and the check-half (output ports — current value). One pane
 * KIND, not one per component; it retargets to the component the user is looking
 * at, IDE-inspector style, or to a pinned/configured one.
 *
 * Slice B is the read-only inspector. Field editing (→ inject), "connect to…"
 * wiring, and Run/Clear are Slices C/D — this renders the surface those act on.
 *
 * Adds no new fabric semantics: it's a VIEW over inspectComponent (which composes
 * resolveInputs + portValue). panel/ → fabric/ is a clean down-edge (fabric is a
 * bottom layer and imports nothing back).
 *
 * Config shape:
 *   - type: component-ports
 *     title: Ports
 *     select_from: actions   # optional — follow this pane's selection
 *     component: xlogminer   # optional — pin to one component (overrides focus)
 */
'use strict';

const { getModel } = require('../../model/store');
const mnav = require('../../leaves/wm/nav');
const {
  esc, theme, renderPanel,
  getSel, getItems: apiGetItems,
} = require('../api');
const route = require('../route');
const { listPorts, portValue, listWires, componentPorts } = require('../../fabric/ports');
const { inspectComponent } = require('../../fabric/inspect');
const { fmtValue: _fmtValue, sourceLabel: _sourceLabel } = require('./format');

// ── Component-name resolution ──────────────────────────────────────────────
// Precedence: runtime pin → config-pinned → configured source pane's selection
// → focused pane's selection. Only a name that is a fabric component (declares
// ports) is accepted; anything else falls through to the next source.

function _fabricComponents() {
  return new Set(listPorts().map((p) => p.component));
}

// The row under a pane's cursor, reduced to a component-name candidate: a
// [key, action] tuple (actions pane) yields its key; a string row IS the name.
function _selectionName(paneId) {
  if (!paneId) return null;
  let items = [];
  try { items = apiGetItems(paneId); } catch { return null; }
  const item = items[getSel(paneId)];
  if (Array.isArray(item)) return typeof item[0] === 'string' ? item[0] : null;
  return typeof item === 'string' ? item : null;
}

// Resolves off the SLICE (not the arrange `panel`), so getItems — which only
// receives the slice — resolves identically to render. `selectFrom`/`component`
// are stashed from paneDef at init; `pinned` is a runtime pin (Slice D).
function _resolveComponent(slice) {
  const fab = _fabricComponents();
  const ok = (n) => (n && fab.has(n) ? n : null);
  if (!slice) return null;
  // 1. runtime pin (Slice D sets slice.pinned).
  if (slice.pinned && ok(slice.pinned)) return slice.pinned;
  // 2. config-pinned single component.
  if (slice.component && ok(slice.component)) return slice.component;
  // 3. configured source pane (deterministic, like stats' select_from).
  if (slice.selectFrom) { const n = ok(_selectionName(slice.selectFrom)); if (n) return n; }
  // 4. follows-focus: the focused pane's selection (skip self so the inspector
  //    doesn't try to inspect its own rows).
  const focus = route.getFocus();
  if (focus && focus !== slice.paneId) { const n = ok(_selectionName(focus)); if (n) return n; }
  return null;
}

// The current inspect context off the live model — shared by render + getItems.
function _ctx() {
  return {
    injects: (getModel().fabric && getModel().fabric.injects) || {},
    wires: listWires(),
    portValue,
  };
}

// Navigable rows = the input ports (the edit targets). getItems receives only
// the slice, so it resolves the component the same way render does; the row
// order matches inspectComponent().inputs (both walk Object.entries(in)). Run/
// Clear + output rows are rendered by render() but are not navigated here.
function getItems(slice) {
  const name = _resolveComponent(slice);
  if (!name) return [];
  return inspectComponent(name, componentPorts(name), _ctx()).inputs
    .map((r) => ({ ...r, addr: `${name}.${r.port}` }));
}

// ── Rendering ────────────────────────────────────────────────────────────────
const PLACEHOLDER = '▏';

function _pad(s, n) { const len = s.length; return len >= n ? s : s + ' '.repeat(n - len); }

function _renderEmpty(panel, w, h, msg, focused, chrome) {
  const t = theme();
  return renderPanel({
    width: w, height: h,
    lines: [`[${t.dim}]${esc(msg)}[/]`],
    title: panel.title, hotkey: panel.hotkey,
    panelType: 'component-ports', focused: !!focused, chrome,
  });
}

function render(panel, w, h, slice, opts) {
  const focused = !!(opts && opts.focused);
  const chrome = opts && opts.chrome;

  const name = _resolveComponent(slice);
  if (!name) {
    return _renderEmpty(panel, w, h,
      '(no fabric component in focus — select one, configure select_from, or pin)',
      focused, chrome);
  }

  const data = inspectComponent(name, componentPorts(name), _ctx());
  const sel = getSel(panel.paneId);   // cursor over the input rows
  const t = theme();
  // Field-edit in progress on THIS pane? (fabricFieldMode + our paneId.)
  const ff = getModel().modal && getModel().modal.fabricField;
  const editing = !!(getModel().modes && getModel().modes.fabricFieldMode) && ff && ff.paneId === panel.paneId;

  // Column widths for the input/output tables (bounded so a long value doesn't
  // shove the annotation off-screen — renderPanel truncates the row anyway).
  const allPorts = [...data.inputs, ...data.outputs];
  const portW = Math.min(16, Math.max(4, ...allPorts.map((r) => r.port.length)));
  const typeW = Math.min(14, Math.max(4, ...allPorts.map((r) => (r.type || '').length)));

  const lines = [];
  // Header: component name + readiness badge (right-aligned).
  const badge = data.ready
    ? `[${t.accent || t.selected}]✓ ready[/]`
    : `[${t.dim}]⛔ not ready: ${esc(data.missing.map((m) => m.port).join(', '))}[/]`;
  const nameCell = `[bold]${esc(name)}[/]`;
  const gap = Math.max(1, (w - 2) - name.length - _visibleBadgeLen(data));
  lines.push(nameCell + ' '.repeat(gap) + badge);
  lines.push('');

  // Operate-half — input ports (navigable; row order == getItems order).
  if (data.inputs.length) {
    lines.push(`[${t.dim}]in:[/]`);
    data.inputs.forEach((row, i) => {
      const val = _fmtValue(row.value);
      const ann = _sourceLabel(row);
      const req = row.required && row.value === undefined ? ' *' : '';
      // Being edited → show the live buffer + a cursor block instead of the
      // resolved value/source (the editor commits it as an inject on Enter).
      if (editing && ff.addr === `${name}.${row.port}`) {
        const body = `${_pad(row.port, portW)}  ${_pad(row.type || '', typeW)}  ${ff.text}▏`;
        lines.push(`[${t.selected}]▸ ${esc(body)}`);
        return;
      }
      const body = `${_pad(row.port, portW)}  ${_pad(row.type || '', typeW)}  ${val !== '' ? val : PLACEHOLDER}  ${ann}${req}`;
      if (focused && i === sel) {
        // Selected row: plain text under [reverse]/selected, no inner markup
        // (PRINCIPLES §8).
        lines.push(`[${t.selected}]▸ ${esc(body)}`);
      } else {
        const shown = val !== '' ? esc(val) : `[${t.dim}]${PLACEHOLDER}[/]`;
        lines.push(`  ${esc(_pad(row.port, portW))}  [${t.dim}]${esc(_pad(row.type || '', typeW))}[/]  ${shown}  [${t.dim}]${esc(ann)}${req}[/]`);
      }
    });
  }

  // Separator + affordance hints (Enter run · e edit → inject · w wire · x clear).
  lines.push(`  [${t.dim}]${'─'.repeat(Math.min(12, w - 4))}[/]`);
  if (data.inputs.length) {
    lines.push(`  [${t.dim}]${esc('↵ run · e edit · w wire · x clear')}[/]`);
  } else {
    lines.push(`  [${t.dim}]${esc('↵ run')}[/]`);
  }

  // Check-half — output ports.
  if (data.outputs.length) {
    lines.push('');
    lines.push(`[${t.dim}]out:[/]`);
    for (const row of data.outputs) {
      const val = _fmtValue(row.value);
      const mark = row.present ? `[${t.accent || t.selected}]✓[/]` : `[${t.dim}]—[/]`;
      const shown = val !== '' ? esc(val) : `[${t.dim}](no value)[/]`;
      lines.push(`  ${esc(_pad(row.port, portW))}  [${t.dim}]${esc(_pad(row.type || '', typeW))}[/]  ${mark} ${shown}`);
    }
  }

  return renderPanel({
    width: w, height: h, lines,
    title: `${panel.title || 'Ports'}: ${esc(name)}`,
    hotkey: panel.hotkey,
    panelType: 'component-ports',
    focused,
    count: data.inputs.length ? [sel + 1, data.inputs.length] : null,
    chrome,
  });
}

// Visible length of the readiness badge (markup stripped) — for right-alignment.
function _visibleBadgeLen(data) {
  return data.ready ? '✓ ready'.length
    : `⛔ not ready: ${data.missing.map((m) => m.port).join(', ')}`.length;
}

// Focused-pane keys (config-status precedent): Enter edits the selected input
// (→ inject), `x` clears its inject. Both CLAIM the key so the framework's
// run_selected default doesn't also fire. The selected row's address needs
// model/focus access the pure update lacks, so a fabric_field_open / _clear
// effect resolves paneId+cursor → addr (see installEffects). j/k etc. arrive as
// nav Msgs (handled by mnav) and are NOT claimed.
function update(msg, slice) {
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  if (msg && msg.type === 'key') {
    const cursor = mnav.cursorOf(slice, 'component-ports');
    const claim = (cmd) => [slice, [{ type: '_claimed' }, cmd]];
    // Enter runs the component (lazytui's Enter=activate); e edits the selected
    // input (→ inject); w wires it; x clears its inject. All claim the key so the
    // framework default doesn't also fire. Row/component resolution needs model
    // access, so each defers to an effect (see installEffects).
    if (msg.key === 'return') return claim({ type: 'fabric_run', paneId: slice.paneId });
    if (msg.key === 'e') return claim({ type: 'fabric_field_open', paneId: slice.paneId, cursor });
    if (msg.key === 'x') return claim({ type: 'fabric_field_clear', paneId: slice.paneId, cursor });
    if (msg.key === 'w') return claim({ type: 'fabric_connect_open', paneId: slice.paneId, cursor });
  }
  return slice;
}

// Resolve the selected input row → its address (model/focus access lives here,
// off the pure update), then drive the field editor / clear. The row index
// might be stale (component retargeted) → guard on a missing row.
function installEffects(registerEffect) {
  const rowAt = (paneId, cursor) => {
    const slice = route.getInstanceSlice(paneId);
    return slice ? getItems(slice)[cursor] : null;
  };
  registerEffect('fabric_field_open', (eff, host) => {
    const row = rowAt(eff.paneId, eff.cursor);
    if (!row) return;
    const inj = (getModel().fabric && getModel().fabric.injects) || {};
    const cur = inj[row.addr] && inj[row.addr].value;
    host.applyMsg({ type: 'fabric_field_enter', paneId: eff.paneId, addr: row.addr, text: cur != null ? String(cur) : '' });
  });
  registerEffect('fabric_field_clear', (eff, host) => {
    const row = rowAt(eff.paneId, eff.cursor);
    if (row) host.applyMsg({ type: 'port_clear', port: row.addr });
  });
  // "connect to…" — summon the global producer-port picker (menu.js), compatible-
  // first (only type-matching outputs; wires are the TYPED edge). Selecting one
  // emits wire_create via the menu's handleAction verb. Subsumes a standalone
  // ports overlay (decision 6). Global listPorts → a follows-focus pane can wire
  // to any producer.
  registerEffect('fabric_connect_open', (eff, host) => {
    const row = rowAt(eff.paneId, eff.cursor);
    if (!row) return;
    const to = row.addr;
    const producers = listPorts().filter((p) => p.dir === 'out' && p.type === row.type);
    const items = producers.length
      ? producers.map((p) => {
        const from = `${p.component}.${p.port}`;
        return [`${from} (${p.type})`, 'wire_create', { from, to }];
      })
      : [[`(no producer port of type ${row.type || '?'})`, 'noop', null]];
    host.applyMsg({ type: 'menu_open', items, title: `Wire → ${to}` });
  });
  // Run the inspected component — the existing action dispatch (pull-at-invoke
  // resolves its inputs; readiness errors-and-tells). No new run path (decision
  // 5). Resolves the component off the slice; needs the run seam on the host.
  registerEffect('fabric_run', (eff, host) => {
    const slice = route.getInstanceSlice(eff.paneId);
    const name = slice && _resolveComponent(slice);
    if (name && host.runActionByKey) host.runActionByKey(name);
  });
}

module.exports = {
  name: 'component-ports',
  // init-injection (#4): stash the pane's own paneId + the paneDef config
  // (select_from / component) so getItems — which receives only the slice —
  // resolves the inspected component identically to render.
  init: (paneId, seed) => ({
    nav: mnav.init(),
    paneId,
    pinned: null,
    selectFrom: (seed && seed.paneDef && seed.paneDef.select_from) || null,
    component: (seed && seed.paneDef && seed.paneDef.component) || null,
  }),
  update,
  installEffects,
  panelTypes: {
    'component-ports': {
      render,
      getItems,
      idOf: (row) => row.addr,
    },
  },
  // Test-only internals.
  _resolveComponent, getItems,
};
