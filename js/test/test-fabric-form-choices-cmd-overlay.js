/**
 * Fabric multi-field FORM overlay — `choices_cmd:` chip + hint variants
 * (args→ports slice 3). Mirrors test-fabric-form-choices-overlay.js's
 * harness; verifies the overlay rendering reads the channel-agnostic
 * `computed` slot (same `[fetching…]` / `[N choices]` / `[error]` chips)
 * AND that the `[space] choices` hint fires for a focused choicesCmd
 * field (gated on `choicesFnRef || choicesCmd` in js/overlay/fabric-form.js
 * and js/dispatch/control/dispatch.js).
 *
 * Run: node js/test/test-fabric-form-choices-cmd-overlay.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
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
  actionKey: 'worktree-add',
  action: { label: 'Add worktree', type: 'run', script: 'wtadd "$repo" "$branch"',
    ports: { in: {
      repo:   { type: 'path',   required: true, desc: 'repo path' },
      branch: { type: 'string', required: true, desc: 'branch',
                choices_cmd: 'git -C "$repo" branch --format=%(refname:short)',
                depends_on: ['repo'] },
    } } },
};

function fieldsFor() {
  return [
    { port: 'repo',   text: '/some/repo', required: true, default: null, desc: 'repo path' },
    { port: 'branch', text: '',           required: true, default: null, desc: 'branch',
      choicesCmd: 'git -C "$repo" branch --format=%(refname:short)',
      choicesLabeled: false, choicesTimeout: 3000,
      dependsOn: ['repo'] },
  ];
}

function openFormWithBranchFocused() {
  let m = freshModel();
  [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
  [m] = runtime.update(m, { type: 'fabric_form_focus_next' });    // branch
  return m;
}

describe('[fabric-form-choices-cmd-overlay] chips (channel-agnostic)', () => {
  it('[fetching…] while pending (shared with fn path)', () => {
    let m = openFormWithBranchFocused();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'branch', requestId: 1 });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[fetching…]'), `expected [fetching…] chip, got:\n${out}`);
  });

  it('[N choices] after a resolved reply with N items', () => {
    let m = openFormWithBranchFocused();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'branch', requestId: 2 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'branch', requestId: 2,
      items: ['main', 'dev', 'feature-x'], labels: null, error: null,
    });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[3 choices]'), `expected [3 choices], got:\n${out}`);
  });

  it('[error] when the command exited non-zero', () => {
    let m = openFormWithBranchFocused();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'branch', requestId: 3 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'branch', requestId: 3,
      items: [], labels: null, error: 'exit=128: not a git repo',
    });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[error]'), `expected [error] chip, got:\n${out}`);
  });
});

describe('[fabric-form-choices-cmd-overlay] [space] choices hint', () => {
  it('shows [space] choices when a choicesCmd field is focused', () => {
    const m = openFormWithBranchFocused();
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[space] choices'),
      `focused choicesCmd field must advertise [space] choices, got:\n${out}`);
  });

  it('does NOT show the hint when focused on the plain repo field', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    // repo focused by default
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(!out.includes('[space] choices'),
      `plain focused field should NOT advertise [space] choices, got:\n${out}`);
  });
});

// --- 1-field form render (slice-3 follow-up: 1-port actions with choices now
//     route through the form; verify the one-field variant paints the chip,
//     field label, and [space] help without crashing or dropping chrome.) ---

const PENDING_1 = { actionKey: 'pick',
  action: { label: 'Pick', type: 'run', script: 'echo "$name"',
    ports: { in: { name: { type: 'string', required: true,
                           choices_cmd: "printf 'a\\nb\\n'" } } } } };
function fieldsFor1() {
  return [
    { port: 'name', text: '', required: true, default: null, desc: 'name',
      choicesCmd: "printf 'a\\nb\\n'", choicesLabeled: false, choicesTimeout: null, dependsOn: [] },
  ];
}

describe('[fabric-form-choices-cmd-overlay] popover overflow cap — hint + footer stay visible', () => {
  // R2-BUG2: at ≥~rows items the popover used to grow unbounded, swallowing
  // the help line and required-missing footer. Fix caps displayed items so
  // chrome always fits; slice follows picking.idx; overflow indicator shows
  // "N of M — up/down to scroll".
  // Shared helper: open form, fire request + resolved so items populate,
  // open popover. runtime.update doesn't process chained Msgs, so request
  // and resolved are explicit.
  function openWithItems(items) {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor1(), pendingAction: PENDING_1 });
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'name', requestId: 1 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'name', actionKey: 'pick', requestId: 1,
      items, labels: null, error: null,
    });
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'name' });
    return m;
  }

  it('30 items on a 30-row terminal: popover caps, hint line + footer visible, indicator paints', () => {
    const bigItems = Array.from({ length: 30 }, (_, i) => `item${i + 1}`);
    const m = openWithItems(bigItems);
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(/\[\d+ of 30 — up\/down to scroll\]/.test(out),
      `expected "[N of 30 — up/down to scroll]" indicator, got:\n${out}`);
    assert(out.includes('[up/down] move'),
      `help line must stay visible with cap applied, got:\n${out}`);
    assert(out.includes('required inputs still missing: name'),
      `footer must stay visible with cap applied, got:\n${out}`);
    // The slice is centered on picking.idx (0 at open), so item1 shows but
    // item30 does NOT (would require scroll).
    assert(out.includes('item1'), 'item1 (near picking.idx) visible');
    assert(!out.includes('item30'), 'item30 (past window) NOT visible without scroll');
  });

  it('30 items + picking advanced to idx 25: window shifts to show item 25', () => {
    const bigItems = Array.from({ length: 30 }, (_, i) => `item${i + 1}`);
    let m = openWithItems(bigItems);
    // Press Down 25 times to advance picking.idx to 25.
    for (let i = 0; i < 25; i++) {
      [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });
    }
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('item25'), `item25 (focus) visible after scroll, got:\n${out}`);
    assert(out.includes('[up/down] move'), 'help line still pinned');
  });

  it('10 items on 30-row terminal: no cap applied, no overflow indicator', () => {
    const smallItems = Array.from({ length: 10 }, (_, i) => `item${i + 1}`);
    const m = openWithItems(smallItems);
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(!out.includes('— up/down to scroll'),
      `no overflow indicator for 10 items on 30-row, got:\n${out}`);
    assert(out.includes('item10'), 'all 10 items visible');
  });
});

describe('[fabric-form-choices-cmd-overlay] 1-field form paints chip + help without chrome drops', () => {
  it('[fetching…] chip paints and [space] choices hint shows on the sole field', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor1(), pendingAction: PENDING_1 });
    // runtime.update doesn't process chained Msg Cmds — fire the request
    // explicitly (the real dispatch loop would do this on enter for a
    // dep-less computed field).
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'name', requestId: 1 });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('name'), `field label present, got:\n${out}`);
    assert(out.includes('[fetching…]'), `expected [fetching…] on 1-field form, got:\n${out}`);
    assert(out.includes('[space] choices'),
      `[space] choices hint must show (sole field is focused + has choicesCmd), got:\n${out}`);
  });

  it('[N choices] chip paints after resolved reply on the 1-field form', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor1(), pendingAction: PENDING_1 });
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'name', requestId: 1 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'name', actionKey: 'pick', requestId: 1,
      items: ['a', 'b'], labels: null, error: null,
    });
    const out = captureStripped(m, () => renderFabricFormOverlay());
    assert(out.includes('[2 choices]'),
      `expected [2 choices] after resolve on 1-field form, got:\n${out}`);
  });
});

report();
