/**
 * Hit map (panel/hit-map) + draw.publishBox — the registry and the
 * paint-side publisher of docs/mouse-hit-map.md Release 1.
 *
 *   [1] resolve: z order, publish-order tie-break, opaque stop, fall-through
 *   [2] lifecycle: clear + stamp, malformed regions ignored, owner bracket
 *   [2b] frame stamp (incl. the R2 geometry field) + claims
 *   [2c] ambient pane bracket — publishLocal translate + clip
 *   (formatHints / chipSurvives / seqForKey live in test-hints.js)
 *   [5] publishBox: rows follow the scroll window, chips clip, screen clip
 *
 * Run: node js/test/test-hit-map.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const hm = require('../panel/hit-map');
const { formatHints } = require('../leaves/render/hints');
const draw = require('../leaves/render/draw');
const { visibleLen } = require('../leaves/text/ansi');

const R = (x, y, w, h) => ({ x, y, w, h });

describe('[1] resolve', () => {
  it('topmost containing region with a handler wins', () => {
    hm.clear('');
    hm.publish({ id: 'low',  rect: R(0, 0, 10, 10), z: 1, on: { press: { key: 'a' } } });
    hm.publish({ id: 'high', rect: R(2, 2, 3, 3),   z: 5, on: { press: { key: 'b' } } });
    eq(hm.resolve(3, 3, 'press').region.id, 'high', 'inside both → higher z');
    eq(hm.resolve(0, 0, 'press').region.id, 'low', 'outside the high one → low');
    eq(hm.resolve(20, 20, 'press'), null, 'outside everything → null');
  });
  it('equal z: the later-published region is on top (paint order)', () => {
    hm.clear('');
    hm.publish({ id: 'first',  rect: R(0, 0, 5, 5), z: 3, on: { press: 'swallow' } });
    hm.publish({ id: 'second', rect: R(0, 0, 5, 5), z: 3, on: { press: 'swallow' } });
    eq(hm.resolve(1, 1, 'press').region.id, 'second');
  });
  it('a non-opaque region without a handler for the gesture falls through', () => {
    hm.clear('');
    hm.publish({ id: 'box',  rect: R(0, 0, 10, 10), z: 1, opaque: true, on: { 'wheel-up': { key: 'up' } } });
    hm.publish({ id: 'chip', rect: R(1, 1, 3, 1),   z: 3, on: { press: { key: 'y' } } });
    eq(hm.resolve(1, 1, 'press').region.id, 'chip', 'chip handles press');
    const w = hm.resolve(1, 1, 'wheel-up');
    eq(w.region.id, 'box', 'wheel over the chip falls to the box');
    eq(w.handler, { key: 'up' });
  });
  it('an opaque region stops the walk as swallow even with no handler', () => {
    hm.clear('');
    hm.publish({ id: 'pane',     rect: R(0, 0, 20, 20), z: 1,    on: { press: { key: 'x' } } });
    hm.publish({ id: 'backdrop', rect: R(0, 0, 20, 20), z: 1000, opaque: true, on: {} });
    const r = hm.resolve(5, 5, 'press');
    eq(r.region.id, 'backdrop');
    eq(r.handler, 'swallow', 'the pane beneath is unreachable');
  });
  it('rect bounds are [x, x+w) × [y, y+h)', () => {
    hm.clear('');
    hm.publish({ id: 'r', rect: R(2, 3, 4, 2), z: 1, on: { press: 'swallow' } });
    assert(hm.resolve(2, 3, 'press'), 'top-left inside');
    assert(hm.resolve(5, 4, 'press'), 'bottom-right inside');
    eq(hm.resolve(6, 4, 'press'), null, 'x+w is outside');
    eq(hm.resolve(5, 5, 'press'), null, 'y+h is outside');
  });
});

describe('[2] lifecycle', () => {
  it('clear drops regions and records the stamp', () => {
    hm.clear('');
    hm.publish({ id: 'a', rect: R(0, 0, 1, 1), z: 1, on: { press: 'swallow' } });
    hm.clear('confirmMode');
    eq(hm.all().length, 0);
    eq(hm.frameStamp(), 'confirmMode');
    hm.clear(null);
    eq(hm.frameStamp(), null, 'null stamp = never painted');
  });
  it('malformed regions are ignored, not thrown', () => {
    hm.clear('');
    hm.publish(null);
    hm.publish({ id: 'norect' });
    hm.publish({ id: 'nan', rect: R(NaN, 0, 1, 1) });
    hm.publish({ id: 'empty', rect: R(0, 0, 0, 1) });
    eq(hm.all().length, 0);
  });
  it('publishOwned stamps owner + band z inside a bracket, drops outside', () => {
    hm.clear('');
    hm.publishOwned({ id: 'stray', rect: R(0, 0, 1, 1) }, 1);
    eq(hm.all().length, 0, 'no bracket → dropped');
    hm.enterOwner('confirm', 1100);
    hm.publishOwned({ id: 'box', rect: R(0, 0, 1, 1) }, 1);
    hm.exitOwner();
    hm.publishOwned({ id: 'after', rect: R(0, 0, 1, 1) }, 1);
    const all = hm.all();
    eq(all.length, 1);
    eq(all[0].owner, 'confirm');
    eq(all[0].z, 1101);
  });
});

describe('[2b] frame stamp + claims', () => {
  it('stampOf captures modes AND popup-state identity; stampsEqual is field-wise ===', () => {
    const modal = { menu: { items: [] } };
    const m = { modes: { menuOpen: true }, modal, prefixSeq: [] };
    const a = hm.stampOf(m, { paneMenu: null });
    assert(hm.stampsEqual(a, hm.stampOf(m, { paneMenu: null })), 'same state → equal');
    assert(!hm.stampsEqual(a, hm.stampOf({ ...m, modal: { ...modal } }, { paneMenu: null })), 'modal replaced → stale');
    assert(!hm.stampsEqual(a, hm.stampOf({ ...m, modes: {} }, { paneMenu: null })), 'mode closed → stale');
    assert(!hm.stampsEqual(null, a) && !hm.stampsEqual(a, null), 'null never equals');
  });
  it('jobs / diagLog identity counts only while their window is open', () => {
    const base = { modes: {}, modal: {}, jobs: [1] };
    assert(hm.stampsEqual(hm.stampOf(base), hm.stampOf({ ...base, jobs: [2] })), 'closed → a jobs refresh is not staleness');
    const open = { ...base, modes: { jobsMode: true } };
    assert(!hm.stampsEqual(hm.stampOf(open), hm.stampOf({ ...open, jobs: [2] })), 'open → the list shifted under the rows');
  });
  it('geom (R2): pane rects + dims stale the frame; hover / focus do not', () => {
    // paneBounds is the geometry test override (visibleBoundsMap honors it), so
    // the stamp sees exactly these rects.
    const m = { modes: {}, modal: null };
    const pb = { 'pane-a': R(0, 0, 40, 10), 'pane-b': R(0, 10, 40, 10) };
    const L = (extra) => ({ paneMenu: null, dims: { cols: 80, rows: 24 }, paneBounds: pb, ...extra });
    const a = hm.stampOf(m, L());
    assert(hm.stampsEqual(a, hm.stampOf(m, L({ hover: { paneId: 'pane-a', col: 3, row: 1 } }))), 'hover → same frame');
    assert(hm.stampsEqual(a, hm.stampOf(m, L({ focus: 'pane-b' }))), 'normal-view focus → same frame');
    const collapsed = { ...pb, 'pane-a': R(0, 0, 40, 1), 'pane-b': R(0, 1, 40, 19) };
    assert(!hm.stampsEqual(a, hm.stampOf(m, L({ paneBounds: collapsed }))), 'a pane collapsed → stale');
    const swapped = { 'pane-a': pb['pane-b'], 'pane-b': pb['pane-a'] };
    assert(!hm.stampsEqual(a, hm.stampOf(m, L({ paneBounds: swapped }))), 'same rects, panes swapped → stale');
    assert(!hm.stampsEqual(a, hm.stampOf(m, L({ dims: { cols: 81, rows: 24 } }))), 'resize → stale');
    // A slot that switched tabs shows another renderer's chrome at the same rect.
    const arr = (t) => ({ columns: [{ panels: [{ paneId: 'pane-a', activeTabId: t }, { paneId: 'pane-b' }] }] });
    const t1 = hm.stampOf(m, L({ arrange: arr('t1') }));
    assert(hm.stampsEqual(t1, hm.stampOf(m, L({ arrange: arr('t1') }))), 'same active tab → same frame');
    assert(!hm.stampsEqual(t1, hm.stampOf(m, L({ arrange: arr('t2') }))), 'active tab switched → stale');
  });
  it('claims: any published region containing the point', () => {
    hm.clear('');
    hm.publish({ id: 'b', rect: R(2, 2, 3, 3), z: 1, on: {} });
    assert(hm.claims(3, 3));
    assert(!hm.claims(0, 0));
  });
});

describe('[2c] ambient pane — publishLocal', () => {
  it('translates by the pane origin, clips to the pane, stamps owner = paneId', () => {
    hm.clear('');
    hm.publishLocal({ id: 'x', rect: R(0, 0, 3, 1), on: {} }, 40);   // no ambient pane → dropped
    eq(hm.all().length, 0, 'outside a bracket nothing publishes');
    hm.enterPane('pane-a', R(10, 5, 20, 8));
    hm.publishLocal({ id: 'glyph', rect: R(16, 0, 3, 1), on: { press: 'swallow' } }, 40);
    hm.publishLocal({ id: 'wide', rect: R(18, 2, 6, 1), on: {} }, 30);    // runs past the right edge
    hm.publishLocal({ id: 'off', rect: R(25, 0, 3, 1), on: {} }, 30);     // wholly outside → dropped
    hm.exitPane();
    hm.publishLocal({ id: 'after', rect: R(0, 0, 3, 1), on: {} }, 40);   // bracket closed → dropped
    const rs = hm.all();
    eq(rs.map(r => r.id).join(), 'glyph,wide');
    eq(JSON.stringify(rs[0].rect), JSON.stringify(R(26, 5, 3, 1)), 'pane-local → screen');
    eq(rs[0].owner, 'pane-a'); eq(rs[0].z, 40);
    eq(JSON.stringify(rs[1].rect), JSON.stringify(R(28, 7, 2, 1)), 'clipped at the pane edge');
  });
});

describe('[5] publishBox', () => {
  const captured = [];
  draw.setHitSink((r, zOff) => captured.push({ ...r, zOff }));
  draw.setDimsProvider(() => ({ cols: 40, rows: 12 }));

  it('publishes the opaque box, then targets for VISIBLE lines only', () => {
    captured.length = 0;
    const lines = ['a', 'b', 'c', 'd', 'e'];
    const lineTargets = lines.map((_, i) => ({ press: { msg: { type: 't', i } } }));
    // h=4 → 2 inner rows; scrollOffset 2 → lines c, d visible.
    draw.publishBox({ x: 5, y: 2, w: 10, h: 4, scrollOffset: 2, lines, lineTargets });
    eq(captured[0].id, 'box');
    assert(captured[0].opaque, 'box is opaque');
    eq(captured[0].zOff, draw.HIT_Z.box);
    const rows = captured.filter(r => r.id.startsWith('row:'));
    eq(rows.map(r => r.id), ['row:2', 'row:3']);
    eq(rows[0].rect, { x: 6, y: 3, w: 8, h: 1 }, 'inside the borders, first inner row');
    eq(rows[0].zOff, draw.HIT_Z.row);
  });
  it('a chip publishes a press→key region only when it survives truncation', () => {
    captured.length = 0;
    const hint = formatHints([{ cap: 'y', label: 'confirm', key: 'y' }, { cap: 'n', label: 'cancel', key: 'n' }]);
    // innerW = 18: the 24-wide hint truncates; only [y] confirm survives.
    draw.publishBox({ x: 0, y: 0, w: 20, h: 3, lines: [hint.markup], lineChips: { 0: hint.chips } });
    const chips = captured.filter(r => r.id.startsWith('chip:'));
    eq(chips.map(c => c.id), ['chip:y']);
    eq(chips[0].rect, { x: 1, y: 1, w: 11, h: 1 });
    eq(chips[0].on, { press: { key: 'y', seq: 'y' } });
    eq(chips[0].zOff, draw.HIT_Z.chip);
  });
  it('regions are clipped to the viewport; an off-screen box publishes nothing', () => {
    captured.length = 0;
    draw.publishBox({ x: 35, y: 0, w: 10, h: 3, lines: ['q'], lineTargets: [{ press: 'swallow' }] });
    eq(captured[0].rect, { x: 35, y: 0, w: 5, h: 3 }, 'box clipped at the right edge (cols=40)');
    eq(captured[1].rect, { x: 36, y: 1, w: 4, h: 1 }, 'row clipped too');
    captured.length = 0;
    draw.publishBox({ x: 50, y: 0, w: 5, h: 3, lines: ['q'] });
    eq(captured.length, 0);
  });
  it('no sink wired → no-op (CLI / tests without paint)', () => {
    draw.setHitSink(null);
    draw.publishBox({ x: 0, y: 0, w: 5, h: 3, lines: ['q'] });   // must not throw
    assert(true);
  });
});

report();
