/**
 * action-legend — the ITEM-ACTION BAR border-control kind, on a pane's BOTTOM
 * border (btop-style). A clickable row of per-item actions with the trigger key
 * highlighted IN the word:
 *
 *   full (wide):   ╰─ inspect Logs shell Stop Restart Kill ──── 1 of 3 ─╯
 *   compact (narrow): ╰─ i L s S R K ─────────────────────────── 1 of 3 ─╯
 *                        ▲ key letters in the key-hint color (an affordance:
 *                          "these are pressable/clickable"); `label[0]` IS the key
 *                          (case-sensitive → an uppercase letter is a Shift chord).
 *
 * WIDTH-ADAPTIVE: full labels when they fit, else just the key letters (which
 * fit any sidebar), else nothing. The form is a pure function of the pane's
 * inner width, so render + hit-test agree. Shown on the FOCUSED pane only,
 * suppressed in free-config.
 *
 * Owns DATA + GEOMETRY only. Placement (bottom-left) lives in border-controls.js;
 * the key-hint color is a render-time theme read (like draw.js).
 */
'use strict';

const { visibleLen } = require('../text/ansi');
const { theme } = require('../infra/themes');
const bctl = require('./border-controls');
const { isChainActive } = require('../input/modes');

const SEP = ' ';   // one space between actions (also the inter-key gap when compact)

function _fullW(actions)    { return actions.reduce((a, x) => a + visibleLen(x.label), 0) + (actions.length - 1) * SEP.length; }
function _compactW(actions) { return actions.length + (actions.length - 1) * SEP.length; }   // 1 cell per key

/** full | compact | null — the widest form that fits `innerW` (bottomFits is the
 *  same predicate paint + hit-test gate on). Pure fn of (actions, innerW). */
function _form(actions, innerW) {
  if (bctl.bottomFits(innerW, _fullW(actions))) return 'full';
  if (bctl.bottomFits(innerW, _compactW(actions))) return 'compact';
  return null;
}

/** Markup + visible width for the chosen form (null = doesn't fit). Highlights
 *  each action's key: the label's first char (full) or the lone key (compact). */
function actionLegendRender(actions, innerW) {
  const form = _form(actions, innerW);
  if (!form) return null;
  const t = theme();
  const kh = t.key_hint || t.error || t.chrome_close || 'red';   // affordance color (theme red; key_hint tunes it)
  if (form === 'compact') {
    return { text: actions.map(a => `[${kh}]${a.key}[/]`).join(SEP), visibleW: _compactW(actions) };
  }
  const text = actions.map(a => `[${kh}]${a.label[0]}[/]${a.label.slice(1)}`).join(SEP);
  return { text, visibleW: _fullW(actions) };
}

/** One click region per action for the chosen form: the whole word (full) or the
 *  key cell (compact). Same form choice as render, so the regions match the paint. */
function actionLegendRegions(x0, y, actions, innerW) {
  const form = _form(actions, innerW);
  if (!form) return [];
  const regions = [];
  let cx = x0;
  for (const a of actions) {
    const w = form === 'compact' ? 1 : visibleLen(a.label);
    regions.push({ x0: cx, x1: cx + w - 1, y, action: a.id });
    cx += w + SEP.length;
  }
  return regions;
}

/**
 * A BORDER-CONTROL SPEC for the item-action bar (bottom slot). `actions` are
 * `{id, label, key}` where `label[0] === key`; `itemAt(paneId)` is the selected
 * item. render/regions receive the pane (with `innerW`) so they pick the same
 * width-adaptive form. dispatch → `item_action` against the selected item.
 */
function actionLegendSpec({ actions, itemAt }) {
  return {
    id: 'actions',
    slot: 'bottom',
    render(model, pane) {
      if (model && model.modes && model.modes.freeConfigMode) return null;
      // A modal that owns the keyboard (filter `/`, detail search, prefix, the
      // pane-menu, a confirm, …) must gate the MOUSE too: mirror the keyboard
      // modal gating so a click on this bar can't fire a focus-changing or
      // destructive action — and leak the in-grid mode — while a modal is up.
      // (isChainActive already covers freeConfigMode; the check above matches the
      // sort/refresh top controls, which only drop in free-config.)
      if (model && model.modes && isChainActive(model.modes)) return null;
      if (!pane || !pane.focused) return null;
      // Global `quick_keys` placement: `border` (default) draws this bar;
      // `footer`/`off` suppress it (the footer shows/hides the hints instead —
      // footer.js reads the same setting, so the keys live in ONE place).
      const qk = (model && model.config && model.config.quick_keys) || 'border';
      if (qk !== 'border') return null;
      return actionLegendRender(actions, pane.innerW);
    },
    regions(x0, y, _visibleW, pane) {
      return actionLegendRegions(x0, y, actions, pane.innerW);
    },
    dispatch(actionId, pane) {
      const item = itemAt(pane.paneId);
      if (item == null) return null;   // nothing selected → no-op
      return { owner: pane.paneId, msg: { type: 'item_action', action: actionId, item } };
    },
  };
}

module.exports = { actionLegendRender, actionLegendRegions, actionLegendSpec, _form, SEP };
