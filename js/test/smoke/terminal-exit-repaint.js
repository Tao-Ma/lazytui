/**
 * Smoke — the shell-in-a-tab lifecycle stays visible and repaints
 * (user-found 2026-08-05, demo/postgres `s` on a container).
 *
 * Two bugs pinned:
 *
 *  1. STRIP — while a `terminal` tab was ACTIVE in the content slot, the
 *     pane rendered its plain title instead of the unified slot strip:
 *     Info/Transcript VANISHED from the border for the whole life of the
 *     shell (info/text-view/agent had the U2e P1b strip; terminal.js was
 *     the one content kind without it).
 *
 *  2. SWALLOWED REPAINT — a batched SGR press+release chunk (SSH) whose
 *     dispatch asked for a force-full repaint (the dead-session click →
 *     terminal_exit path) ran the diff-cache INVALIDATION in place of the
 *     batch's one trailing paint: ZERO bytes written, the stale
 *     full-screen terminal persisted, and the tab strip flickered in and
 *     out on later events (the deferred-force-full regression).
 *
 * Drives the REAL pipeline with a REAL PTY: the docker-shell mint
 * sequence (no zoom) with a live `sh`, a typed `exit` through the data
 * handler, the pty-lifecycle exit fan-out (wired here exactly as tui.js
 * boots it), then the type:spawn full-zoom variant with a failing child
 * (non-zero exit keeps the DEAD tab) and a batched click on it.
 *
 * Run: node js/scripts/run-smoke.js terminal-exit-repaint   (or directly)
 */
'use strict';

const EventEmitter = require('events');
const sm = require('./_helpers/smoke');
const api = sm.api;
const paint = require('../../render/paint');
const input = require('../../dispatch/control/input');
const { getModel } = require('../../model/store');
const loop = require('../../dispatch/runtime/loop');
const dispatch = require('../../dispatch/control/dispatch');
const term = require('../../io/terminal');
const route = require('../../panel/route');
const { describe, it, assert, eq, report } = require('../test-runner');

// The harness auto-registers only layout/detail/groups; production boot
// registers the rest — an unregistered kind renders '' (a blank pane).
if (!api.getComponent('terminal')) api.registerComponent(require('../../panel/terminal/terminal'));
if (!api.getComponent('actions')) api.registerComponent(require('../../panel/navigator/actions'));

sm.bootFresh({});
sm.resize(100, 30);
paint.setColorDepth('truecolor');

// Boot wiring the harness lacks: the PTY-exit fan-out (tui.js install).
require('../../panel/content/pty-lifecycle').install({
  applyMsg: dispatch.applyMsg,
  dispatchMsg: loop.dispatchMsg,
  wrap: api.wrap,
});

const container = route.resolveViewerPaneId() || api.getInstanceSlice('layout').focus;
const stdin = new EventEmitter();
stdin.on('data', input._makeDataHandler(stdin));

// Capture stdout across the async phases (sm.capture is sync-scoped).
let _chunks = [];
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => { _chunks.push(String(s)); return true; };
const takeRaw = () => { const r = _chunks.join(''); _chunks.length = 0; return r; };
const restore = () => { process.stdout.write = _origWrite; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rq = require('../../leaves/infra/render-queue');
const fullFrame = () => { rq.forceFullRepaint(); sm.render(); return takeRaw(); };
const waitDead = async (id) => {
  for (let i = 0; i < 100 && !term.isSessionDead(id) && term.getSession(id); i++) await sleep(30);
};

(async () => {
  // ---- scenario A: docker-shell flow (no zoom), live sh, typed exit ----
  const poolId = 'term-dockersh-pg';
  loop.dispatchMsg(api.wrap('layout', {
    type: 'mint_tab', paneId: container, paneType: 'terminal', poolId,
    title: 'sh:pg', config: { cmd: 'sh', label: 'sh:pg' },
    hint: { origin: 'docker-shell', item: 'pg' },
  }));
  loop.dispatchMsg(api.wrap('layout', { type: 'set_active_tab', paneId: container, tabPoolId: poolId }));
  loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: container }));
  dispatch.applyMsg({ type: 'terminal_enter' });
  await sleep(250);   // PTY spawn + prompt
  const runningFrame = fullFrame();

  stdin.emit('data', 'exit\r');
  const sessId = route.activeInstanceOf(container);
  await waitDead(sessId);
  await sleep(150);   // exit fan-out + its debounced scheduleRender (50ms)
  const afterExitRaw = takeRaw();
  const modeAfterExit = getModel().modes.terminalMode;
  const activeAfterExit = route.activeInstanceOf(container);

  describe('[A] shell tab keeps the slot strip; typed exit lands back on content', () => {
    it('while the shell runs, the strip still shows Info + Transcript (was: plain pane title)', () => {
      assert(/Info/.test(runningFrame) && /Transcript/.test(runningFrame),
             'strip lists the sibling tabs while the terminal tab is active');
      assert(/sh:pg/.test(runningFrame), 'and the shell tab itself');
    });
    it('typed exit → fan-out closes the tab, leaves terminal mode, repaints the strip', () => {
      eq(modeAfterExit, false, 'terminal mode exited');
      assert(activeAfterExit !== sessId, 'clean exit auto-closed the shell tab');
      assert(afterExitRaw.length > 0, 'the fan-out painted');
      assert(/Info/.test(sm.stripAnsi(afterExitRaw)) || /Transcript/.test(sm.stripAnsi(afterExitRaw)),
             'the repaint restored the content strip');
    });
  });

  // ---- scenario B: type:spawn full zoom, failing child, batched click ----
  // A non-zero exit KEEPS the dead tab (the user reads the error). Re-enter
  // terminal mode on it, then a batched press+release click: the dead-session
  // rule exits the mode + asks for a force-full INSIDE the batch window —
  // the swallowed-repaint regression painted 0 bytes here.
  loop.dispatchMsg(api.wrap('layout', {
    type: 'mint_tab', paneId: container, paneType: 'terminal', idPrefix: 'term',
    title: 'boom', config: { cmd: 'sh -c "exit 1"', label: 'boom' },
    hint: { origin: 'spawn', group: getModel().currentGroup, key: 'boom' },
  }));
  loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: container }));
  loop.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'full' }));
  dispatch.applyMsg({ type: 'terminal_enter' });
  const deadId = route.activeInstanceOf(container);
  await waitDead(deadId);
  await sleep(150);   // the non-zero fan-out drops mode+zoom, tab stays
  takeRaw();
  dispatch.applyMsg({ type: 'terminal_enter' });   // user re-enters the dead tab
  loop.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'full' }));
  takeRaw();

  stdin.emit('data', '\x1b[<0;10;2M\x1b[<0;10;2m');   // batched press+release
  const clickRaw = takeRaw();

  describe('[B] batched click on a dead full-zoom terminal exits AND repaints', () => {
    it('dead-session rule exits the mode and drops the zoom', () => {
      eq(getModel().modes.terminalMode, false);
      eq(api.getInstanceSlice('layout').viewMode, 'normal');
    });
    it('the batch paints a frame (was: 0 bytes — stale full-screen terminal)', () => {
      assert(clickRaw.length > 0, `painted ${clickRaw.length} bytes`);
      assert(/Info|Transcript/.test(sm.stripAnsi(clickRaw)),
             'the repainted frame shows the content strip');
    });
  });

  // ---- scenario C: switching tabs away from a live shell reclaims its cells ----
  // The overlay writes the PTY grid directly to the screen; the main diff
  // cache holds the blank interior the terminal chrome painted, so switching
  // tabs used to skip exactly the cells where the new tab is blank — the
  // shell's characters survived (user-found 2026-08-05, round 2). Decode the
  // REAL byte stream through @xterm/headless and assert the marker is gone.
  const { Terminal } = require('@xterm/headless');
  const xt = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  const gridWrite = (raw) => new Promise((res) => xt.write(raw, res));
  const gridHas = (re) => {
    for (let y = 0; y < 30; y++) {
      if (re.test(xt.buffer.active.getLine(y).translateToString(true))) return true;
    }
    return false;
  };

  await gridWrite(fullFrame());                       // seed the grid with the current screen
  const shPool = 'term-dockersh-marker';
  loop.dispatchMsg(api.wrap('layout', {
    type: 'mint_tab', paneId: container, paneType: 'terminal', poolId: shPool,
    title: 'sh:marker', config: { cmd: 'sh -c "for i in 1 2 3 4 5 6; do echo RESIDUE_$i; done; sleep 30"', label: 'sh:marker' },
    hint: { origin: 'docker-shell', item: 'marker' },
  }));
  loop.dispatchMsg(api.wrap('layout', { type: 'set_active_tab', paneId: container, tabPoolId: shPool }));
  loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: container }));
  dispatch.applyMsg({ type: 'terminal_enter' });
  await sleep(400);                                   // PTY output → overlay paints
  await gridWrite(takeRaw());
  const markerOnScreen = gridHas(/RESIDUE_/);

  stdin.emit('data', '\x1c');                         // leave terminal mode
  await sleep(50);
  await gridWrite(takeRaw());
  // Click the Transcript tab on the strip (locate it on the decoded grid).
  let stripY = -1, stripX = -1;
  for (let y = 0; y < 30; y++) {
    const s = xt.buffer.active.getLine(y).translateToString(true);
    const idx = s.indexOf('Transcript');
    if (idx >= 0) { stripY = y; stripX = idx + 3; break; }
  }
  stdin.emit('data', `\x1b[<0;${stripX + 1};${stripY + 1}M\x1b[<0;${stripX + 1};${stripY + 1}m`);
  await sleep(150);
  const switchRaw = takeRaw();
  await gridWrite(switchRaw);
  const residueAfterSwitch = gridHas(/RESIDUE_/);
  restore();

  describe('[C] tab switch away from a live shell reclaims the overlay cells', () => {
    it('precondition: the shell marker was on screen and the strip was clickable', () => {
      eq(markerOnScreen, true, 'shell output visible before the switch');
      assert(stripY >= 0, 'found the Transcript tab on the strip');
    });
    it('no shell characters survive the switch (was: residue in the new tab)', () => {
      eq(residueAfterSwitch, false, 'RESIDUE_ marker fully reclaimed');
    });
    it('the reclaim is TARGETED — row invalidation, not a full screen clear', () => {
      // The vanish reconciliation invalidates only the rows the surface
      // covered; a `\x1b[2J` here would mean the whole frame re-emitted
      // (bytes + blink over a slow link — the class this arc exists to fix).
      assert(!switchRaw.includes('\x1b[2J'), 'no full-screen clear in the switch frame');
    });
  });

  report();
})().catch((e) => { restore(); console.error(e); process.exit(1); });
