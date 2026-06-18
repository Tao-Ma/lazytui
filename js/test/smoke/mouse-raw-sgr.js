/**
 * Smoke — v0.6.4 Theme F Phase 5: raw SGR bytes through the REAL stdin path.
 *
 * Every other mouse test enters partway down the pipeline — `test-mouse-
 * gestures.js` unit-tests the parser's `_classifyPress` in isolation, and
 * `smoke/mouse-gestures.js` starts from an already-classified gesture
 * (`handleMouse('double', …)`). Neither drives the actual byte path. This
 * scenario closes that gap: it installs a fake `process.stdin`, calls the
 * real `setupKeyListener()` to register the production `'data'` handler,
 * and fires raw SGR press sequences (`\x1b[<button;x;yM`) at it — so the
 * WHOLE chain runs end to end:
 *
 *     raw bytes → matchAll regex → _classifyPress (gesture) → handleMouse
 *               → mouse-bindings intentFor → intent.realize → Msg
 *
 * Coverage: a genuine left double (same cell, fast) → activate; right →
 * context menu at the cursor; middle → reserved no-op; and the SAME
 * same-cell repeat with the double-click window shrunk → two singles
 * (proving the live parser reads `mouseBindings.doubleClickMs()`).
 *
 * Run: node js/test/smoke/mouse-raw-sgr.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('../test-runner');
const sm = require('./_helpers/smoke');
const geo = require('../../leaves/wm/geometry');  // A.2: bounds are derived, not on slice.paneBounds
const api = sm.api;
const { getModel } = require('../../app/runtime');
const actions = require('../../dispatch/control/actions');
const input = require('../../dispatch/control/input');
const mb = require('../../dispatch/control/mouse-bindings');

// 0-based pane grid → 1-based SGR coords (handleMouse subtracts 1).
function sgr0(col0, row0) { return [col0 + 1, row0 + 1]; }

// Build a raw SGR *press* sequence. button: 0=left, 1=middle, 2=right.
// x,y are 1-based (the wire coords the terminal sends).
function pressBytes(button, sx, sy) { return `\x1b[<${button};${sx};${sy}M`; }

// A cell outside every pane — firing a press here advances the parser's
// {lastX,lastY,lastTime} triple WITHOUT mutating the model (handleMouse
// hit-tests it against nothing), so the next press at a real cell reads
// as a clean single regardless of what an earlier scenario left behind.
const [OFFX, OFFY] = [250, 90];

function groupsBounds() {
  return geo.visibleBoundsFor(api.getInstanceSlice('layout'), 'pane-groups');
}

// Spy on handleAction WITHOUT calling through — focus + select route via
// dispatchMsg / navSelect (not handleAction), so swallowing it isolates
// the `activate` (run_selected) call while leaving the cursor write intact.
// (Mirrors smoke/mouse-gestures.js.)
function withActionSpy(fn) {
  const calls = [];
  const real = actions.handleAction;
  actions.handleAction = (...a) => { calls.push(a); };
  try { fn(); } finally { actions.handleAction = real; }
  return calls;
}

// --- Install the REAL stdin data handler against a fake stdin. -----------
//
// setupKeyListener() captures `process.stdin` at call time and registers
// its 'data' closure on it (plus setRawMode/resume + the enable* escape
// writes, which we swallow via sm.capture). We hand it a fake stdin,
// grab the closure, then restore the real descriptor. `fire(bytes)` drives
// the captured closure exactly as Node would on a real keypress.
function makeFire() {
  const realDesc = Object.getOwnPropertyDescriptor(process, 'stdin');
  let handler = null;
  const fake = {
    isTTY: true,
    setRawMode() {}, resume() {}, setEncoding() {},
    on(ev, cb) { if (ev === 'data') handler = cb; },
    // The paste path re-emits a trailing chunk via stdin.emit('data', …);
    // route it back through the same handler so that path stays faithful.
    emit(ev, data) { if (ev === 'data' && handler) handler(data); },
  };
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try { sm.capture(() => input.setupKeyListener()); }
  finally { Object.defineProperty(process, 'stdin', realDesc); }
  assert(handler, 'setupKeyListener registered a data handler');
  return (bytes) => sm.capture(() => handler(bytes));
}

const fire = makeFire();

describe('[1] raw left double-click bytes → activate', () => {
  it('two same-cell left presses (fast) parse to a double and run_selected', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    const b = groupsBounds();
    assert(b, 'groups pane bounds present');
    const [sx, sy] = sgr0(b.x + 2, b.y + 1);   // first item row, inside body

    fire(pressBytes(0, OFFX, OFFY));            // advance the triple off-pane

    // First press at the target — a single. Focus + select, no activate.
    const single = withActionSpy(() => fire(pressBytes(0, sx, sy)));
    assert(!single.some(c => c[0] === 'run_selected'),
      `the first press must NOT activate (saw: ${JSON.stringify(single)})`);

    // Second press, same cell, microseconds later — the live parser
    // classifies it `double` (Δ ≤ default 250 ms) and the resolver
    // activates the focused+selected row.
    const dbl = withActionSpy(() => fire(pressBytes(0, sx, sy)));
    assert(dbl.some(c => c[0] === 'run_selected'),
      `the same-cell fast repeat MUST activate via run_selected (saw: ${JSON.stringify(dbl)})`);
  });

  it('a same-cell double on the top border (off-row) is inert', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    const b = groupsBounds();
    const [sx, sy] = sgr0(b.x + 2, b.y);       // top border — no item here
    fire(pressBytes(0, OFFX, OFFY));
    fire(pressBytes(0, sx, sy));               // single on border
    const dbl = withActionSpy(() => fire(pressBytes(0, sx, sy)));  // double on border
    assert(!dbl.some(c => c[0] === 'run_selected'),
      `an off-row double must not activate (saw: ${JSON.stringify(dbl)})`);
  });
});

describe('[2] raw right-click bytes → context menu at the cursor', () => {
  it('button-2 press opens the menu and threads the {x,y} anchor', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    eq(getModel().modes.menuOpen, false, 'menu starts closed');
    const b = groupsBounds();
    const [sx, sy] = sgr0(b.x + 3, b.y + 1);
    fire(pressBytes(2, sx, sy));
    eq(getModel().modes.menuOpen, true, 'right-click opened the menu');
    eq(getModel().modal.menu.anchor, { x: sx, y: sy }, 'menu anchored at the cursor cell');
    assert(getModel().modal.menu.items.length > 0, 'menu has items');
  });
});

describe('[3] raw middle-click bytes → reserved no-op', () => {
  it('button-1 press changes nothing — no menu, no focus change, no activate', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    const focusBefore = api.getInstanceSlice('layout').focus;
    const b = groupsBounds();
    const [sx, sy] = sgr0(b.x + 2, b.y + 1);
    const calls = withActionSpy(() => fire(pressBytes(1, sx, sy)));
    eq(getModel().modes.menuOpen, false, 'no menu opened');
    eq(api.getInstanceSlice('layout').focus, focusBefore, 'focus unchanged');
    assert(calls.length === 0, `middle-click fires nothing (saw: ${JSON.stringify(calls)})`);
  });
});

// --- [4] The window is read live by the parser ---------------------------
//
// The identical byte sequence from [1] — two fast same-cell left presses —
// must classify as TWO SINGLES (no activate) once the double-click window
// is shrunk below the inter-press gap. We can't slow real wall-clock, so
// we set the window to -1 ms: a non-negative Δ is never ≤ -1, so the second
// press can never be a double. This proves `_classifyPress` reads
// `mouseBindings.doubleClickMs()` at parse time, not a captured constant.

describe('[4] shrunk double-click window → same bytes are two singles', () => {
  it('with the window below the gap, the fast same-cell repeat does NOT activate', () => {
    mb.configure({ 'double-click-ms': -1 });
    try {
      sm.bootFresh();
      sm.capture(() => sm.render());
      const b = groupsBounds();
      const [sx, sy] = sgr0(b.x + 2, b.y + 1);
      fire(pressBytes(0, OFFX, OFFY));
      const calls = withActionSpy(() => {
        fire(pressBytes(0, sx, sy));           // single
        fire(pressBytes(0, sx, sy));           // would-be double, but window=-1 → single
      });
      assert(!calls.some(c => c[0] === 'run_selected'),
        `outside the window, a same-cell repeat must stay two singles (saw: ${JSON.stringify(calls)})`);
    } finally {
      mb.reset();
    }
  });
});

report();
