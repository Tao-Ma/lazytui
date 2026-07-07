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

function _resolveComponent(panel, slice) {
  const fab = _fabricComponents();
  const ok = (n) => (n && fab.has(n) ? n : null);
  // 1. runtime pin (Slice D sets slice.pinned).
  if (slice && slice.pinned && ok(slice.pinned)) return slice.pinned;
  // 2. config-pinned single component.
  if (panel.component && ok(panel.component)) return panel.component;
  // 3. configured source pane (deterministic, like stats' select_from).
  if (panel.select_from) { const n = ok(_selectionName(panel.select_from)); if (n) return n; }
  // 4. follows-focus: the focused pane's selection (skip self so the inspector
  //    doesn't try to inspect its own rows).
  const focus = route.getFocus();
  if (focus && focus !== panel.paneId) { const n = ok(_selectionName(focus)); if (n) return n; }
  return null;
}

// ── Value formatting ───────────────────────────────────────────────────────
function _fmtValue(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return `${v.length.toLocaleString()} line${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') { const n = Object.keys(v).length; return `{${n} field${n === 1 ? '' : 's'}}`; }
  const s = String(v);
  const nl = s.indexOf('\n');
  return nl >= 0 ? `${s.slice(0, nl)} …` : s;
}

// Source annotation shown after an input's value.
function _sourceLabel(row) {
  switch (row.source) {
    case 'inject':  return '(inject)';
    case 'wire':    return row.wireFrom ? `← ${row.wireFrom}` : '← wire';
    case 'default': return 'default';
    default:        return '(unset)';
  }
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

  const name = _resolveComponent(panel, slice);
  if (!name) {
    return _renderEmpty(panel, w, h,
      '(no fabric component in focus — select one, configure select_from, or pin)',
      focused, chrome);
  }

  const ctx = {
    injects: (getModel().fabric && getModel().fabric.injects) || {},
    wires: listWires(),
    portValue,
  };
  const data = inspectComponent(name, componentPorts(name), ctx);
  const t = theme();

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

  // Operate-half — input ports.
  if (data.inputs.length) {
    lines.push(`[${t.dim}]in:[/]`);
    for (const row of data.inputs) {
      const val = _fmtValue(row.value);
      const shown = val !== '' ? esc(val) : `[${t.dim}]${PLACEHOLDER}[/]`;
      const ann = `[${t.dim}]${esc(_sourceLabel(row))}[/]`;
      const req = row.required && row.value === undefined ? `[${t.dim}] *[/]` : '';
      lines.push(`  ${esc(_pad(row.port, portW))}  [${t.dim}]${esc(_pad(row.type || '', typeW))}[/]  ${shown}  ${ann}${req}`);
    }
  }

  // Separator + action row (non-interactive in Slice B; C/D wire these).
  lines.push(`  [${t.dim}]${'─'.repeat(Math.min(12, w - 4))}[/]`);
  lines.push(`  [${t.dim}]▸ Run    ▸ Clear[/]`);

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
    focused, chrome,
  });
}

// Visible length of the readiness badge (markup stripped) — for right-alignment.
function _visibleBadgeLen(data) {
  return data.ready ? '✓ ready'.length
    : `⛔ not ready: ${data.missing.map((m) => m.port).join(', ')}`.length;
}

module.exports = {
  name: 'component-ports',
  init: () => ({ nav: mnav.init(), pinned: null }),
  update: (msg, slice) => (mnav.isNavMsg(msg) ? mnav.apply(slice, msg) : slice),
  panelTypes: {
    'component-ports': { render },
  },
  // Test-only internals.
  _resolveComponent, _fmtValue, _sourceLabel,
};
