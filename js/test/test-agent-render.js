/**
 * agent pane render (review sweep) — the status line variants (incl. the A6
 * tool spinner + usage extras), the input row (ghost / typed / reverse-cell
 * cursor / the cursor-window for drafts wider than the pane), and the
 * degenerate-height front-truncation that keeps status+input alive.
 * Drives panelTypes.agent.render directly (pure f(slice) + the sanctioned
 * modes.agentMode read).
 * Run: node js/test/test-agent-render.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const agent = require('../panel/agent/agent');
const { stripMarkup } = require('../leaves/text/ansi');
const { getModel } = require('../app/runtime');

const render = agent.panelTypes.agent.render;
const PANEL = { title: 'agent', hotkey: null };

function fold(events, slice) {
  let s = slice || agent.init('p1', null);
  for (const e of events) s = agent.update({ type: 'agent_event', evt: e }, s);
  return s;
}
function draw(slice, { w = 40, h = 12, focused = true, typing = false } = {}) {
  getModel().modes.agentMode = !!typing;
  try { return render(PANEL, w, h, slice, { focused }); }
  finally { getModel().modes.agentMode = false; }
}
const plain = (out) => stripMarkup(String(out));

describe('[agent render] status line variants', () => {
  it('pre-start + ghost', () => {
    const out = plain(draw(agent.init('p1', null)));
    assert(out.includes('· not started'), 'starting status');
    assert(out.includes('› Enter to chat'), 'draft ghost');
  });
  it('the tool spinner names the tool (A6)', () => {
    const s = fold([{ type: 'turn-start' },
                    { type: 'tool-call', id: 't', name: 'bash', args: {} }]);
    assert(plain(draw(s)).includes('· tool: bash…'));
  });
  it('idle carries usage extras', () => {
    const s = fold([{ type: 'status', state: 'idle', tokens: 1500, cost: 0.05 }]);
    assert(plain(draw(s)).includes('· idle · 1500 tok · $0.05'));
  });
  it('exited + a fallback tool state without a name', () => {
    assert(plain(draw(fold([{ type: 'exit', code: 0 }]))).includes('· session ended'));
    assert(plain(draw(fold([{ type: 'status', state: 'tool' }]))).includes('· running tool…'));
  });
});

describe('[agent render] input row', () => {
  it('typing: the cursor renders as a reverse cell mid-string', () => {
    let s = agent.init('p1', null);
    s = { ...s, inputDraft: { text: 'hi', cursor: 1 } };
    const out = String(draw(s, { typing: true }));
    assert(out.includes('[reverse]i[/]'), 'cursor cell on the i');
  });
  it('a draft wider than the pane windows around the cursor (never blind)', () => {
    const long = 'abcdefghij'.repeat(10);   // 100 chars
    let s = agent.init('p1', null);
    s = { ...s, inputDraft: { text: long, cursor: 100 } };
    const out = String(draw(s, { w: 24, typing: true }));
    assert(out.includes('[reverse] [/]'), 'end-of-text cursor cell visible');
    assert(out.includes('…'), 'left-truncation marker');
    assert(plain(out).includes('fghij'), 'the tail of the draft is what shows');
    // And the head-anchored case: cursor at 0 shows the head, no marker.
    const out2 = String(draw({ ...s, inputDraft: { text: long, cursor: 0 } }, { w: 24, typing: true }));
    assert(out2.includes('[reverse]a[/]'), 'cursor on the first char');
    assert(plain(out2).includes('abcdefghij'), 'head visible');
  });
  it('not typing: full (leaf-truncated) text, no cursor cell', () => {
    let s = agent.init('p1', null);
    s = { ...s, inputDraft: { text: 'draft here', cursor: 2 } };
    const out = String(draw(s, { typing: false }));
    assert(plain(out).includes('› draft here'));
    assert(!out.includes('[reverse]'), 'no cursor when not in agent mode');
  });
});

describe('[agent render] degenerate heights keep status + input (front-truncate)', () => {
  const s = fold([{ type: 'settled' },
                  { type: 'assistant-message', text: 'l1\nl2\nl3' }]);
  it('h=4: both reserved rows survive, transcript gives way', () => {
    const out = plain(draw(s, { h: 4 }));
    assert(out.includes('· idle'), 'status row survives');
    assert(out.includes('›'), 'input row survives');
  });
  it('h=3: the input row (last) survives', () => {
    assert(plain(draw(s, { h: 3 })).includes('›'));
  });
  it('h=12: transcript + both rows, tail visible', () => {
    const out = plain(draw(s, { h: 12 }));
    assert(out.includes('l3') && out.includes('· idle') && out.includes('›'));
  });
});

report();
