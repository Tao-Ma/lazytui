/**
 * Confirm overlay — y/N modal gate for actions with `confirm:`.
 *
 * State + behavior now live in the reducer (runtime.update: confirm_enter/
 * accept/reject). The pending effect is staged as a Cmd DESCRIPTOR (data,
 * not a closure) on model.modal.continuation (E14); `y` re-emits it. This
 * module is render-only: renderConfirmOverlay paints model.modal.confirm.message.
 *
 * v0.6.44 Brief 3 — when the staged cmd is `do_run` on an action with
 * declared `ports.in`, append a preview block showing the action's
 * script line and each port's resolution shape (`name=<value>` with a
 * source tag; sensitive ports mask as `name=••••••`). Format at render
 * time from the already-staged cmd — no new Msg carries the formatted
 * text (the brief's "format at render time, don't stamp into a Msg"
 * invariant). The preview reads live model state (injects / defaults /
 * sensitive flags via the parsed port decl); the ports form (if the
 * action also opens one after confirm) later refines any `<pending>`
 * fields through its own compact footer preview.
 */
'use strict';

const { getModel } = require('../model/store');
const { esc } = require('../leaves/text/ansi');
const { renderOverlay } = require('../leaves/render/draw');
const { formatPreview } = require('../leaves/ports/submit-preview');
const { resolveForRender } = require('../leaves/ports/resolve-for-render');

// Pre-release round-2 WAL-fidelity note: the preview block below reads
// `model.modal.continuation.cmd.action` — the whole action config
// object staged by `confirm_enter` (action-runner.js:57). That object
// is parsed-YAML + parser-stamped flags (`sensitive`, `remember`,
// `variadic`, `default`) — pure data, no closures. On WAL fold the
// `confirm_enter` Msg re-stages it through the same reducer arm;
// `structuredClone` round-trips the shape (not JSON — undefined
// values are preserved). A future change that stuffed non-serializable
// values (functions, Date, Set, Map) onto an action would break BOTH
// the preview AND the run — so the preview's accuracy is coupled to
// the invariant the run already needs. No separate pin required.
// Overlay-compositor migration (Release 2, Phase 2.a #1 — Overlay #1 of 9
// simple overlays). `newRows` + `cols` thread through to `renderOverlay`
// which composites the overlay rows into the main-frame row buffer instead
// of writing ANSI directly to stdout. The cell-diff then catches both the
// overlay's leading paint AND the clean-up on close/resize from the natural
// row delta — one of the two paths that will eventually let paint.js drop
// its per-overlay sig trackers. Omitted (unit tests / migration-period
// paths) → stdout fallback through the same `renderOverlay` call.
function renderConfirmOverlay(newRows, cols) {
  const model = getModel();
  const c = model.modal.confirm;
  if (!model.modes.confirmMode) return;
  // Split on \n so YAML "|" multi-line confirm: prompts render as
  // multiple lines instead of a single truncated row.
  const promptLines = String(c.message).split('\n').map(l => esc(l));
  const lines = [...promptLines];

  // v0.6.44 Brief 3 — append preview block when the staged cmd is a
  // `do_run` on an action with NON-EMPTY declared `ports.in`. The
  // empty-object guard (round-2 edge-cases) prevents the "`-- preview
  // --` header for a bare script line" case: an action with
  // `ports: { in: {} }` would otherwise paint the separator for no
  // extra content vs. the plain confirm.
  const cont = model.modal.continuation;
  const portsIn = cont && cont.type === 'do_run' && cont.action
                  && cont.action.ports && cont.action.ports.in;
  if (portsIn && Object.keys(portsIn).length > 0) {
    // v0.6.46 — route through the SHARED resolver the spawn path uses
    // (leaves/ports/resolve-for-render → fabric/resolve.resolveInputs).
    // Pre-fix (v0.6.44 Brief 3), this block inlined a mini-resolver that
    // read `model.fabric.injects[addr]` at the TOP level — but injects
    // are GROUP-KEYED (`{[group]: {[addr]: {value, at, oneShot?}}}`), so
    // the top-level read missed every inject and every port rendered as
    // `<pending>` even when a form submit had just injected the value.
    // The staged group lives on `cont.group` (stamped by runAction at
    // confirm_enter time) — do NOT read model.currentGroup here, the
    // user can move groups while the confirm is up.
    const action = cont.action;
    const actionKey = cont.actionKey;
    const stagedGroup = typeof cont.group === 'string' ? cont.group : '';
    const resolved = resolveForRender(actionKey, action, model, stagedGroup);
    const values = (resolved && resolved.values) || {};
    const sources = (resolved && resolved.sources) || {};
    const boundPorts = [];
    let variadic = null;
    for (const [name, decl] of Object.entries(portsIn)) {
      const v = (name in values) ? values[name] : undefined;
      if (decl && decl.variadic === true) {
        // Variadic port's value is an array (form-submit injects an
        // array via tokenize; a scalar wire would be a string that we
        // wrap into a single-item list to match spawn's `_splitVariadic`).
        let items = [];
        if (Array.isArray(v)) items = v.map(String);
        else if (v != null) items = [String(v)];
        variadic = { name, decl, items };
        continue;
      }
      const def = decl && decl.default != null ? String(decl.default) : null;
      // `source` from the resolver is one of 'inject' | 'wire' | 'default'
      // | undefined (missing — resolver leaves it out of `sources`). The
      // formatPreview leaf treats null/undefined source as `<pending>`.
      const value = (v != null) ? String(v) : def;
      const source = sources[name] || (def != null ? 'default' : null);
      boundPorts.push({ name, decl, value, source });
    }
    const previewLines = formatPreview({
      script: action.script || '',
      boundPorts, variadic,
    });
    if (previewLines.length > 0) {
      lines.push('');
      lines.push('[dim]── preview ──[/]');
      for (const pl of previewLines) lines.push(pl);
    }
  }

  lines.push('');
  lines.push('[dim]\\[y] confirm   \\[n] cancel[/]');
  renderOverlay({ lines, title: 'Confirm', maxWidth: 72,
                  targetRows: newRows || null, targetCols: cols || 0 });
}

module.exports = { renderConfirmOverlay };
