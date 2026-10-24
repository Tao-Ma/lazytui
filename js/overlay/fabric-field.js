/**
 * Fabric-field invoke-time overlay (P2 render fix).
 *
 * The fabric-field modal has TWO entry paths (docs/msg-routes.md §5.10):
 *   - Ports-pane in-grid edit: `fabric_field_open` effect dispatches
 *     `fabric_field_enter` with the pane's own `paneId`. The ports-pane render
 *     function paints the editor IN-GRID, gated on `ff.paneId === panel.paneId`.
 *     That path is unchanged.
 *   - Invoke-time prompt (args→ports P2): the action-runner's `_promptMissing`
 *     dispatches `fabric_field_enter` with `paneId: null` + `pendingAction`.
 *     The ports-pane gate can never match null (and a layout may have no ports
 *     pane at all), so this path had NO renderer — the TUI looked frozen with
 *     `fabricFieldMode` swallowing every key. This module paints that case.
 *
 * Render-only (same shape as `overlay/confirm.js`): reads `model.modal.fabricField`
 * + the port's declared `desc` from `pendingAction.action.ports.in[port]`,
 * paints via `renderOverlay`. Returns early when the mode is off or when the
 * modal belongs to the ports-pane path (paneId non-null) — the in-grid editor
 * stays unchanged.
 *
 * The edit buffer draws its caret in-buffer (inverse space), so the shared
 * cursor-visibility bitmap at the bottom of paint.js stays as-is (terminalMode
 * / cmdMode only).
 */
'use strict';

const { getModel } = require('../model/store');
const { esc } = require('../leaves/text/ansi');
const { renderOverlay } = require('../leaves/render/draw');

function renderFabricFieldOverlay() {
  const m = getModel();
  if (!m.modes || !m.modes.fabricFieldMode) return;
  const f = m.modal && m.modal.fabricField;
  if (!f) return;
  // ports-pane in-grid edit paints itself (paneId matches a real pane).
  if (f.paneId != null) return;

  // Port name is the segment AFTER the LAST dot in the address. Component
  // names may contain hyphens (v0.6.31) but never dots, so lastIndexOf splits
  // the addr cleanly.
  const addr = String(f.addr || '');
  const dot = addr.lastIndexOf('.');
  const portName = dot >= 0 ? addr.slice(dot + 1) : addr;

  // Pull the port's declared `desc` if the pendingAction carries it (the
  // action-runner path always does; non-pendingAction entry paths don't paint
  // via this overlay at all).
  const pa = f.pendingAction;
  const portDecl = pa && pa.action && pa.action.ports && pa.action.ports.in && pa.action.ports.in[portName];
  const desc = portDecl && typeof portDecl.desc === 'string' ? portDecl.desc : '';

  // The action label (if the config declares one) is a friendlier title than
  // the bare "Input" fallback; mirrors the ports-pane field editor's style.
  // esc()'d so a YAML `label: "[reverse]EVIL[/]"` lands as a literal in the
  // top border, not styled markup (slice-1 pre-release review Fork 2 — shared
  // class with the fabric-form overlay's title).
  const rawTitle = (pa && pa.action && typeof pa.action.label === 'string' && pa.action.label)
    ? pa.action.label : 'Input';
  const title = esc(rawTitle);

  // Caret in-buffer: inverse space right after the typed text. Keeps the
  // paint.js cursor-visibility bitmap untouched (terminalMode/cmdMode only).
  const text = String(f.text || '');
  const buffer = `> ${esc(text)}[reverse] [/]`;

  const lines = [`[accent]${esc(addr)}[/]`];
  if (desc) lines.push(`[dim]${esc(desc)}[/]`);
  lines.push('');
  lines.push(buffer);
  lines.push('');
  lines.push('[dim]\\[enter] run   \\[esc] cancel[/]');

  renderOverlay({ lines, title, maxWidth: 60 });
}

module.exports = { renderFabricFieldOverlay };
