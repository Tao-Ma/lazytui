/**
 * agent — the live-agent pane's MODEL (Slice A2, docs/live-agent.md §"The
 * model"). The slice holds everything the user sees: the settled transcript
 * (a capped line buffer, the ring the Transcript tab pioneered), the coarse
 * turn status for the status line, the input draft, and the descriptor
 * (which backend / model / session). All of it is folded here by PURE
 * reducer arms — the subprocess itself lives off-model in io/agent.js, and
 * render stays `frame = f(model)`.
 *
 * One Msg arm does the folding: `agent_event { evt }` carries a normalized
 * AgentEvent (js/agent/protocol.js vocabulary), dispatched per-instance by
 * the A3 wiring — so recorded Msgs re-fold the transcript on replay with no
 * side-channel. `assistant-delta` is deliberately NOT folded (spinner +
 * settle; the wiring shouldn't even dispatch deltas — the arm is an identity
 * no-op if one arrives).
 *
 * Interaction (scroll / search / select / cursor) falls through to the
 * SHARED `leaves/text/text-view-update` reducer over the transcript, exactly
 * like a text-view instance — the transcript is a scrollable text buffer
 * with extra fold arms, not a new kind of thing.
 *
 * Trust boundary: every backend-sourced string (assistant text, tool names/
 * args/results, error messages) routes through esc() before entering the
 * transcript — same T32 posture as stream.js's headers.
 *
 * `status.state` is a SUPERSET of the protocol's STATUS_STATES: the slice
 * adds 'starting' (before the first settled) and 'exited' (after exit) —
 * pane-lifecycle states no backend event carries directly.
 *
 * The pane half (panelTypes render + mint + agent-mode input) lands in A4;
 * until then this Component is NOT in BUILTIN_COMPONENTS.
 */
'use strict';

const tvu = require('../../leaves/text/text-view-update');
const { esc } = require('../../leaves/text/ansi');
const { paneInnerH } = require('../pane-viewport');

// Transcript ring cap (the Transcript tab's 1000-line precedent); per-pane
// override via config `cap`. Keeps replay checkpoints small.
const DEFAULT_CAP = 1000;

function init(paneId, seed) {
  const cfg = (seed && seed.paneDef && seed.paneDef.config) || {};
  return {
    paneId: paneId || null,
    transcript: [],
    status: { state: 'starting', tokens: null, cost: null },
    inputDraft: { text: '', cursor: 0 },
    descriptor: {
      backend: cfg.backend || 'mock',
      model: cfg.model || null,
      label: cfg.label || null,
      sessionId: cfg.sessionId || null,
    },
    cap: (Number.isFinite(cfg.cap) && cfg.cap > 0) ? cfg.cap : DEFAULT_CAP,
    scroll: 0,
    innerH: 0,
    // Shared-reducer interaction state — same shapes as text-view/viewer.
    search: { active: false, term: '', idx: 0, typing: '' },
    select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
    cursor: { line: 0, col: 0 },
  };
}

/** Append lines with bottom-stick scroll (text-view's _appendLines) + the
 *  ring cap. When the cap drops lines off the front, scroll/cursor/select
 *  shift down with the content so the view + anchors stay stable. */
function _append(slice, incoming) {
  if (!incoming || !incoming.length) return slice;
  const innerH = slice.innerH > 0 ? slice.innerH : 1;
  const cur = slice.transcript || [];
  const wasAtBottom = (slice.scroll || 0) >= Math.max(0, cur.length - innerH);
  let transcript = cur.concat(incoming);
  const cap = slice.cap > 0 ? slice.cap : DEFAULT_CAP;
  const dropped = Math.max(0, transcript.length - cap);
  if (dropped) transcript = transcript.slice(dropped);
  const scroll = wasAtBottom
    ? Math.max(0, transcript.length - innerH)
    : Math.max(0, (slice.scroll || 0) - dropped);
  const next = { ...slice, transcript, scroll };
  if (dropped) {
    const shift = (p) => ({ line: Math.max(0, ((p && p.line) || 0) - dropped), col: (p && p.col) || 0 });
    next.cursor = shift(slice.cursor);
    if (slice.select && slice.select.active) {
      next.select = { ...slice.select, anchor: shift(slice.select.anchor), cursor: shift(slice.select.cursor) };
    }
  }
  return next;
}

/** Merge a status patch; identity when nothing actually changes. */
function _status(slice, patch) {
  const cur = slice.status || {};
  const next = { ...cur, ...patch };
  if (next.state === cur.state && next.tokens === cur.tokens && next.cost === cur.cost) return slice;
  return { ...slice, status: next };
}

/** One-line preview of a tool call's args (raw-truncated BEFORE esc, so a
 *  cut can't open a markup token). */
function _argsPreview(args) {
  if (!args || typeof args !== 'object' || !Object.keys(args).length) return '';
  const s = JSON.stringify(args);
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
}

/** Prefix-decorate a (possibly multi-line) result: glyph on the first line,
 *  two-space hang on the rest, one color for the block. Split BEFORE esc —
 *  esc strips control chars, which would eat the newlines. */
function _blockLines(text, color, glyph) {
  const raw = String(text == null ? '' : text).split('\n');
  return raw.map((l, i) =>
    i === 0 ? `[${color}]${glyph} ${esc(l)}[/]` : `[${color}]  ${esc(l)}[/]`);
}

/** Fold one normalized AgentEvent into the slice. Pure; identity on no-ops
 *  (deltas, unknown types, status that changes nothing). */
function _fold(slice, evt) {
  switch (evt.type) {
    case 'turn-start':
      return _status(slice, { state: 'thinking' });
    case 'assistant-delta':
      return slice;   // spinner + settle: deltas never touch the model
    case 'assistant-message':
      return _append(slice, String(evt.text == null ? '' : evt.text).split('\n').map(esc));
    case 'tool-call': {
      const preview = _argsPreview(evt.args);
      return _append(slice, [`[dim]→ ${esc(String(evt.name))}(${esc(preview)})[/]`]);
    }
    case 'tool-result': {
      const text = typeof evt.result === 'string' ? evt.result
        : evt.result === undefined ? ''
        : JSON.stringify(evt.result);
      return _append(slice, evt.isError
        ? _blockLines(text, 'red', '✗')
        : _blockLines(text, 'dim', '←'));
    }
    case 'status': {
      const patch = { state: evt.state };
      if (evt.tokens !== undefined) patch.tokens = evt.tokens;
      if (evt.cost !== undefined) patch.cost = evt.cost;
      return _status(slice, patch);
    }
    case 'turn-end':
      return slice;   // state stays until `settled` (queued turns) or the next turn-start
    case 'settled':
      return _status(slice, { state: 'idle' });
    case 'error':
      return _append(slice, [`[red]✗ ${esc(String(evt.message))}[/]`]);
    case 'exit': {
      const label = evt.code === null ? '(killed)' : `(exit ${evt.code})`;
      return _status(_append(slice, [`[yellow]Session ended ${label}.[/]`]), { state: 'exited' });
    }
    default:
      return slice;   // io/agent validates; an unknown type here is a no-op, not a crash
  }
}

function update(msg, slice) {
  // Stamped viewport height → slice, ref-preserving (text-view FIX-2 mirror).
  if (msg && msg.innerH > 0 && slice.innerH !== msg.innerH) slice = { ...slice, innerH: msg.innerH };
  switch (msg.type) {
    case 'agent_event':
      return _fold(slice, msg.evt || {});
    default: break;
  }
  // Interaction over the transcript — the shared text-view reducer.
  const r = tvu.reduce(msg, slice, slice.transcript || [], 'agent');
  return r === null ? slice : r;
}

// Framework (loop._augment) stamps the viewport height so update() stays pure
// of layout geometry — verbatim text-view augmentMsg.
function augmentMsg(msg, model, slice) {
  if (msg.innerH > 0) return msg;
  const ih = paneInnerH(slice);
  return ih > 0 ? { ...msg, innerH: ih } : msg;
}

module.exports = {
  name: 'agent',
  init,
  update,
  augmentMsg,
};
