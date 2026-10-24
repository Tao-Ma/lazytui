/**
 * Fabric multi-field FORM overlay — `choices_fn:` chip variants + choices
 * popover render-capture (args→ports slice 2 commit 4).
 *
 * Reducer-side coverage lives in test-fabric-form-choices.js; this file pins
 * what the user actually sees per [[feedback_render_test_new_overlays]]:
 *
 *   - chip reads `[fetching…]` while state === 'pending'
 *   - chip reads `[error]` while state === 'error' (and the error desc appears
 *     under the input when the popover is open)
 *   - chip reads `[N choices]` while state === 'ok' and nothing picked
 *   - help line shows `[space] choices` only when the focused field has a
 *     choicesFnRef
 *   - popover: items render indented, highlighted entry inverse-painted,
 *     empty-items shows `(no choices)`, pending shows `awaiting choices…`
 *   - help line flips to the picker's keys while the popover is open
 *
 * Harness mirrors test-fabric-form-overlay.js — install model via setModel,
 * capture stdout via a draw.setWriter patch, strip ANSI/OSC to assert visible
 * substrings.
 *
 * Run: node js/test/test-fabric-form-choices-overlay.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const runtime = require('../app/runtime');
const store = require('../model/store');
const term = require('../io/term');
const draw = require('../leaves/render/draw');
const { renderFabricFormOverlay } = require('../overlay/fabric-form');

// Mute OSC-52 noise.
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

draw.setWriter((s) => term.stdout.write(s));
draw.setDimsProvider(() => ({
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
}));

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';
  m.register = { history: [], cap: 10 };
  process.stdout.columns = 120; process.stdout.rows = 30;
  term.refreshSize();
  return m;
}

function captureRaw(m, fn) {
  store.setModel(m);
  const chunks = [];
  const orig = term.stdout.write;
  term.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { term.stdout.write = orig; }
  return chunks.join('');
}
function captureStripped(m, fn) {
  return captureRaw(m, fn).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

const PENDING = {
  actionKey: 'edit-section',
  action: { label: 'Edit section', type: 'run', script: 'edit "$file" "$section"',
    ports: { in: {
      file:    { type: 'path',   required: true, desc: 'target file' },
      section: { type: 'string', required: true, desc: 'section',
                 choices_fn: 'edit.sections_of', depends_on: ['file'] },
    } } },
};

function fieldsFor() {
  return [
    { port: 'file',    text: '/tmp/x.md', required: true, default: null, desc: 'target file' },
    { port: 'section', text: '',          required: true, default: null, desc: 'section',
      choicesFnRef: 'edit.sections_of', dependsOn: ['file'] },
  ];
}

function openFormWithSectionFocused() {
  let m = freshModel();
  [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
  // Section is the second field (declaration order; both required). Focus it.
  [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
  return m;
}

describe('[fabric-form-choices-overlay] chips', () => {
  it('[fetching…] while pending', () => {
    let m = openFormWithSectionFocused();
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'section', requestId: 1,
    });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[fetching…]'), `expected [fetching…] chip, got:\n${out}`);
  });

  it('[error] while errored', () => {
    let m = openFormWithSectionFocused();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 2 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 2,
      items: [], labels: null, error: 'file not found',
    });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[error]'), `expected [error] chip, got:\n${out}`);
  });

  it('[N choices] while ok + unpicked (singular/plural)', () => {
    let m = openFormWithSectionFocused();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 3 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 3,
      items: ['a', 'b', 'c'], labels: null, error: null,
    });
    let out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[3 choices]'), `expected [3 choices], got:\n${out}`);

    // Single choice → singular.
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 4 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 4,
      items: ['only'], labels: null, error: null,
    });
    out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[1 choice]'), `expected [1 choice] (singular), got:\n${out}`);
  });

  it('R1D-SMELL1 — [N choices] chip paints even when the port has a default', () => {
    // Pre-fix _chipMarkup gated the chip on `text === '' && default == null`,
    // so a computed port with a default showed `[default]` and no choice
    // affordance — the most common configuration lost discoverability.
    let m = freshModel();
    const fields = [
      { port: 'file',    text: '/tmp/x.md', required: true, default: null, desc: 'target file' },
      { port: 'section', text: 'body',      required: true, default: 'body', desc: 'section',
        choicesFnRef: 'edit.sections_of', dependsOn: ['file'] },
    ];
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields,
      pendingAction: { actionKey: 'edit-section', action: PENDING.action } });
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });   // focus section
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 10 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 10,
      items: ['intro', 'body'], labels: null, error: null,
    });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[2 choices]'),
      `expected [2 choices] chip even with default='body', got:\n${out}`);
  });

  it('[default]/[modified] chip survives once user picks', () => {
    let m = openFormWithSectionFocused();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 5 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 5,
      items: ['body'], labels: null, error: null,
    });
    [m] = runtime.update(m, { type: 'fabric_form_choices_pick', port: 'section', value: 'body' });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    // After pick, section text='body', default=null → isModified; chip stops being [1 choice].
    assert(out.includes('[modified]'), `expected [modified] after pick, got:\n${out}`);
    assert(!out.includes('[1 choice]'), 'chip should flip away from [N choices] once picked');
  });
});

describe('[fabric-form-choices-overlay] help line', () => {
  it('shows [space] choices only when focused field has choicesFnRef', () => {
    const m = openFormWithSectionFocused();
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[space] choices'), `expected [space] choices hint, got:\n${out}`);
  });

  it('does NOT show [space] choices when focused field is plain', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    // file is focused by default — plain port, no choicesFnRef.
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(!out.includes('[space] choices'),
           `plain focused field should not advertise [space] choices, got:\n${out}`);
  });
});

describe('[fabric-form-choices-overlay] popover', () => {
  function openPopoverWithItems(items) {
    let m = openFormWithSectionFocused();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 6 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 6,
      items, labels: null, error: null,
    });
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    return m;
  }

  it('ok + items → rows render + help flips to picker keys', () => {
    const m = openPopoverWithItems(['intro', 'body', 'outro']);
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('intro'), 'intro row visible');
    assert(out.includes('body'),  'body row visible');
    assert(out.includes('outro'), 'outro row visible');
    assert(out.includes('[up/down] move'),  'picker help: nav keys');
    assert(out.includes('[enter] pick'),    'picker help: enter picks');
    assert(out.includes('[esc] close'),     'picker help: esc closes');
    assert(!out.includes('[tab] next'),     'regular help line hidden while picking');
  });

  it('highlighted entry wears [reverse] in RAW output', () => {
    let m = openPopoverWithItems(['a', 'b', 'c']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });   // idx 1 → b
    const raw = captureRaw(m, () => renderFabricFormOverlay());
    // '[reverse]' expands to SGR 7 (`\x1b[7m`); the raw frame should carry it.
    assert(/\x1b\[7m[^]*?b/.test(raw),
           'inverse SGR precedes the highlighted entry');
  });

  it('empty items → "(no choices)" row', () => {
    const m = openPopoverWithItems([]);
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('(no choices)'), `expected (no choices) row, got:\n${out}`);
  });

  it('pending popover → "awaiting choices…" row', () => {
    let m = openFormWithSectionFocused();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 7 });
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('awaiting choices'), `expected awaiting-row, got:\n${out}`);
  });

  it('error popover → error text in the body', () => {
    let m = openFormWithSectionFocused();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 8 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 8,
      items: [], labels: null, error: 'ENOENT: /tmp/x.md',
    });
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('ENOENT: /tmp/x.md'), `expected error text in popover, got:\n${out}`);
  });

  it('truncated reply paints `[+more…]` row at the end of the list', () => {
    let m = openFormWithSectionFocused();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 9 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 9,
      items: ['a', 'b', 'c'], labels: null, error: null, truncated: true,
    });
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[+more…]'), `expected +more affordance, got:\n${out}`);
  });
});

// R1D-BUG1 regression: `[N choices]` for N≥10 was 12+ cells but CHIP_SLOT was
// a fixed 11 cells, so the chip overran the row budget and renderPanel
// truncated with `…` (`[10 choice…`). The fix picks chipSlot dynamically from
// the actual chips painted this frame.
describe('[fabric-form-choices-overlay] R1D-BUG1 — chip survives at N ≥ 10 items', () => {
  function openFormWithNItems(n) {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });   // focus section
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 100 });
    const items = Array.from({ length: n }, (_, i) => `opt${i}`);
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 100,
      items, labels: null, error: null,
    });
    return m;
  }

  it('[10 choices] paints without truncation', () => {
    const m = openFormWithNItems(10);
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[10 choices]'),
      `expected [10 choices] chip intact (not truncated to '[10 choice…'), got:\n${out}`);
    assert(!/\[10 choice…/.test(out), 'the slice-1 fixed CHIP_SLOT would truncate here');
  });

  it('[1024 choices] paints without truncation', () => {
    const m = openFormWithNItems(1024);
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[1024 choices]'),
      `expected [1024 choices] chip intact, got:\n${out}`);
  });
});

// R1D-BUG2 regression: _scrollFor was anchored on the FIELD row, not the
// highlighted popover row. With a long items[] and nav past viewport bottom,
// the user could never see the highlighted entry — Up/Down moved an invisible
// cursor. Fix: popover-open paints track the picking-idx row and prefer it as
// the scroll anchor.
describe('[fabric-form-choices-overlay] R1D-BUG2 — popover scroll follows highlight', () => {
  it('nav to idx 20 in a 30-item list keeps the highlighted entry on-screen', () => {
    process.stdout.columns = 80; process.stdout.rows = 15;   // narrow enough to force scroll
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 101 });
    const items = Array.from({ length: 30 }, (_, i) => `opt${String(i).padStart(2, '0')}`);
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 101,
      items, labels: null, error: null,
    });
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    // Nav to idx 20.
    for (let i = 0; i < 20; i++) {
      [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });
    }
    const raw = captureRaw(m, () => renderFabricFormOverlay());
    // The highlighted entry (`opt20`) must appear in the raw output with the
    // reverse SGR. Pre-fix, scroll was anchored on the field row (near 0), so
    // only opt00..opt07 fit in a 15-row viewport.
    assert(/\x1b\[7m[^]*?opt20/.test(raw),
      `highlighted opt20 should be painted (with reverse SGR), got:\n${raw.slice(0, 800)}`);
    process.stdout.columns = 120; process.stdout.rows = 30;
  });
});

report();
