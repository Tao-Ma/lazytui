/**
 * Fabric multi-field FORM overlay (args→ports slice 1 commit 2) — render-capture
 * tests. Reducer-side coverage lives in test-fabric-form.js; this file pins the
 * painted output per [[feedback_render_test_new_overlays]]: a new overlay must
 * ship with a test that captures real stdout, not just a reducer assertion.
 *
 * Harness mirrors test-fabric-field-overlay.js: route draw.setWriter at
 * term.stdout.write, install the model via store.setModel(), patch term's
 * write to intercept, strip ANSI/OSC to assert content substrings. Markup
 * (`[default]` chip, cursor as `[inverse] [/]`) is Rich → ANSI → stripped at
 * capture, so we assert on the visible characters: the bracketed chip labels,
 * section headers, port names, descs.
 *
 * Run: node js/test/test-fabric-form-overlay.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const runtime = require('../app/runtime');
const store = require('../model/store');
const term = require('../io/term');
const draw = require('../leaves/render/draw');
const { renderFabricFormOverlay } = require('../overlay/fabric-form');

// Mute OSC-52 noise from the register helper (mirrors other overlay tests).
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

draw.setWriter((s) => term.stdout.write(s));
// Overlay clamp reads draw.viewportDims(), which is injected by paint.js at
// boot in production. In tests we feed it from process.stdout.columns/rows so
// a case can shrink the terminal and the overlay actually clamps.
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

/** Install `m` as live model, capture raw stdout from `fn()`. */
function captureRaw(m, fn) {
  store.setModel(m);
  const chunks = [];
  const orig = term.stdout.write;
  term.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { term.stdout.write = orig; }
  return chunks.join('');
}
/** Install `m` as live model, capture stdout from `fn()`, strip ANSI/OSC. */
function captureWith(m, fn) {
  return captureRaw(m, fn).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/** Decode a raw capture into visible-only rows at the cells the overlay wrote.
 * `renderOverlay` emits one `\x1b[<r>;<c>H<row>` per line, then a reset. We split on
 * cursor-move headers so each row is intact; SGR within the row is then stripped.
 */
function decodeRows(raw) {
  const { visibleLen } = require('../leaves/text/ansi');
  const parts = raw.split(/\x1b\[(\d+);(\d+)H/).slice(1);
  const rows = [];
  for (let i = 0; i < parts.length; i += 3) {
    const r = parts[i], c = parts[i + 1];
    const body = (parts[i + 2] || '').replace(/\x1b\[[0-9;]*m/g, '');
    rows.push({ r: parseInt(r, 10), c: parseInt(c, 10), text: body, visLen: visibleLen(body) });
  }
  return rows;
}

const PENDING_MIXED = {
  actionKey: 'provision',
  action: { label: 'Provision node', type: 'run', script: 'provision "$host"',
    ports: { in: {
      host: { type: 'string', required: true, desc: 'target hostname' },
      role: { type: 'string', required: true, desc: 'node role', default: 'worker' },
      port: { type: 'string', required: false, default: '22', desc: 'SSH port' },
      tags: { type: 'string', required: false, desc: 'comma-separated tags' },
    } } },
};

function fieldsMixed() {
  return [
    { port: 'host', text: '',       required: true,  default: null,     desc: 'target hostname' },
    { port: 'role', text: 'worker', required: true,  default: 'worker', desc: 'node role' },
    { port: 'port', text: '22',     required: false, default: '22',     desc: 'SSH port' },
    { port: 'tags', text: '',       required: false, default: null,     desc: 'comma-separated tags' },
  ];
}

function openForm(fields = fieldsMixed(), pending = PENDING_MIXED, m = freshModel()) {
  const [next] = runtime.update(m, { type: 'fabric_form_enter', fields, pendingAction: pending });
  return next;
}

describe('[fabric-form-overlay] paints a bordered popup with required+optional sections', () => {
  it('paints nothing when fabricFormMode is off', () => {
    const out = captureWith(freshModel(), () => renderFabricFormOverlay());
    assert(out === '', `expected no output, got: ${JSON.stringify(out)}`);
  });

  it('paints nothing when fields array is empty', () => {
    const m = freshModel();
    m.modes.fabricFormMode = true;
    m.modal.fabricForm = { fields: [], focusIdx: 0, pendingAction: PENDING_MIXED };
    const out = captureWith(m, () => renderFabricFormOverlay());
    assert(out === '', `empty fields → nothing painted, got: ${JSON.stringify(out)}`);
  });

  it('opens with Required and Optional section headers for a mixed action', () => {
    const out = captureWith(openForm(), () => renderFabricFormOverlay());
    assert(out.includes('Required'), `Required header absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('Optional'), `Optional header absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('Provision node'), `title (action.label) absent — got: ${JSON.stringify(out)}`);
  });

  it('all port names + descs appear in the painted frame', () => {
    const out = captureWith(openForm(), () => renderFabricFormOverlay());
    for (const name of ['host', 'role', 'port', 'tags']) {
      assert(out.includes(name), `port name "${name}" absent — got: ${JSON.stringify(out)}`);
    }
    for (const desc of ['target hostname', 'node role', 'SSH port', 'comma-separated tags']) {
      assert(out.includes(desc), `desc "${desc}" absent — got: ${JSON.stringify(out)}`);
    }
  });

  it('chip labels [default] / [modified] / [unset] appear on the right rows', () => {
    // Pre-fill: host='node-7.lan' (modified), role='worker' (default), port='22' (default),
    // tags='' (unset).
    const fields = [
      { port: 'host', text: 'node-7.lan', required: true,  default: null,     desc: 'target hostname' },
      { port: 'role', text: 'worker',     required: true,  default: 'worker', desc: 'node role' },
      { port: 'port', text: '22',         required: false, default: '22',     desc: 'SSH port' },
      { port: 'tags', text: '',           required: false, default: null,     desc: 'comma-separated tags' },
    ];
    const out = captureWith(openForm(fields), () => renderFabricFormOverlay());
    assert(out.includes('[modified]'), `[modified] chip absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('[default]'),  `[default] chip absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('[unset]'),    `[unset] chip absent — got: ${JSON.stringify(out)}`);
  });

  it('typed text appears in the painted frame, markup-safe (literal `[` escapes)', () => {
    let m = openForm();
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '[', key: '[' });
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: 'x', key: 'x' });
    const out = captureWith(m, () => renderFabricFormOverlay());
    assert(out.includes('[x'), `buffer text absent — got: ${JSON.stringify(out)}`);
  });

  it('an all-required action omits the Optional header', () => {
    const fields = [
      { port: 'host', text: '', required: true, default: null, desc: 'target hostname' },
      { port: 'role', text: '', required: true, default: null, desc: 'node role' },
    ];
    const out = captureWith(openForm(fields), () => renderFabricFormOverlay());
    assert(out.includes('Required'), 'Required header still there');
    assert(!out.includes('Optional'), `Optional header should be omitted — got: ${JSON.stringify(out)}`);
  });

  it('an all-optional action omits the Required header', () => {
    const fields = [
      { port: 'tags', text: '', required: false, default: null, desc: 'tags' },
      { port: 'opts', text: '', required: false, default: null, desc: 'options' },
    ];
    const out = captureWith(openForm(fields), () => renderFabricFormOverlay());
    assert(!out.includes('Required'), `Required header should be omitted — got: ${JSON.stringify(out)}`);
    assert(out.includes('Optional'), 'Optional header still there');
  });

  it('footer shows the keybind hint', () => {
    const out = captureWith(openForm(), () => renderFabricFormOverlay());
    assert(/tab/i.test(out), `tab hint absent — got: ${JSON.stringify(out)}`);
    assert(/enter/i.test(out), `enter hint absent — got: ${JSON.stringify(out)}`);
    assert(/esc/i.test(out), `esc hint absent — got: ${JSON.stringify(out)}`);
  });

  // ---- F1 — scroll-follows-focus (pre-release review Fork 3) ----

  it('a many-field form keeps the focused row inside the viewport (scroll-follows-focus)', () => {
    // Build a 15-port action: more fields+descs than fit on a 24-row terminal.
    const fields = [];
    for (let i = 0; i < 15; i++) {
      fields.push({ port: `port${i}`, text: '',
                    required: i < 5, default: null, desc: `desc for port${i}` });
    }
    const PENDING_LONG = { actionKey: 'longact', action: { label: 'Long action', ports: { in: {} } } };
    let m = freshModel();
    process.stdout.rows = 24;
    term.refreshSize();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields, pendingAction: PENDING_LONG });
    // Tab 10 times → focusIdx = 10. That field is deep in the Optional section;
    // without scroll-follows-focus, it would be rendered below the viewport and
    // its [modified]/[unset]/caret glyphs would be clipped away.
    for (let i = 0; i < 10; i++) {
      [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
    }
    const raw = captureRaw(m, () => renderFabricFormOverlay());
    const rows = decodeRows(raw);
    assert(rows.length > 0, 'something was painted');
    // The focused field is `port10`. On a non-scrolling renderer, port10 would
    // not appear in the frame (truncated past innerH). With scroll-follows-focus,
    // port10's row must be in the painted output.
    const painted = rows.map((r) => r.text).join('|');
    assert(painted.includes('port10'), `focused port10 absent from paint — got: ${JSON.stringify(painted)}`);
    // And the earlier required-section ports (port0..4) should have scrolled OFF
    // (we moved past them). port0's row is content line 1 (right after "Required"
    // header). With innerH=20 and scrollOffset≥1, port0 falls off the top.
    assert(!painted.includes('port0 '), `port0 should have scrolled off, but got: ${JSON.stringify(painted)}`);
    // Restore
    process.stdout.rows = 30; term.refreshSize();
  });

  it('scroll stays at 0 when the whole form fits (no spurious scrolling)', () => {
    // A 3-port action easily fits a 30-row terminal.
    const fields = [
      { port: 'host', text: '',       required: true,  default: null,     desc: 'target' },
      { port: 'role', text: 'worker', required: true,  default: 'worker', desc: 'role'   },
      { port: 'port', text: '22',     required: false, default: '22',     desc: 'ssh'    },
    ];
    const SMALL = { actionKey: 'small', action: { label: 'Small', ports: { in: {} } } };
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields, pendingAction: SMALL });
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
    const raw = captureRaw(m, () => renderFabricFormOverlay());
    const rows = decodeRows(raw);
    // Every field should be present AND the required section header.
    const painted = rows.map((r) => r.text).join('|');
    for (const name of ['host', 'role', 'port', 'Required', 'Optional']) {
      assert(painted.includes(name), `${name} absent — got: ${JSON.stringify(painted)}`);
    }
  });

  it('_scrollFor pure helper: focus near end clamps to maxScroll; near start → 0', () => {
    const { _scrollFor } = require('../overlay/fabric-form');
    eq(_scrollFor(0, 10, 20), 0, 'small form → 0');
    eq(_scrollFor(5, 20, 10), 0, 'focus=5 fits in [0,9] window → 0');
    eq(_scrollFor(15, 30, 10), 8, 'focus=15, want bottom-context=2 → scroll 8');
    eq(_scrollFor(29, 30, 10), 20, 'focus at last row → clamp to maxScroll=20');
    eq(_scrollFor(0, 100, 20), 0, 'focus at line 0 → scroll 0');
  });

  // ---- F2 — chip stays right-anchored when input overflows midW ----

  it('[modified] chip right-column stays aligned when input text overflows the input area', () => {
    // Two fields: one short, one with long text that forces truncate+ellipsis.
    const fields = [
      { port: 'short', text: 'x',                            required: true, default: null, desc: '' },
      { port: 'long',  text: 'x'.repeat(200),                required: true, default: null, desc: '' },
    ];
    const PENDING2 = { actionKey: 'two', action: { label: 'Two-field', ports: { in: {} } } };
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields, pendingAction: PENDING2 });
    const raw = captureRaw(m, () => renderFabricFormOverlay());
    const rows = decodeRows(raw).filter((r) => r.text.includes('[modified]'));
    assert(rows.length === 2, `expected 2 [modified] chips, got ${rows.length}`);
    // Both chips should land at the SAME end-column — right-anchored. (End-col =
    // row.c + visLen - 1.) The pre-fix bug paints the overflow row's chip one
    // column left.
    const endA = rows[0].c + rows[0].visLen;
    const endB = rows[1].c + rows[1].visLen;
    eq(endA, endB, `chip columns must match: short ends ${endA}, long ends ${endB} → ${JSON.stringify(rows.map((r) => r.text))}`);
  });

  it('narrow terminal (40 cols) clamps the box so no row overflows the terminal', () => {
    const m = freshModel();
    process.stdout.columns = 40; process.stdout.rows = 24;
    term.refreshSize();
    const [opened] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsMixed(), pendingAction: PENDING_MIXED });
    const raw = captureRaw(opened, () => renderFabricFormOverlay());
    const rows = decodeRows(raw);
    assert(rows.length > 0, 'something was painted');
    for (const row of rows) {
      // overlayBox clamps menuW to min(MAX_WIDTH=72, COLS-2=38) = 38; a row's
      // last cell lands at col (col-start) + (visLen-1), which must stay ≤ COLS.
      const endCol = row.c + row.visLen - 1;
      assert(endCol <= 40, `row ends at col ${endCol} > 40 (vis=${row.visLen}): ${JSON.stringify(row.text)}`);
    }
    // Restore wide dims so later tests (if any) are not affected.
    process.stdout.columns = 120; process.stdout.rows = 30;
  });
});

report();
