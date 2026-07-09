/**
 * Core Component — fabric wire-list pane (docs/ports-and-wires.md, "P1.5 — Wire
 * list & replay-as-debugger"). The GLOBAL edge view: every wire (config + runtime,
 * merged) rendered with the value currently on it and its validity, plus delete.
 *
 * Division of labour (decision 6): the component-ports pane owns wire CREATION
 * (contextual, per input); this pane owns the global VIEW + DELETE. No standalone
 * ports overlay between them. Runtime wires are deletable here; config-authored
 * wires are shown (tagged) but not runtime-removable (they live in the YAML).
 *
 * Pure render over listWires() + portValue (inspectWires). panel/ → fabric/ is a
 * clean down-edge.
 */
'use strict';

const mnav = require('../../leaves/wm/nav');
const {
  esc, theme, renderPanel, getSel, getScroll,
} = require('../api');
const route = require('../route');
const { listWires, portValue } = require('../../fabric/ports');
const { inspectWires } = require('../../fabric/inspect');
const { fmtValue } = require('./format');

// Rows = every merged wire, annotated with its current value + validity.
function getItems() {
  return inspectWires(listWires(), portValue);
}

function render(panel, w, h, _slice, opts) {
  const focused = !!(opts && opts.focused);
  const chrome = opts && opts.chrome;
  const t = theme();
  const rows = getItems();

  if (!rows.length) {
    return renderPanel({
      width: w, height: h,
      lines: [`[${t.dim}]${esc('(no wires — connect inputs from the component-ports pane)')}[/]`],
      title: panel.title || 'Wires', hotkey: panel.hotkey,
      panelType: 'fabric-wires', focused, chrome,
    });
  }

  const sel = getSel(panel.paneId);
  const edgeW = Math.min(48, Math.max(8, ...rows.map((r) => (`${r.from} → ${r.to}`).length)));
  const lines = rows.map((r, i) => {
    const edge = `${r.from} → ${r.to}`;
    const val = fmtValue(r.value);
    const mark = r.present ? '✓' : '✗';   // width-1 text glyphs (not emoji ⚠ U+26A0, terminal-width-ambiguous)
    const tag = r.source === 'runtime' ? '' : ' [cfg]';
    const body = `${_pad(edge, edgeW)}  ${mark} ${val || (r.present ? '' : 'upstream unset')}${tag}`;
    if (focused && i === sel) return `[${t.selected}]▸ ${esc(body)}`;
    const markCol = r.present ? `[${t.accent || t.selected}]✓[/]` : `[${t.dim}]✗[/]`;
    return `  ${esc(_pad(edge, edgeW))}  ${markCol} [${t.dim}]${esc(val || (r.present ? '' : 'upstream unset'))}${esc(tag)}[/]`;
  });
  lines.push('');
  lines.push(`  [${t.dim}]${esc('d delete (runtime wires)')}[/]`);

  return renderPanel({
    width: w, height: h, lines,
    title: panel.title || 'Wires', hotkey: panel.hotkey,
    panelType: 'fabric-wires', focused,
    count: [sel + 1, rows.length],
    scrollOffset: getScroll(panel.paneId),
    chrome,
  });
}

function _pad(s, n) { return s.length >= n ? s : s + ' '.repeat(n - s.length); }

// d/x on a wire → delete it (runtime only; a config wire lives in the YAML). The
// row address needs model access, so a fabric_wire_delete effect resolves it.
function update(msg, slice) {
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  if (msg && msg.type === 'key' && (msg.key === 'd' || msg.key === 'x')) {
    return [slice, [{ type: '_claimed' }, { type: 'fabric_wire_delete', paneId: slice.paneId, cursor: mnav.cursorOf(slice, 'fabric-wires') }]];
  }
  return slice;
}

function installEffects(registerEffect) {
  registerEffect('fabric_wire_delete', (eff, host) => {
    const row = getItems()[eff.cursor];
    if (!row) return;
    if (row.source !== 'runtime') {
      require('../../io/diag-log').warn('fabric_wire_config',
        `${row.from} → ${row.to} is a config wire — edit the YAML to remove it`);
      return;
    }
    host.applyMsg({ type: 'wire_delete', from: row.from, to: row.to });
  });
}

module.exports = {
  name: 'fabric-wires',
  init: (paneId) => ({ nav: mnav.init(), paneId }),
  update,
  installEffects,
  panelTypes: {
    'fabric-wires': {
      render,
      getItems,
      idOf: (row) => `${row.from}→${row.to}`,
    },
  },
};
