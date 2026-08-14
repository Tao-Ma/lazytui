/**
 * agent Component model (Slice A2) — pure fold of normalized agent events
 * into the slice: transcript lines (esc'd, capped, bottom-stick), coarse
 * status, identity-preserved no-ops, and the shared text-view interaction
 * fallthrough. Drives panel/agent/agent.js#update directly (the Component
 * is not registered/minted until A4).
 * Run: node js/test/test-agent-model.js
 */
'use strict';

const { describe, it, eq, assert, report, expectNoMutation } = require('./test-runner');
const agent = require('../panel/agent/agent');

const ev = (evt) => ({ type: 'agent_event', evt });

/** Fold a sequence of events over a fresh (or given) slice. */
function fold(events, slice) {
  let s = slice || agent.init('p1', null);
  for (const e of events) s = agent.update(ev(e), s);
  return s;
}

describe('[agent model] init', () => {
  it('defaults: empty transcript, starting status, mock backend, 1000-line cap', () => {
    const s = agent.init('p1', null);
    eq(s.transcript, []);
    eq(s.status, { state: 'starting', tokens: null, cost: null, tool: null });
    eq(s.inputDraft, { text: '', cursor: 0 });
    eq(s.descriptor, { backend: 'mock', provider: null, model: null, label: null, sessionId: null });
    eq(s.cap, 1000);
    eq(s.paneId, 'p1');
  });
  it('config seeds the descriptor + cap', () => {
    const s = agent.init('p2', { paneDef: { config: {
      backend: 'pi', provider: 'openai', model: 'gpt-x', label: 'helper', sessionId: 'sess-9', cap: 50,
    } } });
    eq(s.descriptor, { backend: 'pi', provider: 'openai', model: 'gpt-x', label: 'helper', sessionId: 'sess-9' });
    eq(s.cap, 50);
  });
  it('zero-arg init works (registration singleton seed)', () => {
    const s = agent.init();
    eq(s.paneId, null);
    eq(s.descriptor.backend, 'mock');
  });
});

describe('[agent model] a full turn folds to transcript + status', () => {
  const s = fold([
    { type: 'settled' },                                                  // ready
    { type: 'turn-start' },
    { type: 'status', state: 'tool' },
    { type: 'tool-call', id: 't1', name: 'bash', args: { cmd: 'ls' } },
    { type: 'tool-result', id: 't1', result: 'a.txt\nb.txt' },
    { type: 'assistant-message', text: 'two files:\nboth small' },
    { type: 'turn-end' },
    { type: 'settled' },
  ]);
  it('transcript lines in order: tool-call, hanging result block, message', () => {
    eq(s.transcript, [
      '[dim]→ bash({"cmd":"ls"})[/]',
      '[dim]← a.txt[/]',
      '[dim]  b.txt[/]',
      'two files:',
      'both small',
    ]);
  });
  it('status lands idle after the final settled', () => {
    eq(s.status.state, 'idle');
  });
  it('turn-start flips starting → thinking; explicit status overrides', () => {
    eq(fold([{ type: 'turn-start' }]).status.state, 'thinking');
    eq(fold([{ type: 'turn-start' }, { type: 'status', state: 'compacting' }]).status.state, 'compacting');
  });
  it('the spinner (A6): tool-call sets state tool + the name; tool-result returns to thinking', () => {
    const mid = fold([
      { type: 'turn-start' },
      { type: 'tool-call', id: 't1', name: 'bash', args: {} },
    ]);
    eq([mid.status.state, mid.status.tool], ['tool', 'bash'], 'mid-tool frame names the tool');
    const after = fold([{ type: 'tool-result', id: 't1', result: 'ok' }], mid);
    eq([after.status.state, after.status.tool], ['thinking', null], 'back to thinking after the result');
  });
});

describe('[agent model] identity preserved on no-ops', () => {
  const idle = fold([{ type: 'settled' }]);
  it('a text delta updates the streaming preview, not the transcript', () => {
    const s = agent.update(ev({ type: 'assistant-delta', text: 'tok' }), idle);
    assert(s !== idle, 'streaming changed');
    eq(s.streaming, 'tok');
    eq(s.transcript, idle.transcript, 'transcript untouched');
  });
  it('a thinking delta is identity (the status line covers thinking)', () => {
    assert(agent.update(ev({ type: 'assistant-delta', thinking: 'hm' }), idle) === idle);
    assert(agent.update(ev({ type: 'assistant-delta', text: '' }), idle) === idle, 'empty text too');
  });
  it('turn-end is a no-op when nothing is streaming (state holds)', () => {
    assert(agent.update(ev({ type: 'turn-end' }), idle) === idle);
  });
  it('settled when already idle', () => {
    assert(agent.update(ev({ type: 'settled' }), idle) === idle);
  });
  it('status that changes nothing', () => {
    assert(agent.update(ev({ type: 'status', state: 'idle' }), idle) === idle);
  });
  it('unknown/missing evt', () => {
    assert(agent.update(ev({ type: 'bogus' }), idle) === idle, 'unknown type');
    assert(agent.update({ type: 'agent_event' }, idle) === idle, 'missing evt');
  });
  it('fold does not mutate its input slice', () => {
    const s = fold([{ type: 'turn-start' }]);
    expectNoMutation('agent_event assistant-message fold', () =>
      agent.update(ev({ type: 'assistant-message', text: 'hi' }), s), s);
  });
});

describe('[agent model] backend text is markup-escaped (T32 posture)', () => {
  it('assistant text with markup renders literally', () => {
    const s = fold([{ type: 'assistant-message', text: '[red]evil[/]' }]);
    eq(s.transcript, ['\\[red]evil\\[/]']);
  });
  it('tool name + args + error message escaped', () => {
    const s = fold([
      { type: 'tool-call', id: 't', name: '[bold]x', args: { a: '[dim]' } },
      { type: 'error', message: 'boom [red]' },
    ]);
    eq(s.transcript[0], '[dim]→ \\[bold]x({"a":"\\[dim]"})[/]');
    eq(s.transcript[1], '[error]✗ boom \\[red][/]');
  });
  it('long tool args truncate RAW before esc (no cut-open markup)', () => {
    const s = fold([{ type: 'tool-call', id: 't', name: 'f', args: { data: 'x'.repeat(100) } }]);
    assert(s.transcript[0].includes('…'), 'preview truncated');
    assert(s.transcript[0].length < 90, 'bounded');
  });
});

describe('[agent model] status merge keeps last-known usage counters', () => {
  it('tokens/cost persist across a status that omits them', () => {
    const s = fold([
      { type: 'status', state: 'thinking', tokens: 1200, cost: 0.05 },
      { type: 'status', state: 'tool' },
    ]);
    eq(s.status, { state: 'tool', tokens: 1200, cost: 0.05, tool: null });
  });
});

describe('[agent model] error / exit lifecycle', () => {
  it('error appends red, session stays alive', () => {
    const s = fold([{ type: 'settled' }, { type: 'error', message: 'rate limited' }]);
    eq(s.transcript, ['[error]✗ rate limited[/]']);
    eq(s.status.state, 'idle');
  });
  it('a MULTI-LINE error folds as a block — no embedded newline in any row (live-Pi regression)', () => {
    const s = fold([{ type: 'error', message: 'No API key found.\n\nUse /login. See:\n  docs.md' }]);
    eq(s.transcript, [
      '[error]✗ No API key found.[/]',
      '[error]  [/]',
      '[error]  Use /login. See:[/]',
      '[error]    docs.md[/]',
    ]);
    assert(s.transcript.every(l => !l.includes('\n')), 'every row is newline-free');
  });
  it('exit appends the end line + state exited; null code reads killed', () => {
    const s = fold([{ type: 'exit', code: 0 }]);
    eq(s.transcript, ['[warning]Session ended (exit 0).[/]']);
    eq(s.status.state, 'exited');
    eq(fold([{ type: 'exit', code: null }]).transcript, ['[warning]Session ended (killed).[/]']);
  });
});

describe('[agent model] bottom-stick scroll (text-view semantics)', () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => ({ type: 'assistant-message', text: `l${i}` }));
  it('at the bottom, the view follows the tail', () => {
    let s = { ...agent.init('p1', null), innerH: 3 };
    s = fold(lines(6), s);
    eq(s.scroll, 3, 'scroll = len - innerH');
  });
  it('scrolled up, new output accumulates without yanking down', () => {
    let s = { ...agent.init('p1', null), innerH: 3 };
    s = fold(lines(6), s);
    s = agent.update({ type: 'viewer_scroll', to: 'top' }, s);
    eq(s.scroll, 0);
    s = fold(lines(2), s);
    eq(s.scroll, 0, 'held position');
    eq(s.transcript.length, 8);
  });
});

describe('[agent model] transcript ring cap', () => {
  it('drops from the front at cap; scroll/cursor/select shift with content', () => {
    let s = { ...agent.init('p1', { paneDef: { config: { cap: 5 } } }), innerH: 2 };
    s = fold([{ type: 'assistant-message', text: 'a\nb\nc\nd' }], s);       // 4 lines
    s = agent.update({ type: 'select_begin', line: 3, col: 0 }, s);          // anchor on 'd'
    s = fold([{ type: 'assistant-message', text: 'e\nf\ng' }], s);           // 7 → cap 5, drop 2
    eq(s.transcript, ['c', 'd', 'e', 'f', 'g']);
    eq(s.select.anchor.line, 1, "anchor followed 'd' down by the 2 dropped lines");
    assert(s.cursor.line >= 0 && s.cursor.line < 5, 'cursor stays in range');
  });
  it('a single oversized append keeps only the tail', () => {
    let s = agent.init('p1', { paneDef: { config: { cap: 3 } } });
    s = fold([{ type: 'assistant-message', text: 'a\nb\nc\nd\ne' }], s);
    eq(s.transcript, ['c', 'd', 'e']);
  });
});

describe('[agent model] agent_activate (A4): idempotent start + mode flip', () => {
  it('emits agent_start with the descriptor cfg, then agent_enter', () => {
    const s = agent.init('p1', { paneDef: { config: { backend: 'mock', label: 'helper' } } });
    const [next, cmds] = agent.update({ type: 'agent_activate', selfId: 'agent-7' }, s);
    assert(next === s, 'slice untouched');
    eq(cmds, [
      { type: 'agent_start', id: 'agent-7', cfg: { backend: 'mock', provider: null, model: null, label: 'helper', sessionId: null } },
      { type: 'msg', msg: { type: 'agent_enter' } },
    ]);
  });
});

describe('[agent model] agent_input (A4): draft editing', () => {
  const inp = (s, key, seq) => agent.update({ type: 'agent_input', key, seq: seq === undefined ? key : seq, selfId: 'a1' }, s);
  it('printable ASCII inserts at the cursor; arrows/home/end move it', () => {
    let s = agent.init('p1', null);
    for (const ch of 'hlo') s = inp(s, ch);
    s = inp(s, 'left'); s = inp(s, 'left');
    s = inp(s, 'e');
    eq(s.inputDraft, { text: 'helo', cursor: 2 });
    s = inp(s, 'end'); s = inp(s, '!');
    eq(s.inputDraft.text, 'helo!');
    s = inp(s, 'home');
    eq(s.inputDraft.cursor, 0);
  });
  it('backspace/delete edit around the cursor; Ctrl+U clears', () => {
    let s = agent.init('p1', null);
    for (const ch of 'abc') s = inp(s, ch);
    s = inp(s, 'backspace', '\x7f');
    eq(s.inputDraft, { text: 'ab', cursor: 2 });
    s = inp(s, 'home'); s = inp(s, 'delete');
    eq(s.inputDraft, { text: 'b', cursor: 0 });
    s = inp(s, 'u', '\x15');
    eq(s.inputDraft, { text: '', cursor: 0 });
  });
  it('paste inserts, collapsing newlines (single-line draft)', () => {
    let s = agent.init('p1', null);
    s = inp(s, 'paste', 'two\nlines');
    eq(s.inputDraft.text, 'two lines');
  });
  it('unhandled keys are identity no-ops', () => {
    const s = agent.init('p1', null);
    assert(inp(s, 'up') === s, 'up reserved');
    assert(inp(s, 'f1', '\x1bOP') === s, 'function key');
  });
});

describe('[agent model] agent_input (A4): Enter sends, Esc interrupts-or-leaves', () => {
  const inp = (s, key, seq) => agent.update({ type: 'agent_input', key, seq: seq === undefined ? key : seq, selfId: 'a1' }, s);
  it('Enter: user line appended (markup-escaped), draft cleared, start+send Cmds', () => {
    let s = agent.init('p1', null);
    for (const ch of 'hi [x]') s = inp(s, ch);
    const r = inp(s, 'return');
    const [next, cmds] = r;
    eq(next.transcript, ['[accent]› hi \\[x][/]'], 'user line markup-escaped');
    eq(next.inputDraft, { text: '', cursor: 0 });
    eq(cmds[0].type, 'agent_start', 'self-healing idempotent start rides along');
    eq(cmds[1], { type: 'agent_send', id: 'a1', text: 'hi [x]' });
  });
  it('Enter on an empty/whitespace draft is an identity no-op', () => {
    const s = agent.init('p1', null);
    assert(inp(s, 'return') === s);
  });
  it('Esc while BUSY interrupts (stays in mode); Esc when idle leaves', () => {
    const busy = fold([{ type: 'turn-start' }]);
    const [sameB, cmdsB] = inp(busy, 'escape');
    assert(sameB === busy);
    eq(cmdsB, [{ type: 'agent_interrupt', id: 'a1' }]);
    const idle = fold([{ type: 'settled' }]);
    const [sameI, cmdsI] = inp(idle, 'escape');
    assert(sameI === idle);
    eq(cmdsI, [{ type: 'msg', msg: { type: 'agent_exit' } }]);
  });
  it('pageup/pagedown scroll the transcript while chatting', () => {
    let s = { ...agent.init('p1', null), innerH: 3 };
    s = fold(Array.from({ length: 9 }, (_, i) => ({ type: 'assistant-message', text: `l${i}` })), s);
    eq(s.scroll, 6, 'bottom-stuck');
    s = inp(s, 'pageup');
    eq(s.scroll, 3);
    s = inp(s, 'pagedown');
    eq(s.scroll, 6);
    assert(inp(s, 'pagedown') === s, 'clamped at bottom = identity');
  });
});

describe('[agent model] throttled streaming preview', () => {
  it('delta increments accumulate into streaming; assistant-message settles + clears it', () => {
    let s = fold([{ type: 'turn-start' }]);
    eq(s.streaming, '', 'turn-start clears any prior preview');
    s = fold([{ type: 'assistant-delta', text: 'Hel' },
              { type: 'assistant-delta', text: 'lo w' },
              { type: 'assistant-delta', text: 'orld' }], s);
    eq(s.streaming, 'Hello world', 'increments appended');
    eq(s.transcript, [], 'nothing in the transcript yet');
    s = fold([{ type: 'assistant-message', text: 'Hello world' }], s);
    eq(s.streaming, '', 'settled message cleared the preview');
    eq(s.transcript, ['Hello world'], 'the settled text is the authoritative transcript line');
  });
  it('turn-start / turn-end / settled / exit all clear a leftover preview', () => {
    const withStream = fold([{ type: 'assistant-delta', text: 'partial' }]);
    eq(withStream.streaming, 'partial');
    for (const closer of ['turn-start', 'turn-end', 'settled', { type: 'exit', code: 0 }]) {
      const evt = typeof closer === 'string' ? { type: closer } : closer;
      eq(fold([evt], withStream).streaming, '', `${evt.type} clears the preview`);
    }
  });
  it('a multi-line streamed preview keeps arriving until settle', () => {
    let s = fold([{ type: 'assistant-delta', text: 'line1\nli' },
                  { type: 'assistant-delta', text: 'ne2' }]);
    eq(s.streaming, 'line1\nline2');
  });
});

describe('[agent model] draft history (up/down recall)', () => {
  const inp = (s, key, seq) => agent.update({ type: 'agent_input', key, seq: seq === undefined ? key : seq, selfId: 'a1' }, s);
  function typed(s, str) { for (const ch of str) s = inp(s, ch); return s; }
  function send(s, str) { s = typed(s, str); const r = inp(s, 'return'); return Array.isArray(r) ? r[0] : r; }

  it('Enter records the sent message; consecutive duplicates are not double-pushed', () => {
    let s = agent.init('p1', null);
    s = send(s, 'one'); s = send(s, 'two'); s = send(s, 'two');
    eq(s.history, ['one', 'two'], 'deduped consecutive');
  });
  it('up walks older, holds at the oldest; down walks newer, restores the live line past newest', () => {
    let s = agent.init('p1', null);
    s = send(s, 'one'); s = send(s, 'two'); s = send(s, 'three');
    s = typed(s, 'draft-in-progress');
    s = inp(s, 'up');   eq(s.inputDraft.text, 'three', 'up → newest');
    s = inp(s, 'up');   eq(s.inputDraft.text, 'two');
    s = inp(s, 'up');   eq(s.inputDraft.text, 'one', 'oldest');
    s = inp(s, 'up');   eq(s.inputDraft.text, 'one', 'up at oldest holds');
    s = inp(s, 'down'); eq(s.inputDraft.text, 'two');
    s = inp(s, 'down'); eq(s.inputDraft.text, 'three', 'newest again');
    s = inp(s, 'down'); eq(s.inputDraft.text, 'draft-in-progress', 'down past newest restores the stashed live line');
    eq(s.histIdx, null, 'back to the live line (not browsing)');
    s = inp(s, 'down'); eq(s.inputDraft.text, 'draft-in-progress', 'down at live is a no-op');
  });
  it('up on empty history is a no-op', () => {
    const s = agent.init('p1', null);
    assert(inp(s, 'up') === s);
  });
  it('the recall cursor lands at end-of-line', () => {
    let s = send(agent.init('p1', null), 'hello');
    s = inp(s, 'up');
    eq(s.inputDraft.cursor, 5);
  });
  it('editing a recalled line edits a working copy AT that position; the stash survives', () => {
    let s = agent.init('p1', null);
    s = send(s, 'orig');
    s = typed(s, 'my draft');
    s = inp(s, 'up');                       // recall 'orig' (stashes 'my draft')
    eq(s.histIdx, 0, 'browsing');
    s = inp(s, '!');                        // edit → working copy, NOT a fork
    eq(s.inputDraft.text, 'orig!');
    eq(s.histIdx, 0, 'the edit keeps the browse cursor (readline-style)');
    s = inp(s, 'down');                     // past newest → restore the stash
    eq(s.inputDraft.text, 'my draft', 'Down restores the stashed draft after an edit');
    s = inp(s, 'up');
    eq(s.inputDraft.text, 'orig!', 'browsing back up shows the working copy, not the original');
    const r = inp(s, 'return');             // send the edited recall
    const next = Array.isArray(r) ? r[0] : r;
    eq(next.history, ['orig', 'orig!'], 'the edited line recorded as new');
  });
  it('send while browsing restores the stashed draft and spends the working copies', () => {
    let s = agent.init('p1', null);
    s = send(s, 'orig');
    s = typed(s, 'keep me');
    s = inp(s, 'up');                       // recall 'orig'
    const r = inp(s, 'return');             // resend it
    const next = Array.isArray(r) ? r[0] : r;
    eq(next.inputDraft.text, 'keep me', 'the in-progress draft came back as the live line');
    eq(next.histIdx, null, 'not browsing');
    eq(next.histStash, '', 'stash consumed');
    eq(next.histEdits, {}, 'working copies cleared');
    let t = inp(next, 'up');
    eq(t.inputDraft.text, 'orig', 'a later recall shows the ORIGINAL entry (copy was spent)');
  });
  it('a cursor-only move keeps browsing (and writes no working copy)', () => {
    let s = send(agent.init('p1', null), 'abc');
    s = inp(s, 'up');
    s = inp(s, 'left');
    eq(s.histIdx, 0, 'still browsing after a cursor move');
    eq(s.histEdits, {}, 'no working copy from a cursor move');
  });
  it('history caps oldest-first at 100', () => {
    let s = agent.init('p1', null);
    for (let i = 0; i < 105; i++) s = send(s, `m${i}`);
    eq(s.history.length, 100);
    eq(s.history[0], 'm5', 'oldest 5 dropped');
    eq(s.history[99], 'm104');
  });
});

describe('[agent model] shared text-view interaction falls through', () => {
  it('viewer_scroll moves the transcript viewport (innerH stamped via msg)', () => {
    let s = agent.init('p1', null);
    s = fold(Array.from({ length: 10 }, (_, i) => ({ type: 'assistant-message', text: `l${i}` })), s);
    s = agent.update({ type: 'viewer_scroll', to: 'top', innerH: 4 }, s);
    eq(s.scroll, 0);
    s = agent.update({ type: 'viewer_scroll', delta: 3 }, s);
    eq(s.scroll, 3);
    s = agent.update({ type: 'viewer_scroll', to: 'bottom' }, s);
    eq(s.scroll, 6, 'maxScroll = 10 - 4');
  });
  it('select_begin anchors on the transcript', () => {
    let s = fold([{ type: 'assistant-message', text: 'a\nb\nc' }]);
    s = agent.update({ type: 'select_begin', line: 1, col: 0 }, s);
    eq(s.select.active, true);
    eq(s.select.anchor, { line: 1, col: 0 });
  });
});

report();
