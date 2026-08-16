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
  esc, theme, renderPanel, visibleLen,
  getSel, getItems: apiGetItems,
} = require('../api');
const route = require('../route');
const { listPorts, portValue, listWires, componentPorts, hasOutput } = require('../../fabric/ports');
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
  // B-F3: resolve a bare pool-id `select_from` target to its specific pane
  // instance when minted (else unchanged); idempotent on an already-resolved id.
  const src = require('../route').resolveSourcePaneId(paneId);
  let items = [];
  try { items = apiGetItems(src); } catch { return null; }
  const item = items[getSel(src)];
  if (Array.isArray(item)) return typeof item[0] === 'string' ? item[0] : null;
  return typeof item === 'string' ? item : null;
}

// Resolves off the SLICE (not the arrange `panel`), so getItems — which only
// receives the slice — resolves identically to render. `selectFrom`/`component`
// are stashed from paneDef at init; `pinned` is a runtime pin (Slice D).
//
// Returns { name, via } — `via` records WHICH precedence rule matched ('pin' |
// 'config' | 'select_from' | 'focus' | null), so render can tell the user why
// this component is showing (the follows-focus provenance subline). Only a name
// that is a fabric component (declares ports) is accepted; anything else falls
// through to the next source.
function _targetInfo(slice) {
  const fab = _fabricComponents();
  const ok = (n) => (n && fab.has(n) ? n : null);
  if (!slice) return { name: null, via: null };
  // 1. runtime pin (Slice D sets slice.pinned).
  if (slice.pinned && ok(slice.pinned)) return { name: slice.pinned, via: 'pin' };
  // 2. config-pinned single component.
  if (slice.component && ok(slice.component)) return { name: slice.component, via: 'config' };
  // 3. configured source pane (deterministic, like stats' select_from).
  if (slice.selectFrom) { const n = ok(_selectionName(slice.selectFrom)); if (n) return { name: n, via: 'select_from' }; }
  // 4. follows-focus: the focused pane's selection (skip self so the inspector
  //    doesn't try to inspect its own rows).
  const focus = route.getFocus();
  if (focus && focus !== slice.paneId) { const n = ok(_selectionName(focus)); if (n) return { name: n, via: 'focus' }; }
  return { name: null, via: null };
}

// Name-only convenience (getItems, effects, tests) — the provenance is a
// render-only concern.
function _resolveComponent(slice) { return _targetInfo(slice).name; }

// The current inspect context off the live model — shared by render + getItems.
function _ctx() {
  return {
    injects: (getModel().fabric && getModel().fabric.injects) || {},
    wires: listWires(),
    portValue,
    hasOutput,
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

// The component's dataflow ROLE, from its port surface: only outputs = a
// producer (a source), only inputs = a consumer (a sink), both = a transform
// (a pipe stage). Answers "what am I looking at" for a pane that would
// otherwise read as empty when a producer declares no inputs.
function _role(data) {
  const hasIn = data.inputs.length, hasOut = data.outputs.length;
  return hasIn && hasOut ? 'transform' : hasOut ? 'producer' : hasIn ? 'consumer' : 'component';
}

// Why THIS component is showing — the provenance subline, keyed off _targetInfo's
// `via`. Makes the follows-focus behaviour legible: the pane isn't frozen on one
// component, it tracks a selection.
function _provenance(via, slice) {
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  switch (via) {
    case 'pin':         return 'pinned — p to unpin';
    case 'config':      return 'pinned in config';
    case 'select_from': return `follows ${cap(slice.selectFrom)}`;
    case 'focus':       return 'follows focus';
    default:            return '';
  }
}

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

  const { name, via } = _targetInfo(slice);
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
  // Readiness glyphs are TEXT-presentation, width-1 (✓ U+2713 / ✗ U+2717) — NOT
  // an emoji like ⛔ (U+26D4), which real terminals render 2 columns wide while
  // charWidth/@xterm score it 1, so the badge overran the right border. Right-
  // align with visibleLen (the width truth function), never String.length.
  const badge = data.ready
    ? `[${t.accent || t.selected}]✓ ready[/]`
    : `[${t.dim}]✗ not ready: ${esc(data.missing.map((m) => m.port).join(', '))}[/]`;
  const nameCell = `[bold]${esc(name)}[/]`;
  const gap = Math.max(1, (w - 2) - visibleLen(nameCell) - visibleLen(badge));
  lines.push(nameCell + ' '.repeat(gap) + badge);
  // Provenance subline: ROLE (producer/consumer/transform) + why this component
  // is showing (follows the Actions selection / pinned). Tells the user what the
  // pane is and that it tracks a selection — the two things the bare title hid.
  const prov = _provenance(via, slice);
  lines.push(`[${t.dim}]${esc(_role(data) + (prov ? ` · ${prov}` : ''))}[/]`);
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

  // Separator + affordance hints (Enter run · e edit → inject · w wire · x clear
  // · p pin/unpin). Pin state also shows in the title.
  const pinHint = slice && slice.pinned ? 'p unpin' : 'p pin';
  lines.push(`  [${t.dim}]${'─'.repeat(Math.min(12, w - 4))}[/]`);
  if (data.inputs.length) {
    lines.push(`  [${t.dim}]${esc(`↵ run · e edit · w wire · x clear · ${pinHint}`)}[/]`);
  } else {
    lines.push(`  [${t.dim}]${esc(`↵ run · ${pinHint}`)}[/]`);
  }

  // Check-half — output ports. Shows whether each extract FIRED (the authoring
  // win): ✓ matched (has a value) · ✗ no match (producer ran, field null/empty) ·
  // — no value (not produced yet). data.ranOutput distinguishes the latter two.
  if (data.outputs.length) {
    lines.push('');
    lines.push(`[${t.dim}]out:[/]`);
    for (const row of data.outputs) {
      let mark, shown;
      if (row.present) {
        mark = `[${t.accent || t.selected}]✓[/]`;
        shown = esc(_fmtValue(row.value));
      } else if (data.ranOutput) {
        mark = `[${t.dim}]✗[/]`;
        shown = `[${t.dim}]${esc('no match')}[/]`;
      } else {
        mark = `[${t.dim}]—[/]`;
        shown = `[${t.dim}]${esc('no value')}[/]`;
      }
      lines.push(`  ${esc(_pad(row.port, portW))}  [${t.dim}]${esc(_pad(row.type || '', typeW))}[/]  ${mark} ${shown}`);
    }
  }

  return renderPanel({
    width: w, height: h, lines,
    title: `${panel.title || 'Ports'}: ${esc(name)}${slice && slice.pinned ? ' (pinned)' : ''}`,
    hotkey: panel.hotkey,
    panelType: 'component-ports',
    focused,
    count: data.inputs.length ? [sel + 1, data.inputs.length] : null,
    chrome,
  });
}

// Focused-pane keys (config-status precedent): Enter edits the selected input
// (→ inject), `x` clears its inject. Both CLAIM the key so the framework's
// run_selected default doesn't also fire. The selected row's address needs
// model/focus access the pure update lacks, so a fabric_field_open / _clear
// effect resolves paneId+cursor → addr (see installEffects). j/k etc. arrive as
// nav Msgs (handled by mnav) and are NOT claimed.
function update(msg, slice) {
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  // Runtime pin toggle (routed back from the fabric_pin_toggle effect, which
  // resolved the current component). `name` null → unpin (back to follows-focus).
  if (msg && msg.type === 'fabric_pin') return { ...slice, pinned: msg.name || null };
  if (msg && msg.type === 'key') {
    const cursor = mnav.cursorOf(slice, 'component-ports');
    const claim = (cmd) => [slice, [{ type: '_claimed' }, cmd]];
    // Enter runs the component (lazytui's Enter=activate); e edits the selected
    // input (→ inject); w wires it; x clears its inject; p pins/unpins the pane to
    // the current component. All claim the key so the framework default doesn't
    // also fire. Row/component resolution needs model access, so each defers to an
    // effect (see installEffects).
    if (msg.key === 'return') return claim({ type: 'fabric_run', paneId: slice.paneId });
    if (msg.key === 'e') return claim({ type: 'fabric_field_open', paneId: slice.paneId, cursor });
    if (msg.key === 'x') return claim({ type: 'fabric_field_clear', paneId: slice.paneId, cursor });
    if (msg.key === 'w') return claim({ type: 'fabric_connect_open', paneId: slice.paneId, cursor });
    if (msg.key === 'p') return claim({ type: 'fabric_pin_toggle', paneId: slice.paneId });
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
  //
  // With >1 compatible producer (the multi-source case), the currently-wired one
  // is TAGGED `✓ current` and FLOATED to the top, so re-pointing an input is an
  // informed choice, not blind. The current wire is the merged (runtime>config)
  // edge into `to` — the same list resolution consults.
  registerEffect('fabric_connect_open', (eff, host) => {
    const row = rowAt(eff.paneId, eff.cursor);
    if (!row) return;
    const to = row.addr;
    const cur = listWires().find((w) => w && w.to === to);
    const curFrom = cur ? cur.from : null;
    const rows = listPorts()
      .filter((p) => p.dir === 'out' && p.type === row.type)
      .map((p) => ({ from: `${p.component}.${p.port}`, type: p.type }));
    const isCur = (r) => r.from === curFrom;
    const ordered = [...rows.filter(isCur), ...rows.filter((r) => !isCur(r))];
    const items = ordered.length
      ? ordered.map((r) => [`${r.from} (${r.type})${isCur(r) ? ' ✓ current' : ''}`, 'wire_create', { from: r.from, to }])
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
  // Pin/unpin the pane to a component (the hybrid "workbench" — freeze the
  // inspector on one component while navigating elsewhere). Toggle: if already
  // pinned, unpin (null → follows-focus); else pin to the currently resolved
  // component. Routed back as a fabric_pin Component Msg (a slice write).
  registerEffect('fabric_pin_toggle', (eff, host) => {
    const slice = route.getInstanceSlice(eff.paneId);
    if (!slice) return;
    const name = slice.pinned ? null : _resolveComponent(slice);
    host.dispatchMsg(host.wrap(eff.paneId, { type: 'fabric_pin', name }));
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
