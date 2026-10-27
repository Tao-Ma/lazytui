/**
 * Brief 2 (v0.6.43) — type-to-filter in the choices popover.
 *
 * Covers the four surfaces that need to agree:
 *   - Leaf (`js/leaves/ports/choices-filter.js`): case-insensitive
 *     substring match against value AND label, order-preserving.
 *   - Reducer (`fabric_form_choices_filter` / `_filter_clear` /
 *     `_choices_open` / `_choices_nav` / `_choices_resolved`):
 *     picking.filter append / backspace / clear-on-open; idx resets to 0
 *     on filter change; nav clamp uses filtered length; resolved clamp
 *     uses filtered length.
 *   - Dispatch (`js/dispatch/control/dispatch.js` fabricFormMode): printable
 *     keys route to filter; Esc two-step (clear filter first, then close);
 *     Enter picks the FILTERED value at idx (not the raw-list value);
 *     Space still closes; Tab/Shift-Tab still close+fall-through.
 *   - Overlay (`renderFabricFormOverlay`): paints `/<filter>` row above
 *     the choices list; paints "no match" row when the filter kills all
 *     candidates; help line swaps to "clear filter" when the filter is
 *     non-empty.
 *
 * Also exercises all three channels (fn / cmd / literal) via the leaf
 * so the filter cannot regress on one of them.
 *
 * Run: node js/test/test-form-choices-filter.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const store = require('../model/store');
const { _dispatchToken } = require('../dispatch/control/input');
const { filterChoices } = require('../leaves/ports/choices-filter');
const { freshOverlayModel, captureOverlay } = require('./_helpers/overlay-capture');
const { renderFabricFormOverlay } = require('../overlay/fabric-form');

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';
  m.register = { history: [], cap: 10 };
  return m;
}

const ACTION_FN = {
  label: 'Edit section', type: 'run', script: 'edit "$file" "$section"',
  ports: { in: {
    file:    { type: 'path',   required: true },
    section: { type: 'string', required: true, choices_fn: 'edit.sections_of', depends_on: ['file'] },
  } },
};

function fields_fn() {
  return [
    { port: 'file',    text: '/tmp/x.md', required: true, default: null },
    { port: 'section', text: '',          required: true, default: null,
      choicesFnRef: 'edit.sections_of', dependsOn: ['file'] },
  ];
}

// Boot a model, open the form, focus `section`, seed computed with `items`
// as if the fetch resolved. Returns the model; store.setModel so dispatch
// reads the right one.
function openWithItems(items, labels) {
  let m = freshModel();
  [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fields_fn(),
    pendingAction: { actionKey: 'edit-section', action: ACTION_FN } });
  [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
  [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 1 });
  [m] = runtime.update(m, { type: 'fabric_form_choices_resolved', port: 'section',
    requestId: 1, items, labels: labels || null, error: null });
  store.setModel(m);
  return m;
}

// ---- [1] shared leaf -------------------------------------------------

describe('[choices-filter] shared leaf — substring, case-insensitive, value∪label', () => {
  it('empty filter is identity', () => {
    const r = filterChoices(['a', 'b'], null, '');
    eq(r.items.join(','), 'a,b', 'items pass through');
    eq(r.labels, null, 'null labels passthrough');
  });
  it('substring match against value', () => {
    const r = filterChoices(['alpha', 'beta', 'bravo'], null, 'br');
    eq(r.items.join(','), 'bravo', 'only bravo matches "br"');
  });
  it('case-insensitive', () => {
    const r = filterChoices(['Alpha', 'Beta'], null, 'AL');
    eq(r.items.join(','), 'Alpha', 'uppercase needle matches title-case haystack');
  });
  it('matches on LABEL when values do not', () => {
    const r = filterChoices(['v1', 'v2', 'v3'], ['Alpha', 'Beta', 'Gamma'], 'bet');
    eq(r.items.join(','), 'v2', 'value picked by label match');
    eq(r.labels.join(','), 'Beta', 'labels filtered in lockstep');
  });
  it('order preserved', () => {
    const r = filterChoices(['zed', 'bravo', 'alpha', 'brass'], null, 'br');
    eq(r.items.join(','), 'bravo,brass', 'declaration order kept');
  });
});

// ---- [2] reducer arms -------------------------------------------------

describe('[form-filter] reducer — picking.filter append / backspace / clear-on-open / idx reset', () => {
  it('fabric_form_choices_open seeds filter: "" (reset on every open)', () => {
    let m = openWithItems(['intro', 'body', 'outro']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    eq(m.modal.fabricForm.picking.filter, '', 'filter seeded empty');
    eq(m.modal.fabricForm.picking.idx, 0, 'idx seeded 0');
  });
  it('_filter appends; backspace pops; idx resets to 0 on each change', () => {
    let m = openWithItems(['intro', 'body', 'outro']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    // walk highlight down first → idx 2
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });
    eq(m.modal.fabricForm.picking.idx, 2, 'at idx 2');
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: 'b' });
    eq(m.modal.fabricForm.picking.filter, 'b', 'filter has "b"');
    eq(m.modal.fabricForm.picking.idx, 0, 'idx reset on filter change');
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: 'o' });
    eq(m.modal.fabricForm.picking.filter, 'bo', 'two-char filter');
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: '\x7f' });
    eq(m.modal.fabricForm.picking.filter, 'b', 'backspace popped last char');
  });
  it('backspace on empty filter is a no-op', () => {
    let m = openWithItems(['intro']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    const [after] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: '\x7f' });
    eq(after, m, 'identity-preserving no-op (same ref)');
  });
  it('multi-char seq (paste) is clamped POST-concat at MAX_FILTER_LEN=128 — pre-release fix', () => {
    // The pre-check `cur.length >= MAX` was bypassable by a long multi-char
    // seq (dispatch.js's printable branch forwards paste bytes as one Msg):
    // cur=127 + "aaaa…" (100 chars) → next=227. Clamp POST-concat fixes it.
    let m = openWithItems(['x']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    // Prime to length 127 with one printable at a time.
    for (let i = 0; i < 127; i++) {
      [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: 'a' });
    }
    eq(m.modal.fabricForm.picking.filter.length, 127, 'primed to 127');
    // Paste 100 chars — pre-fix this would land at 227; post-fix clamps to 128.
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: 'z'.repeat(100) });
    eq(m.modal.fabricForm.picking.filter.length, 128, 'clamped POST-concat');
    assert(m.modal.fabricForm.picking.filter.endsWith('z'),
      'the one `z` that fit landed at the tail');
  });
  it('paste cap landing on a HIGH surrogate steps back one unit (no lone surrogate)', () => {
    let m = openWithItems(['x']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    // Prime to length 127.
    for (let i = 0; i < 127; i++) {
      [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: 'a' });
    }
    // Paste two emoji (surrogate pairs, 2 UTF-16 units each). Cap at 128
    // would otherwise cut between HIGH + LOW of the first emoji, leaving a
    // lone high surrogate at the tail.
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: '\u{1F600}\u{1F600}' });
    const filter = m.modal.fabricForm.picking.filter;
    assert(filter.length <= 128, `within cap, got ${filter.length}`);
    const last = filter.charCodeAt(filter.length - 1);
    assert(!(last >= 0xD800 && last <= 0xDBFF),
      `tail must not be a lone HIGH surrogate (got 0x${last.toString(16)})`);
  });
  it('control chars (Tab, Enter, Esc byte) are no-ops on the filter arm', () => {
    let m = openWithItems(['intro']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    const [a] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: '\t' });
    const [b] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: '\r' });
    const [c] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: '\x1b' });
    eq(a.modal.fabricForm.picking.filter, '', 'tab byte ignored');
    eq(b.modal.fabricForm.picking.filter, '', 'return byte ignored');
    eq(c.modal.fabricForm.picking.filter, '', 'escape byte ignored');
  });
  it('_filter_clear resets filter to "" and idx to 0', () => {
    let m = openWithItems(['intro', 'bravo']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: 'b' });
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter_clear' });
    eq(m.modal.fabricForm.picking.filter, '', 'cleared');
    eq(m.modal.fabricForm.picking.idx, 0, 'idx reset');
  });
  it('_filter_clear on empty filter is a no-op', () => {
    let m = openWithItems(['intro']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    const [after] = runtime.update(m, { type: 'fabric_form_choices_filter_clear' });
    eq(after, m, 'identity-preserving no-op');
  });
  it('nav clamps to the FILTERED length (narrowed list)', () => {
    let m = openWithItems(['alpha', 'beta', 'bravo', 'charlie']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: 'b' });   // beta,bravo
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });        // 0→1
    eq(m.modal.fabricForm.picking.idx, 1, 'advanced to second filtered row');
    const [stay] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });
    eq(stay.modal.fabricForm.picking.idx, 1, 'clamp holds at filtered-length-1 (no wrap)');
  });
  it('resolved-reply clamp uses filtered length (mid-filter refresh)', () => {
    let m = openWithItems(['alpha', 'bravo', 'charlie']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: 'c' });   // charlie
    // move idx to position 0 (only one filtered row)
    eq(m.modal.fabricForm.picking.idx, 0, 'single-filtered-row idx stays 0');
    // Fresh resolve lands with items whose filter view is empty.
    [m] = runtime.update(m, { type: 'fabric_form_choices_resolved', port: 'section',
      requestId: 2, items: ['xray', 'yankee'], labels: null, error: null });
    eq(m.modal.fabricForm.picking.idx, 0, 'empty filtered view → idx clamped to 0');
  });
});

// ---- [3] dispatch (end-to-end key path) ------------------------------

describe('[form-filter] dispatch — printable→filter, Esc two-step, Enter picks filtered value', () => {
  it('printable keystrokes append to picking.filter (popover stays open)', () => {
    openWithItems(['alpha', 'beta', 'bravo', 'brass']);
    _dispatchToken(' ');                        // open
    _dispatchToken('b');                        // append 'b'
    _dispatchToken('r');                        // append 'r'
    const p = store.getModel().modal.fabricForm.picking;
    assert(p, 'popover still open');
    eq(p.filter, 'br', 'two-char filter typed');
  });
  it('Backspace pops the filter (not treated as fall-through)', () => {
    openWithItems(['a', 'b']);
    _dispatchToken(' ');
    _dispatchToken('x');                        // 'x'
    _dispatchToken('y');                        // 'xy'
    _dispatchToken('\x7f');                     // backspace
    eq(store.getModel().modal.fabricForm.picking.filter, 'x', 'popped last char');
  });
  it('Enter picks the FILTERED value at idx (not the raw-list value)', () => {
    openWithItems(['alpha', 'beta', 'bravo', 'brass']);
    _dispatchToken(' ');
    _dispatchToken('b');                        // beta,bravo,brass
    _dispatchToken('\x1b[B');                   // Down → filtered idx 1
    _dispatchToken('\r');                       // Enter → pick 'bravo'
    const after = store.getModel().modal.fabricForm;
    eq(after.picking, null, 'popover closed on pick');
    const section = after.fields.find((x) => x.port === 'section');
    eq(section.text, 'bravo', 'picked the FILTERED value (bravo, not beta)');
  });
  it('Enter on "no match" closes the popover and does NOT commit anything', () => {
    openWithItems(['alpha', 'beta']);
    _dispatchToken(' ');
    _dispatchToken('z');                        // nothing matches
    _dispatchToken('\r');
    const after = store.getModel().modal.fabricForm;
    eq(after.picking, null, 'popover closed on empty-filter Enter');
    const section = after.fields.find((x) => x.port === 'section');
    eq(section.text, '', 'field text untouched');
  });
  it('Esc with non-empty filter CLEARS filter first; second Esc closes', () => {
    openWithItems(['alpha', 'beta']);
    _dispatchToken(' ');
    _dispatchToken('a');
    assert(store.getModel().modal.fabricForm.picking.filter, 'filter non-empty before Esc');
    _dispatchToken('\x1b');
    const after1 = store.getModel().modal.fabricForm;
    assert(after1.picking, 'popover STILL open');
    eq(after1.picking.filter, '', 'filter cleared on first Esc');
    _dispatchToken('\x1b');
    eq(store.getModel().modal.fabricForm.picking, null, 'popover closed on second Esc');
  });
  it('Esc with empty filter closes the popover (one-step close)', () => {
    openWithItems(['alpha', 'beta']);
    _dispatchToken(' ');
    _dispatchToken('\x1b');
    eq(store.getModel().modal.fabricForm.picking, null, 'closed');
  });
  it('Space while picking still closes the popover (filter never swallows space)', () => {
    openWithItems(['alpha', 'beta']);
    _dispatchToken(' ');
    _dispatchToken(' ');
    eq(store.getModel().modal.fabricForm.picking, null, 'space closes popover');
  });
  it('Tab mid-filter closes popover AND advances focus (fall-through intact)', () => {
    openWithItems(['alpha', 'beta']);
    _dispatchToken(' ');
    _dispatchToken('a');
    const focusBefore = store.getModel().modal.fabricForm.focusIdx;
    _dispatchToken('\t');
    const after = store.getModel().modal.fabricForm;
    eq(after.picking, null, 'popover closed by Tab');
    assert(after.focusIdx !== focusBefore, 'focus moved after Tab (close + fall-through)');
    // Filter text does NOT leak into the field — the Tab path is close+focus-next,
    // not close+field-key.
    const section = after.fields.find((x) => x.port === 'section');
    eq(section.text, '', 'section field unaltered');
  });
});

// ---- [4] overlay render-capture --------------------------------------

describe('[form-filter] overlay paints `/<filter>` row + "no match" row', () => {
  function openForRender(items) {
    const m = freshOverlayModel({ cols: 120, rows: 30 });
    let mm = m;
    [mm] = runtime.update(mm, { type: 'fabric_form_enter', fields: fields_fn(),
      pendingAction: { actionKey: 'edit-section', action: ACTION_FN } });
    [mm] = runtime.update(mm, { type: 'fabric_form_focus_next' });
    [mm] = runtime.update(mm, { type: 'fabric_form_choices_request', port: 'section', requestId: 1 });
    [mm] = runtime.update(mm, { type: 'fabric_form_choices_resolved', port: 'section',
      requestId: 1, items, labels: null, error: null });
    [mm] = runtime.update(mm, { type: 'fabric_form_choices_open', port: 'section' });
    return mm;
  }
  it('paints `/<filter>` above the choices list when the filter is non-empty', () => {
    let m = openForRender(['alpha', 'beta', 'bravo']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: 'b' });
    const out = captureOverlay(m, () => renderFabricFormOverlay());
    assert(out.includes('/b'), `expected /b affordance; got: ${JSON.stringify(out.slice(0, 500))}`);
    assert(out.includes('beta'), 'filtered row "beta" visible');
    assert(out.includes('bravo'), 'filtered row "bravo" visible');
    assert(!out.includes('alpha'), 'non-matching row "alpha" hidden');
  });
  it('paints "no match" when the filter kills all candidates', () => {
    let m = openForRender(['alpha', 'beta']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: 'z' });
    const out = captureOverlay(m, () => renderFabricFormOverlay());
    assert(out.includes('(no match)'), `expected "(no match)" row; got: ${JSON.stringify(out.slice(0, 500))}`);
    assert(out.includes('/z'), 'filter row still painted');
  });
  it('help line swaps to "clear filter" while the filter is non-empty', () => {
    let m = openForRender(['alpha']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_filter', seq: 'x' });
    const out = captureOverlay(m, () => renderFabricFormOverlay());
    assert(out.includes('clear filter'), `expected "clear filter" hint; got: ${JSON.stringify(out.slice(0, 500))}`);
    assert(!out.includes('close popover'), 'close-popover hint hidden while filter active');
  });
  it('an empty filter paints neither /<filter> nor "no match"', () => {
    const m = openForRender(['alpha']);
    const out = captureOverlay(m, () => renderFabricFormOverlay());
    assert(!out.includes('(no match)'), 'no match row NOT painted with empty filter');
    assert(out.includes('close popover'), 'empty-filter hint reads "close popover"');
  });
});

// ---- [5] literal `choices:` channel parity ---------------------------

describe('[form-filter] literal channel — filter works end-to-end via the shared leaf', () => {
  it('literal channel: open → filter → Enter picks the filtered value', () => {
    let m = freshModel();
    [m] = runtime.update(m, {
      type: 'fabric_form_enter',
      fields: [{ port: 'tunnel', text: '', required: true, default: null,
                 choices: { items: ['vpn-all', 'split-tunnel', 'split-dns'],
                            labels: null, truncated: false } }],
      pendingAction: { actionKey: 'reissue',
                       action: { label: 'r', type: 'run', run: 'r {{tunnel}}',
                                 ports: { in: { tunnel: { type: 'string', required: true } } } } },
    });
    store.setModel(m);
    _dispatchToken(' ');                        // open popover on literal field
    _dispatchToken('d');                        // filter → split-dns only
    const p = store.getModel().modal.fabricForm.picking;
    assert(p, 'popover open on literal channel');
    eq(p.filter, 'd', 'filter typed');
    _dispatchToken('\r');                       // Enter picks the one filtered row
    const after = store.getModel().modal.fabricForm;
    eq(after.picking, null, 'popover closed on pick');
    const tun = after.fields.find((x) => x.port === 'tunnel');
    eq(tun.text, 'split-dns', 'picked the filtered value from the literal channel');
  });
});

report();
