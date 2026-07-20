/**
 * U2c P0 — the shared text-view interaction reducer (leaves/text/text-view-update).
 * See docs/one-tab-system.md. Run: node js/test/test-text-view-update.js
 *
 * Pure unit tests: scroll (viewport-based clamp), the ownKind focus gate, the key
 * state machine (reading scroll vs visual cursor, v toggle, y → register_push),
 * select begin/extend, search enter (mode_set effect), and the null pass-through
 * for unowned Msgs. The viewer's byte-identical behaviour behind this reducer is
 * covered by the viewer suite; here we pin the extracted surface directly.
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const tvu = require('../leaves/text/text-view-update');

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i}`);
function base(over) {
  return Object.assign({
    scroll: 0, innerH: 5,
    search: { active: false, term: '', idx: 0, typing: '' },
    select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
    cursor: { line: 0, col: 0 },
  }, over || {});
}
// Normalize a `nextSlice | [nextSlice, effects]` return to { slice, fx }.
function norm(r) { return Array.isArray(r) ? { slice: r[0], fx: r[1] || [] } : { slice: r, fx: [] }; }
const claimed = (fx) => fx.some(e => e && e.type === '_claimed');

describe('[tvu] scroll — viewport-based clamp (maxScroll = lines - innerH)', () => {
  it('delta scrolls within [0, maxScroll]', () => {
    eq(norm(tvu.reduce({ type: 'viewer_scroll', delta: 3 }, base(), LINES, 'text-view')).slice.scroll, 3, 'delta +3');
    eq(norm(tvu.reduce({ type: 'viewer_scroll', to: 'bottom' }, base(), LINES, 'text-view')).slice.scroll, 15, 'bottom = 20-5');
    eq(norm(tvu.reduce({ type: 'viewer_scroll', to: 'top' }, base({ scroll: 9 }), LINES, 'text-view')).slice.scroll, 0, 'top = 0');
    eq(norm(tvu.reduce({ type: 'viewer_scroll', delta: 99 }, base({ scroll: 14 }), LINES, 'text-view')).slice.scroll, 15, 'clamps at max');
  });
  it('a buffer shorter than the viewport cannot scroll (ref-identity preserved)', () => {
    const s = base({ innerH: 25 });
    const r = tvu.reduce({ type: 'viewer_scroll', delta: 1 }, s, LINES, 'text-view');
    assert(r === s, 'no-op returns the same slice ref (maxScroll 0)');
  });
});

describe('[tvu] key — ownKind gate', () => {
  it('a key whose focusKind !== ownKind is ignored (no claim, no scroll)', () => {
    const s = base();
    const r = tvu.reduce({ type: 'key', key: 'j', focusKind: 'detail' }, s, LINES, 'text-view');
    assert(r === s, 'gate returns the input slice ref unchanged');
  });
  it('terminalMode suppresses the key arm', () => {
    const s = base();
    const r = tvu.reduce({ type: 'key', key: 'j', focusKind: 'text-view', terminalMode: true }, s, LINES, 'text-view');
    assert(r === s, 'terminalMode → slice unchanged');
  });
});

describe('[tvu] key — reading vs visual', () => {
  it('j/k scroll in reading mode + claim', () => {
    const down = norm(tvu.reduce({ type: 'key', key: 'j', focusKind: 'text-view' }, base(), LINES, 'text-view'));
    eq(down.slice.scroll, 1, 'j → scroll +1');
    assert(claimed(down.fx), 'j is claimed');
    const up = norm(tvu.reduce({ type: 'key', key: 'k', focusKind: 'text-view' }, base({ scroll: 3 }), LINES, 'text-view'));
    eq(up.slice.scroll, 2, 'k → scroll -1');
  });
  it('v enters char visual; j then moves the cursor (not scroll)', () => {
    const v = norm(tvu.reduce({ type: 'key', seq: 'v', focusKind: 'text-view' }, base(), LINES, 'text-view'));
    assert(v.slice.select.active && v.slice.select.kind === 'char', 'v → char visual active');
    assert(claimed(v.fx), 'v is claimed');
    const j = norm(tvu.reduce({ type: 'key', key: 'j', focusKind: 'text-view' }, v.slice, LINES, 'text-view'));
    eq(j.slice.cursor.line, 1, 'in visual, j moves the cursor down');
    assert(j.slice.select.active, 'selection stays active (extends)');
  });
  it('y commits the selection → register_push + clears active', () => {
    const sel = base({ select: { active: true, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 3 } } });
    const y = norm(tvu.reduce({ type: 'key', seq: 'y', focusKind: 'text-view' }, sel, LINES, 'text-view'));
    assert(!y.slice.select.active, 'y clears the active selection');
    const push = y.fx.find(e => e && e.type === 'msg' && e.msg && e.msg.type === 'register_push');
    assert(push && typeof push.msg.text === 'string' && push.msg.text.length > 0, 'y emits a register_push with text');
  });
});

describe('[tvu] select_* + search + pass-through', () => {
  it('select_begin / select_extend drive the selection', () => {
    const b = norm(tvu.reduce({ type: 'select_begin', line: 2, col: 1, kind: 'char' }, base(), LINES, 'text-view'));
    assert(b.slice.select.active && b.slice.select.anchor.line === 2, 'select_begin anchors');
    const e = norm(tvu.reduce({ type: 'select_extend', line: 5, col: 4 }, b.slice, LINES, 'text-view'));
    eq(e.slice.select.cursor.line, 5, 'select_extend moves the cursor');
    eq(e.slice.select.anchor.line, 2, 'anchor stays put');
  });
  it('viewer_search_enter arms detailSearchMode', () => {
    const r = norm(tvu.reduce({ type: 'viewer_search_enter' }, base(), LINES, 'text-view'));
    const setMode = r.fx.find(e => e && e.type === 'msg' && e.msg && e.msg.type === 'mode_set' && e.msg.flag === 'detailSearchMode');
    assert(setMode, 'search enter emits mode_set detailSearchMode');
  });
  it('an unowned Msg returns null (caller falls through)', () => {
    eq(tvu.reduce({ type: 'viewer_append', line: 'x' }, base(), LINES, 'text-view'), null, 'viewer_append → null');
  });
});

report();
