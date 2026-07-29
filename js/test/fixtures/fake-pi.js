/**
 * fake-pi — a protocol-compliant stand-in for `pi --mode rpc`, so the Pi
 * backend (js/agent/backends/pi.js) can be driven END TO END through a real
 * subprocess without Pi installed (docs/live-agent.md A5: only LIVE
 * validation needs the real thing). Speaks the JSONL wire shapes from the
 * pi repo's packages/coding-agent/docs/rpc.md.
 *
 * Scripted behaviors, keyed on the prompt text:
 *   (default)   — full echo run: agent_start, turn_start, 2 text deltas
 *                 (must be DROPPED by the adapter), tool_execution_start/end,
 *                 turn_end (message text `pi-echo: <msg>` + usage), agent_settled.
 *   'framing'   — same settle, but the turn_end line is written in TWO
 *                 chunks (partial-line buffer), a line arrives with \r\n,
 *                 and the text contains a literal U+2028 (the readline trap).
 *   'dialog'    — emits an extension_ui_request confirm; settles ONLY when
 *                 the auto-cancel extension_ui_response comes back.
 *   'badcmd'    — emits a failed command response.
 *   'hang'      — agent_start + turn_start, then nothing until `abort`
 *                 arrives (→ turn_end with no text + agent_settled).
 *   'die'       — exits(1) immediately (a crashing pi; drives the stdin-EPIPE
 *                 regression when a large write chases it into the pipe).
 *   'mbsplit'   — writes a turn_end record as a BUFFER split INSIDE a
 *                 multi-byte UTF-8 codepoint (the StringDecoder claim).
 *
 * Exits 0 when stdin closes (Pi's clean-shutdown convention).
 */
'use strict';

let buf = '';
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function run(message) {
  out({ type: 'agent_start' });
  out({ type: 'turn_start' });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'pi-' } });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'echo' } });
  out({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'true' } });
  out({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash',
        result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
  out({ type: 'turn_end',
        message: { role: 'assistant',
                   content: [{ type: 'text', text: `pi-echo: ${message}` },
                             { type: 'thinking', thinking: 'not display text' }],
                   usage: { input: 10, output: 5, cost: { total: 0.01 } } },
        toolResults: [] });
  out({ type: 'agent_settled' });
}

function runFraming() {
  out({ type: 'agent_start' });
  // \r\n-terminated line: the adapter must strip the \r.
  process.stdout.write(JSON.stringify({ type: 'turn_start' }) + '\r\n');
  // One JSON record split across two writes (partial-line buffering), whose
  // text carries a literal U+2028 — a generic line reader would split there
  // and corrupt the record.
  const line = JSON.stringify({
    type: 'turn_end',
    message: { role: 'assistant',
               content: [{ type: 'text', text: 'line one\u2028still line one' }],
               usage: { input: 1, output: 1, cost: { total: 0.001 } } },
  }) + '\n';
  process.stdout.write(line.slice(0, 25));
  setTimeout(() => {
    process.stdout.write(line.slice(25));
    out({ type: 'agent_settled' });
  }, 10);
}

function onCommand(cmd) {
  switch (cmd.type) {
    case 'prompt': {
      const m = String(cmd.message || '');
      if (m === 'framing') return runFraming();
      if (m === 'dialog') {
        return out({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm',
                     title: 'Allow dangerous command?', message: 'sure?', timeout: 5000 });
      }
      if (m === 'badcmd') {
        return out({ type: 'response', command: 'prompt', success: false, error: 'model not configured' });
      }
      if (m === 'hang') {
        out({ type: 'agent_start' });
        out({ type: 'turn_start' });
        return;   // ...until abort
      }
      if (m === 'die') process.exit(1);
      if (m === 'mbsplit') {
        out({ type: 'agent_start' });
        const line = Buffer.from(JSON.stringify({
          type: 'turn_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'héllo 多字节 done' }] },
        }) + '\n', 'utf8');
        // Split one byte INTO the 3-byte 多 — a string-level split can't
        // produce this; only the decoder path survives it.
        const cut = line.indexOf(Buffer.from('多', 'utf8')) + 1;
        process.stdout.write(line.subarray(0, cut));
        setTimeout(() => {
          process.stdout.write(line.subarray(cut));
          out({ type: 'agent_settled' });
        }, 10);
        return;
      }
      return run(m);
    }
    case 'abort':
      out({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] });
      out({ type: 'agent_settled' });
      return;
    case 'extension_ui_response':
      // The dialog script settles once the (auto-cancel) answer arrives —
      // observable proof the backend wrote the response.
      if (cmd.id === 'ui-1' && cmd.cancelled === true) out({ type: 'agent_settled' });
      return;
    case 'switch_session':
      out({ type: 'response', command: 'switch_session', success: true });
      return;
    default:
      return;   // acks not needed for the scripted runs
  }
}

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, '');
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { onCommand(JSON.parse(line)); } catch { /* ignore garbage */ }
  }
});
process.stdin.on('end', () => process.exit(0));
