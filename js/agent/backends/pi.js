/**
 * Pi agent backend — `pi --mode rpc` as an AgentBackend (Slice A5,
 * docs/live-agent.md §"Backend: Pi via pi --mode rpc"). Pi's RPC mode is
 * JSONL over stdio (one JSON object per line, NOT JSON-RPC 2.0); Pi owns
 * provider/keys/context/compaction, so this adapter stays thin: spawn,
 * frame, map. Wire spec: pi repo, packages/coding-agent/docs/rpc.md.
 *
 * Framing (per the spec, and it is emphatic about this): split records on
 * `\n` ONLY, stripping an optional trailing `\r` — never a generic line
 * reader like Node's readline, which also splits on U+2028/U+2029, both
 * legal INSIDE JSON strings. Partial lines buffer across chunks; a
 * StringDecoder guards multi-byte codepoints split at chunk boundaries
 * (stream.js's T24 precedent).
 *
 * Mapping choices beyond the table in docs/live-agent.md:
 * - `message_update` deltas are DROPPED HERE (spinner + settle): folding
 *   per-token events would put every token through dispatch + the WAL for
 *   nothing. A future throttled-delta (metrics-mirror pattern) slots into
 *   this arm.
 * - Ready signal: Pi emits no "ready" event; the child's 'spawn' event is
 *   the session-open `settled` (stdin buffers writes until then anyway).
 * - Usage: per-turn `message.usage` accumulates on the handle; the session
 *   totals ride the `status {state:'idle'}` emitted at `agent_settled`
 *   (A2's status-merge keeps them displayed across later statuses).
 * - Extension UI dialogs (select/confirm/input/editor) would HANG the
 *   agent with nobody answering — auto-cancel them (`cancelled: true`)
 *   and surface an `error` so the user sees why. The approval seam is
 *   future work (docs/live-agent.md §Trust).
 * - After `stop`, everything but the final `exit` is suppressed (the mock's
 *   semantics; exit is contractually last).
 *
 * Token-collision note: `agent_start` names both a Pi WIRE event (Pi's
 * snake_case choice, mapped below) and a lazytui EFFECT (effects.js) — the
 * kebab-case normalized vocabulary sits between them; don't conflate.
 *
 * cfg: { provider?, model?, cwd?, sessionPath? | sessionId?, noSession?,
 *        sessionDir?, argv? }. `model` may be 'provider/model' when
 *        `provider` is unset.
 *   `argv` overrides the spawn vector entirely (the fixture/test seam —
 *   tests run `node fake-pi.js`; live validation needs pi installed).
 *   `sessionPath` resumes a persisted session via `switch_session`.
 *
 * io leaf (js/agent/): child_process + string_decoder only, no lazytui
 * imports — validation happens at io/agent's delivery edge.
 */
'use strict';

const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

/** Build the spawn vector from cfg (exported for tests). */
function _argv(cfg) {
  cfg = cfg || {};
  if (Array.isArray(cfg.argv) && cfg.argv.length) return cfg.argv.slice();
  const argv = ['pi', '--mode', 'rpc'];
  let provider = cfg.provider || null;
  let model = cfg.model || null;
  if (!provider && model && model.includes('/')) {
    const i = model.indexOf('/');
    provider = model.slice(0, i);
    model = model.slice(i + 1);
  }
  if (provider) argv.push('--provider', provider);
  if (model) argv.push('--model', model);
  if (cfg.noSession) argv.push('--no-session');
  if (cfg.sessionDir) argv.push('--session-dir', cfg.sessionDir);
  return argv;
}

function start(cfg) {
  cfg = cfg || {};
  const argv = _argv(cfg);
  const child = spawn(argv[0], argv.slice(1), {
    cwd: cfg.cwd || process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const h = {
    child,
    pid: child.pid || null,          // io/agent reads this for the jobs entry
    handler: null,
    decoder: new StringDecoder('utf8'),
    buf: '',
    running: false,                  // agent_start .. agent_settled
    stopping: false,
    exited: false,
    usage: { tokens: 0, cost: 0 },
    stderrTail: '',
  };
  child.once('spawn', () => _emit(h, { type: 'settled' }));   // session open — input-ready
  // stdin 'error' is ASYNC (EPIPE when the child dies with pipe data still
  // buffered — a large prompt/images payload into a crashed pi). Unhandled it
  // is an uncaughtException that kills the whole app; the try/catch around
  // write()/end() only covers synchronous throws. Surface + let 'close' end
  // the lifecycle. (Review H1 — reproduced before the fix.)
  child.stdin.on('error', (err) => {
    _emit(h, { type: 'error', message: `pi stdin: ${err.message}` });
  });
  child.stdout.on('data', (chunk) => _onChunk(h, chunk));
  child.stderr.on('data', (d) => { h.stderrTail = (h.stderrTail + d).slice(-2048); });
  child.on('error', (err) => {
    // Spawn failure (pi not installed, bad path): say why, then end the
    // session — 'close' may never fire for a process that never spawned.
    _emit(h, { type: 'error', message: `pi spawn failed: ${err.message}` });
    _emit(h, { type: 'exit', code: null });
  });
  child.on('close', (code, signal) => {
    if (!h.exited && !h.stopping && code !== 0 && h.stderrTail.trim()) {
      // An unexpected nonzero death: surface the stderr tail (the actual
      // reason — auth failure, bad flag) before the lifecycle exit.
      _emit(h, { type: 'error', message: `pi exited: ${h.stderrTail.trim().slice(-500)}` });
    }
    _emit(h, { type: 'exit', code: signal ? null : (code == null ? null : code) });
  });
  // Resume a persisted session. For pi the descriptor's durable "session id"
  // IS the session file path (pi persists sessions to JSONL and addresses
  // them by path) — so the pane-config `sessionId` knob feeds this too.
  const sessionPath = cfg.sessionPath || cfg.sessionId;
  if (sessionPath) _write(h, { type: 'switch_session', sessionPath });
  return h;
}

function send(h, message, opts) {
  const cmd = { type: 'prompt', message: String(message == null ? '' : message) };
  if (opts && Array.isArray(opts.images) && opts.images.length) cmd.images = opts.images;
  if (opts && opts.streamingBehavior) cmd.streamingBehavior = opts.streamingBehavior;
  _write(h, cmd);
}

function interrupt(h) {
  _write(h, { type: 'abort' });
}

function stop(h) {
  if (h.stopping) return;
  h.stopping = true;
  // Close stdin (Pi's clean-shutdown signal) AND SIGTERM — belt and braces;
  // whichever lands first, 'close' emits the final exit.
  try { h.child.stdin.end(); } catch { /* already gone */ }
  try { h.child.kill('SIGTERM'); } catch { /* already gone */ }
}

function onEvent(h, fn) {
  h.handler = fn;
}

// --- delivery ---------------------------------------------------------------

/** Emit one normalized event. `exit` is once-and-last; after `stop`, only
 *  the exit gets through. */
function _emit(h, evt) {
  if (h.exited) return;
  if (h.stopping && evt.type !== 'exit') return;
  if (evt.type === 'exit') h.exited = true;
  if (h.handler) h.handler(evt);
}

function _write(h, obj) {
  if (h.exited || h.stopping) return;
  try { h.child.stdin.write(JSON.stringify(obj) + '\n'); }
  catch { /* child died mid-write; 'close' handles the lifecycle */ }
}

// --- framing -----------------------------------------------------------------

// An unterminated line buffers until its \n; cap it so a misbehaving wrapper
// printing an endless blob can't balloon memory (a compliant pi record is
// far below this).
const MAX_LINE = 1 << 20;   // 1 MiB

function _onChunk(h, chunk) {
  h.buf += h.decoder.write(chunk);
  let i;
  while ((i = h.buf.indexOf('\n')) >= 0) {
    let line = h.buf.slice(0, i);
    h.buf = h.buf.slice(i + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) continue;
    _onLine(h, line);
  }
  if (h.buf.length > MAX_LINE) {
    _emit(h, { type: 'error', message: `pi: unterminated output line exceeded ${MAX_LINE} bytes — dropped` });
    h.buf = '';
  }
}

function _onLine(h, line) {
  let obj;
  try { obj = JSON.parse(line); }
  catch {
    // A stray non-JSON stdout print (shouldn't happen from a compliant pi,
    // but a wrapper script might). Surface, truncated — better than silence.
    _emit(h, { type: 'error', message: `pi: unparseable output line: ${line.slice(0, 120)}` });
    return;
  }
  for (const evt of _mapPiEvent(h, obj)) _emit(h, evt);
}

// --- Pi event → normalized vocabulary (exported for fixture unit tests) ----

function _mapPiEvent(h, obj) {
  switch (obj && obj.type) {
    case 'agent_start':
      h.running = true;
      return [{ type: 'status', state: 'thinking' }];
    case 'turn_start':
      return [{ type: 'turn-start' }];
    case 'turn_end': {
      const out = [];
      const text = _assistantText(obj.message);
      if (text) out.push({ type: 'assistant-message', text });
      _accumUsage(h, obj.message && obj.message.usage);
      out.push({ type: 'turn-end' });
      return out;
    }
    case 'message_update':
      return [];   // spinner + settle — deltas deliberately dropped (see header)
    case 'tool_execution_start': {
      const evt = {
        type: 'tool-call',
        id: String(obj.toolCallId || 'tool'),
        name: String(obj.toolName || 'tool'),
      };
      if (obj.args && typeof obj.args === 'object') evt.args = obj.args;
      return [evt];
    }
    case 'tool_execution_end':
      return [{
        type: 'tool-result',
        id: String(obj.toolCallId || 'tool'),
        result: _contentText(obj.result && obj.result.content),
        isError: !!obj.isError,
      }];
    case 'agent_settled': {
      h.running = false;
      const st = { type: 'status', state: 'idle' };
      if (h.usage.tokens > 0) st.tokens = h.usage.tokens;
      if (h.usage.cost > 0) st.cost = h.usage.cost;
      return [st, { type: 'settled' }];
    }
    case 'compaction_start':
      return [{ type: 'status', state: 'compacting' }];
    case 'compaction_end':
      // Mid-run threshold compaction resumes the turn; a manual compact at
      // rest goes back to idle. h.running knows which.
      return [{ type: 'status', state: h.running ? 'thinking' : 'idle' }];
    case 'auto_retry_start':
      return [{ type: 'status', state: 'retrying' }];
    case 'auto_retry_end':
      return obj.success
        ? [{ type: 'status', state: 'thinking' }]
        : [{ type: 'error', message: `retries exhausted: ${obj.finalError || 'unknown error'}` }];
    case 'extension_error':
      return [{ type: 'error', message: `extension ${obj.extensionPath || ''}: ${obj.error || 'error'}` }];
    case 'response':
      // Command responses: a failure must surface (a rejected prompt would
      // otherwise vanish silently); successes are ack noise.
      return obj.success === false
        ? [{ type: 'error', message: `pi ${obj.command || 'command'} failed: ${obj.error || 'unknown error'}` }]
        : [];
    case 'extension_ui_request':
      return _uiRequest(h, obj);
    default:
      // agent_end (settled is the real terminus), message_start/message_end
      // (turn_end carries the settled text), queue_update, bash_*,
      // summarization_retry_* — the coarse view doesn't need them.
      return [];
  }
}

// Dialog methods block the agent until answered; fire-and-forget ones don't.
const UI_DIALOGS = ['select', 'confirm', 'input', 'editor'];

function _uiRequest(h, obj) {
  if (UI_DIALOGS.includes(obj.method)) {
    // Only answer a correlatable request — a response without the id would be
    // dropped by pi and the dialog would hang anyway; surface regardless.
    if (obj.id != null) _write(h, { type: 'extension_ui_response', id: obj.id, cancelled: true });
    return [{ type: 'error', message: `extension dialog auto-cancelled: ${obj.title || obj.method}` }];
  }
  if (obj.method === 'notify' && obj.notifyType === 'error') {
    return [{ type: 'error', message: String(obj.message || 'extension error') }];
  }
  return [];   // notify info/warning, setStatus/setWidget/setTitle/set_editor_text
}

/** AssistantMessage.content (string | [{type:'text'|'thinking'|'toolCall'}])
 *  → the displayable text. */
function _assistantText(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter(p => p && p.type === 'text' && typeof p.text === 'string')
          .map(p => p.text).join('\n');
}

/** ToolResult content ([{type:'text', text}]) → display text. */
function _contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(p => p && p.type === 'text' && typeof p.text === 'string')
                .map(p => p.text).join('\n');
}

function _accumUsage(h, usage) {
  if (!usage) return;
  h.usage.tokens += ((usage.input | 0) + (usage.output | 0));
  const cost = usage.cost && usage.cost.total;
  if (Number.isFinite(cost)) h.usage.cost += cost;
}

module.exports = {
  name: 'pi',
  start, send, interrupt, stop, onEvent,
  _mapPiEvent, _argv,   // exported for the fixture unit tests
};
