/**
 * Invoke-time fabric-field prompt renders an overlay (P2 render fix).
 *
 * The args→ports P2 (v0.6.30) dispatched `fabric_field_enter` with `paneId: null`
 * to open the invoke-time popup — but the ONLY renderer for the modal was the
 * ports-pane's in-grid editor, gated on `ff.paneId === panel.paneId`. With
 * paneId null no pane matched (and a layout may have no ports pane at all), so
 * nothing painted while `fabricFieldMode` swallowed every key — the TUI looked
 * frozen. Esc still cancelled; typing + Enter still submitted; no visual
 * feedback. The reducer tests only pin model state so this stayed green through
 * v0.6.30 and v0.6.31 — exactly the render blind spot S3's own commit flagged.
 *
 * Fix: `js/overlay/fabric-field.js` (confirm.js pattern), gated on `paneId == null`
 * so the ports-pane in-grid path is unchanged. These tests drive the real
 * reducer + call the overlay directly, with stdout captured.
 *
 * Run: node js/test/test-fabric-field-overlay.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const store = require('../model/store');
const term = require('../io/term');
const draw = require('../leaves/render/draw');
const { renderFabricFieldOverlay } = require('../overlay/fabric-field');

// Mute OSC-52 noise from the register helper (mirrors other overlay tests).
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

// Route renderOverlay's writer at `term.stdout.write` as the production boot does
// — the capture() helper below patches .write per call to intercept output.
draw.setWriter((s) => term.stdout.write(s));

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';
  m.register = { history: [], cap: 10 };
  process.stdout.columns = 120; process.stdout.rows = 30;
  term.refreshSize();
  return m;
}

/** Install `m` as the live model (what getModel() returns) and run `fn()`, capturing stdout. */
function captureWith(m, fn) {
  store.setModel(m);
  const chunks = [];
  const orig = term.stdout.write;
  term.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { term.stdout.write = orig; }
  // Strip ANSI so assertions match plain content.
  return chunks.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

const PENDING = {
  actionKey: 'enable',
  action: { label: 'Enable', type: 'run', script: 'echo "$name"',
    ports: { in: { name: { type: 'node_name', required: true, desc: 'node to enable' } } } },
};
const HYPHENATED_PENDING = {
  actionKey: 'ddns-ping',
  action: { label: 'Ping DDNS', type: 'run', script: 'ping -c 1 "$host"',
    ports: { in: { host: { type: 'string', required: true, desc: 'hostname to ping' } } } },
};

function enterInvoke(pending) {
  let m = freshModel();
  [m] = runtime.update(m, {
    type: 'fabric_field_enter', paneId: null, text: '', pendingAction: pending,
    addr: `${pending.actionKey}.${Object.keys(pending.action.ports.in)[0]}`,
  });
  return m;
}

describe('[fabric-field-overlay] invoke-time prompt paints a real overlay (P2 render fix)', () => {
  it('paints nothing when fabricFieldMode is off', () => {
    const out = captureWith(freshModel(), () => renderFabricFieldOverlay());
    assert(out === '', `expected no output when mode is off, got ${JSON.stringify(out)}`);
  });

  it('paints an overlay when the modal opened with paneId=null + pendingAction (invoke-time)', () => {
    const out = captureWith(enterInvoke(PENDING), () => renderFabricFieldOverlay());
    assert(out.includes('enable.name'), `addr absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('node to enable'), `port desc absent — got: ${JSON.stringify(out)}`);
    assert(/enter|esc/i.test(out), `footer absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('Enable'), `action label (title) absent — got: ${JSON.stringify(out)}`);
  });

  it('typed text appears in the rendered buffer, markup-safe (`[` must escape)', () => {
    let m = enterInvoke(PENDING);
    [m] = runtime.update(m, { type: 'fabric_field_key', seq: '[', key: '[' });
    [m] = runtime.update(m, { type: 'fabric_field_key', seq: 'x', key: 'x' });
    const out = captureWith(m, () => renderFabricFieldOverlay());
    assert(out.includes('[x'), `buffer text absent — got: ${JSON.stringify(out)}`);
  });

  it('DOES NOT paint when fabricFieldMode is on but paneId is NON-null (ports-pane path)', () => {
    let m = freshModel();
    [m] = runtime.update(m, {
      type: 'fabric_field_enter', paneId: 'pane-ports', addr: 'xlogminer.start_lsn', text: '',
    });
    const out = captureWith(m, () => renderFabricFieldOverlay());
    assert(out === '', `ports-pane path must stay in-grid, got: ${JSON.stringify(out)}`);
  });

  it('paints the hyphenated action addr intact (ddns-ping.host from v0.6.31)', () => {
    const out = captureWith(enterInvoke(HYPHENATED_PENDING), () => renderFabricFieldOverlay());
    assert(out.includes('ddns-ping.host'), `hyphenated addr absent — got: ${JSON.stringify(out)}`);
    assert(out.includes('hostname to ping'), `desc for hyphenated absent — got: ${JSON.stringify(out)}`);
  });

  it('closes the overlay after fabric_field_cancel', () => {
    let m = enterInvoke(PENDING);
    [m] = runtime.update(m, { type: 'fabric_field_cancel' });
    const out = captureWith(m, () => renderFabricFieldOverlay());
    assert(out === '', `after cancel: no overlay, got: ${JSON.stringify(out)}`);
  });
});

report();
