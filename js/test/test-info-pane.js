/**
 * U2e P0 — the viewer's "Info" tab as a first-class `info` pane type. See
 * docs/one-tab-system.md + /root/.claude/plans/u2e-viewer-dissolution.md.
 * Run: node js/test/test-info-pane.js
 *
 * P0 ships the Component proven-by-test, NOT placed — nothing mints an `info`
 * instance yet (the detail slot is still the legacy `'detail'` viewer). These
 * tests exercise the Component's `init`/`update`/`render` directly: the
 * `info_show_content` content-injection arm (replace + scroll-reset + match-cursor
 * reset + ref-stability), interaction delegation to the shared tvu reducer, and a
 * render that paints the injected content. P1 (the pivot) seeds the slot with an
 * `info` tab and routes dispatch.showSelectedInfo here.
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const info = require('../panel/info/info');

// The test-runner auto-registers only layout/detail/groups; register `info` so
// the "registered" assertion below + any getComponent lookups resolve (mirrors
// test-terminal-pane's manual registration of the pane types it mints).
const api = sm.api;
if (!api.getComponent('info')) api.registerComponent(require('../panel/info/info'));

describe('[info P0] init', () => {
  it('produces the expected slice shape', () => {
    const s = info.init('pane-x');
    eq(s.paneId, 'pane-x', 'paneId threaded');
    eq(Array.isArray(s.lines) && s.lines.length, 0, 'empty lines');
    eq(s.scroll, 0, 'scroll 0');
    eq(s.innerH, 0, 'innerH 0 pre-dispatch');
    eq(s.search.active, false, 'search inactive');
    eq(s.select.active, false, 'select inactive');
    eq(s.cursor.line, 0, 'cursor at origin');
  });
  it('seeds lines from seed.paneDef.config.lines', () => {
    const s = info.init('pane-x', { paneDef: { config: { lines: ['a', 'b'] } } });
    eq(s.lines.join(','), 'a,b', 'seeded lines');
  });
});

describe('[info P0] info_show_content', () => {
  it('stores lines + resets scroll on content change', () => {
    let s = info.init('pane-x');
    s = { ...s, scroll: 5 };
    const next = info.update({ type: 'info_show_content', lines: ['x', 'y', 'z'] }, s);
    eq(next.lines.join(','), 'x,y,z', 'lines replaced');
    eq(next.scroll, 0, 'scroll reset to top');
  });
  it('is a true no-op when content unchanged AND scroll 0 (ref-stable slice)', () => {
    let s = info.init('pane-x');
    s = info.update({ type: 'info_show_content', lines: ['x', 'y'] }, s);  // scroll 0, lines set
    const again = info.update({ type: 'info_show_content', lines: ['x', 'y'] }, s);
    assert(again === s, 'same slice ref returned (no-op)');
  });
  it('keeps the lines ref stable across content-equal payloads', () => {
    let s = info.init('pane-x');
    s = info.update({ type: 'info_show_content', lines: ['x'] }, s);
    const prevLines = s.lines;
    s = { ...s, scroll: 3 };  // force past the no-op guard
    const next = info.update({ type: 'info_show_content', lines: ['x'] }, s);
    assert(next.lines === prevLines, 'content-equal payload reuses the prior lines ref');
    eq(next.scroll, 0, 'scroll still reset');
  });
  it('resets the match cursor (search.idx) on real content change, keeps term', () => {
    let s = info.init('pane-x');
    s = { ...s, search: { active: true, term: 'foo', idx: 3, typing: '' }, lines: ['old'] };
    const next = info.update({ type: 'info_show_content', lines: ['new1', 'new2'] }, s);
    eq(next.search.idx, 0, 'match cursor reset');
    eq(next.search.term, 'foo', 'search term kept (recall via /[Up])');
  });
  it('ignores a non-array payload (legacy/test caller)', () => {
    const s = info.init('pane-x');
    const next = info.update({ type: 'info_show_content', lines: null }, s);
    assert(next === s, 'unchanged');
  });
});

describe('[info P0] interaction delegates to the shared tvu reducer', () => {
  it('viewer_scroll clamps to (lines - innerH)', () => {
    let s = info.init('pane-x');
    s = { ...s, lines: Array.from({ length: 20 }, (_, i) => `L${i}`), innerH: 5 };
    const bottom = info.update({ type: 'viewer_scroll', to: 'bottom' }, s);
    eq(bottom.scroll, 15, 'bottom = 20 lines - 5 innerH');
    const top = info.update({ type: 'viewer_scroll', to: 'top' }, bottom);
    eq(top.scroll, 0, 'top = 0');
  });
  it('a stamped msg.innerH projects onto the slice', () => {
    const s = info.init('pane-x');
    const next = info.update({ type: 'viewer_scroll', delta: 0, innerH: 8 }, s);
    eq(next.innerH, 8, 'stamped innerH projected onto the slice');
  });
  it('an unowned msg returns the slice unchanged', () => {
    const s = info.init('pane-x');
    const next = info.update({ type: 'totally_unrelated_msg' }, s);
    assert(next === s, 'unchanged');
  });
});

describe('[info P0] render', () => {
  it('paints the injected content without throwing', () => {
    sm.bootFresh();
    let s = info.init('pane-x');
    s = info.update({ type: 'info_show_content', lines: ['HELLOINFOMARKER'] }, s);
    const out = info.panelTypes.info.render({ title: 'Info', hotkey: '' }, 40, 10, s, { focused: true });
    const text = Array.isArray(out) ? out.join('\n') : String(out);
    assert(text.length > 0, 'render returns non-empty output');
    assert(text.includes('HELLOINFOMARKER'), 'injected content line present in output');
  });
});

describe('[info P0] registered in the builtin set', () => {
  it('info is a BUILTIN_COMPONENT (live boot + replay both pick it up)', () => {
    const { BUILTIN_COMPONENTS } = require('../app/components');
    assert(BUILTIN_COMPONENTS.some(c => c.name === 'info'), 'info in BUILTIN_COMPONENTS');
  });
  it('info resolves as a registered Component', () => {
    assert(!!api.getComponent('info'), 'info registered');
  });
});

report();
