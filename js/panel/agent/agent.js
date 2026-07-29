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
 * The pane half (A4): render = transcript window + a status line + the input
 * draft, all pure f(slice) (the one impure-shell read is the agentMode flag
 * for the cursor, mirroring text-view's detailSearchMode read). Input rides
 * two arms: `agent_activate` (Enter on the pane — start the session
 * idempotently + flip the mode) and `agent_input` (a keystroke in agent
 * mode; the mode handler stamps `selfId` so Cmds carry the session id).
 * Esc interrupts while a turn is in flight, leaves the mode when idle.
 */
'use strict';

const tvu = require('../../leaves/text/text-view-update');
const ms = require('../../leaves/text/search');
const { esc } = require('../../leaves/text/ansi');
const { buildTextView } = require('../../leaves/text-view/render');
const { renderPanel } = require('../api');
const { paneInnerH } = require('../pane-viewport');
const { getModel } = require('../../model/store');

// Transcript ring cap (the Transcript tab's 1000-line precedent); per-pane
// override via config `cap`. Keeps replay checkpoints small.
const DEFAULT_CAP = 1000;

function init(paneId, seed) {
  const cfg = (seed && seed.paneDef && seed.paneDef.config) || {};
  return {
    paneId: paneId || null,
    transcript: [],
    status: { state: 'starting', tokens: null, cost: null, tool: null },
    inputDraft: { text: '', cursor: 0 },
    descriptor: {
      backend: cfg.backend || 'mock',
      provider: cfg.provider || null,   // pi: --provider (else parsed off a 'provider/model' model)
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
  if (next.state === cur.state && next.tokens === cur.tokens
      && next.cost === cur.cost && next.tool === cur.tool) return slice;
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
      // Also drive the spinner (§Streaming "thinking… (tool: …)"): the fold
      // sets state 'tool' + the name HERE, backend-agnostically — no backend
      // reliably emits a status event per tool.
      const preview = _argsPreview(evt.args);
      return _status(_append(slice, [`[dim]→ ${esc(String(evt.name))}(${esc(preview)})[/]`]),
                     { state: 'tool', tool: String(evt.name) });
    }
    case 'tool-result': {
      const text = typeof evt.result === 'string' ? evt.result
        : evt.result === undefined ? ''
        : JSON.stringify(evt.result);
      return _status(_append(slice, evt.isError
        ? _blockLines(text, 'red', '✗')
        : _blockLines(text, 'dim', '←')),
        { state: 'thinking', tool: null });
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
      // _blockLines splits BEFORE esc — a real backend error can be
      // multi-line (pi's no-API-key message is), and an embedded \n inside
      // one transcript row corrupts row rendering. Caught by live-Pi
      // validation; the fixtures' errors were all single-line.
      return _append(slice, _blockLines(String(evt.message), 'red', '✗'));
    case 'exit': {
      const label = evt.code === null ? '(killed)' : `(exit ${evt.code})`;
      return _status(_append(slice, [`[yellow]Session ended ${label}.[/]`]), { state: 'exited' });
    }
    default:
      return slice;   // io/agent validates; an unknown type here is a no-op, not a crash
  }
}

// The session-states during which Esc means "interrupt the turn" rather than
// "leave agent mode" (the in-flight half of the protocol's STATUS_STATES).
const BUSY_STATES = ['thinking', 'tool', 'compacting', 'retrying'];

/** One agent-mode keystroke (`agent_input`, id stamped by the mode handler).
 *  Enter sends (and idempotently starts/restarts the session — self-healing
 *  after an exit); Esc interrupts while busy, leaves the mode when not;
 *  everything else edits the draft (the prompt_key idiom: ASCII printable via
 *  seq, \x7f backspace, Ctrl+U clear, bracketed paste) with a cursor. */
function _input(slice, msg) {
  const { key, seq, selfId } = msg;
  const d = slice.inputDraft || { text: '', cursor: 0 };
  if (key === 'escape') {
    // Busy is judged off the MODELED status, which flips to 'thinking' only
    // when the turn-start event folds — an Esc in the send→turn-start tick
    // window exits the mode instead of interrupting (re-enter + Esc works;
    // inherent to modeled-status semantics, kept for purity).
    if (BUSY_STATES.includes((slice.status || {}).state)) {
      return [slice, [{ type: 'agent_interrupt', id: selfId }]];
    }
    return [slice, [{ type: 'msg', msg: { type: 'agent_exit' } }]];
  }
  if (key === 'return') {
    const text = (d.text || '').trim();
    if (!text) return slice;
    const next = _append({ ...slice, inputDraft: { text: '', cursor: 0 } },
                         [`[cyan]› ${esc(text)}[/]`]);
    return [next, [
      { type: 'agent_start', id: selfId, cfg: { ...slice.descriptor } },
      { type: 'agent_send', id: selfId, text },
    ]];
  }
  // Page keys scroll the transcript while chatting (the draft is one line, so
  // they're free); plain up/down stay reserved (draft history, later).
  if (key === 'pageup' || key === 'pagedown') {
    const innerH = slice.innerH > 0 ? slice.innerH : 1;
    const lines = slice.transcript || [];
    const maxScroll = Math.max(0, lines.length - innerH);
    const scroll = Math.max(0, Math.min(maxScroll,
      (slice.scroll || 0) + (key === 'pageup' ? -innerH : innerH)));
    return scroll === (slice.scroll || 0) ? slice : { ...slice, scroll };
  }
  let text = d.text || '';
  let cursor = Math.max(0, Math.min(text.length, d.cursor | 0));
  if (key === 'backspace' || seq === '\x7f') {
    if (cursor > 0) { text = text.slice(0, cursor - 1) + text.slice(cursor); cursor--; }
  } else if (key === 'delete') {
    text = text.slice(0, cursor) + text.slice(cursor + 1);
  } else if (key === 'left')  { cursor = Math.max(0, cursor - 1); }
  else if (key === 'right')   { cursor = Math.min(text.length, cursor + 1); }
  else if (key === 'home')    { cursor = 0; }
  else if (key === 'end')     { cursor = text.length; }
  else if (seq === '\x15')    { text = ''; cursor = 0; }                 // Ctrl+U (prompt/cmdline parity)
  else if (key === 'paste' && typeof seq === 'string') {
    const pasted = seq.replace(/[\r\n]+/g, ' ');                          // single-line draft
    text = text.slice(0, cursor) + pasted + text.slice(cursor);
    cursor += pasted.length;
  } else if (seq && seq.length === 1 && seq.charCodeAt(0) >= 32 && seq.charCodeAt(0) < 127) {
    text = text.slice(0, cursor) + seq + text.slice(cursor);
    cursor++;
  } else {
    return slice;
  }
  if (text === d.text && cursor === d.cursor) return slice;
  return { ...slice, inputDraft: { text, cursor } };
}

function update(msg, slice) {
  // Stamped viewport height → slice, ref-preserving (text-view FIX-2 mirror).
  if (msg && msg.innerH > 0 && slice.innerH !== msg.innerH) slice = { ...slice, innerH: msg.innerH };
  switch (msg.type) {
    case 'agent_event':
      return _fold(slice, msg.evt || {});
    case 'agent_activate':
      // Enter on the pane (run_selected fork): start the session — idempotent
      // while live, replaces an exited one — then flip into agent mode.
      return [slice, [
        { type: 'agent_start', id: msg.selfId, cfg: { ...slice.descriptor } },
        { type: 'msg', msg: { type: 'agent_enter' } },
      ]];
    case 'agent_input':
      return _input(slice, msg);
    default: break;
  }
  // Interaction over the transcript — the shared text-view reducer.
  const r = tvu.reduce(msg, slice, slice.transcript || [], 'agent');
  return r === null ? slice : r;
}

// Framework (loop._augment) stamps the viewport height so update() stays pure
// of layout geometry — text-view's augmentMsg, minus the TWO interior rows the
// agent pane reserves (status line + input draft), so scroll clamps against
// the real transcript viewport.
function augmentMsg(msg, model, slice) {
  if (msg.innerH > 0) return msg;
  const ih = paneInnerH(slice) - 2;
  return ih > 0 ? { ...msg, innerH: ih } : msg;
}

// --- render — pure f(slice): transcript window + status + draft -------------

const STATUS_LINE = {
  starting:   '[dim]· not started[/]',   // the draft ghost carries the "Enter to chat" hint
  idle:       '[green]· idle[/]',
  thinking:   '[yellow]· thinking…[/]',
  tool:       '[yellow]· running tool…[/]',
  compacting: '[yellow]· compacting…[/]',
  retrying:   '[yellow]· retrying…[/]',
  exited:     '[red]· session ended[/]',
};

function _statusLine(slice) {
  const st = slice.status || {};
  let line = (st.state === 'tool' && st.tool)
    ? `[yellow]· tool: ${esc(st.tool)}…[/]`   // the spec's "(tool: …)" spinner
    : (STATUS_LINE[st.state] || STATUS_LINE.idle);
  const extras = [];
  if (Number.isFinite(st.tokens)) extras.push(`${st.tokens} tok`);
  if (Number.isFinite(st.cost)) extras.push(`$${st.cost.toFixed(2)}`);
  if (extras.length) line += ` [dim]· ${extras.join(' · ')}[/]`;
  return line;
}

/** The draft row. While typing (agent mode + focused) the cursor renders as a
 *  reverse cell — sliced from the RAW text before esc, so the split can't
 *  land inside an escape. The raw draft is WINDOWED around the cursor (code
 *  units — the draft is ASCII-gated; the cmdline-field idiom) so typing a
 *  message longer than the pane never goes blind: the leaf renderer right-
 *  truncates rows, which would otherwise cut the cursor + new chars off. */
function _inputLine(slice, typing, w) {
  const d = slice.inputDraft || { text: '', cursor: 0 };
  const raw = d.text || '';
  if (!typing) {
    return raw ? `[cyan]›[/] ${esc(raw)}` : '[cyan]›[/] [dim]Enter to chat[/]';
  }
  const c = Math.max(0, Math.min(raw.length, d.cursor | 0));
  // Budget: pane interior (w-2) minus the '› ' prefix and one slack column
  // for the left '…' marker; the cursor cell may sit one past the text end.
  const avail = Math.max(8, (w | 0) - 5);
  let start = 0;
  if (raw.length + 1 > avail && c > avail - 2) {
    start = Math.min(c - (avail - 2), raw.length + 1 - avail);
  }
  const win = raw.slice(start, start + avail);
  const wc = c - start;
  const at = win.slice(wc, wc + 1);
  const pre = start > 0 ? '[dim]…[/]' : '';
  return `[cyan]›[/] ${pre}${esc(win.slice(0, wc))}[reverse]${at ? esc(at) : ' '}[/]${esc(win.slice(wc + 1))}`;
}

// Search decoration over the transcript (text-view's _searchDecoration,
// resolved against the own slice; selection wins — same precedence).
function _searchDecoration(slice, lines, focused) {
  const search = slice.search;
  if (!search) return null;
  const typingPhase = focused && getModel().modes.detailSearchMode;
  const term = typingPhase ? (search.typing || '') : (search.active ? (search.term || '') : '');
  const matches = ms.matchesFor(lines, term);
  if (!matches.length) return null;
  const activeIdx = Math.min(search.idx || 0, matches.length - 1);
  return { matches, activeIdx };
}

// Multi-tab slots show the unified strip as the title (text-view's U2e
// stopgap — same helper, same reason: siblings stay visible + clickable).
function _slotTitle(panel) {
  const strip = require('../slot-strip').unifiedSlotStrip(panel);
  return strip ? strip.title : (panel && panel.title);
}

function render(panel, w, h, slice, opts) {
  const focused = !!(opts && opts.focused);
  const lines = slice.transcript || [];
  const sel = (slice.select && slice.select.active) ? slice.select : null;
  const searchDecoration = sel ? null : _searchDecoration(slice, lines, focused);
  const tvH = Math.max(1, h - 4);   // 2 border rows + status + input
  const args = buildTextView({
    lines, scroll: slice.scroll, innerH: tvH,
    select: sel, searchDecoration,
    width: w, height: h,
    title: _slotTitle(panel), hotkey: panel.hotkey,
    panelType: 'agent', focused,
    chrome: opts && opts.chrome,
  });
  // Pin status + draft to the bottom: pad the (possibly short) transcript
  // window to its viewport, then append the two reserved rows. At degenerate
  // heights (h < 5) the interior can't hold all rows — truncate from the
  // FRONT so the status + input rows survive, not the transcript tail.
  // (Known cosmetic caveat: the leaf's scrollbar thumb spans the full
  // interior incl. the 2 reserved rows, so it can paint slightly long —
  // count geometry is transcript-true, the thumb is approximate.)
  const typing = focused && !!getModel().modes.agentMode;
  const body = args.lines.slice();
  while (body.length < tvH) body.push('');
  body.push(_statusLine(slice));
  body.push(_inputLine(slice, typing, w));
  const inner = Math.max(1, h - 2);
  if (body.length > inner) body.splice(0, body.length - inner);
  return renderPanel({ ...args, lines: body });
}

module.exports = {
  name: 'agent',
  init,
  update,
  augmentMsg,
  panelTypes: { agent: { render } },
};
