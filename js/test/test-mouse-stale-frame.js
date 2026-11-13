/**
 * Stale-frame rule, end to end through the REAL stdin chunk handler
 * (input._makeDataHandler → tokenizer → render-queue batch → handleMouse →
 * mouse-router). A multi-token chunk paints ONCE at the end, so a click batched
 * behind a key resolves while the screen still shows the PRE-key frame
 * (docs/mouse-hit-map.md §Stale-frame rule; pre-release review C1/C3/F1/F2).
 *
 *   [1] `n` + click inside confirm: confirm closes; the click does NOT reach the
 *       pane the popup covered (was: focus moved to the pane beneath)
 *   [2] Enter (menu → submenu in place, same mode) + click on the row the user
 *       SAW: swallowed — no port injection, no copy (was: injected into a port
 *       the user never saw)
 *   [3] fabric-form Space (opens choices) + click another field: swallowed —
 *       never the unreachable "list open on svc, focus on host" state
 *   [4] stale frame that drew NOTHING under the pointer: the legacy cascade
 *       still decides (pane-menu dropdown closed by Esc, click on a pane)
 *
 * Run: node js/test/test-mouse-stale-frame.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { EventEmitter } = require('events');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const input = require('../dispatch/control/input');
const api = sm.api;
const { getModel } = require('../app/runtime');

const sgr = (mx, my) => `\x1b[<0;${mx + 1};${my + 1}M`;
// Feed ONE stdin chunk through the production data handler.
function chunk(bytes) {
  const stdin = new EventEmitter();
  const h = input._makeDataHandler(stdin);
  stdin.on('data', h);
  input._classifyPress(0, 250, 90, Date.now());   // no accidental double pairing
  sm.capture(() => h(bytes));
}

describe('[1] confirm: `n` + click inside the box', () => {
  it('confirm closes; the click is swallowed, focus unchanged', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    sm.capture(() => sm.applyMsg({ type: 'confirm_enter', message: 'Delete everything?', cmd: null }));
    hc.paint();
    const box = hc.region('confirm', 'box').rect;
    const focus = api.getInstanceSlice('layout').focus;
    chunk('n' + sgr(box.x + box.w - 3, box.y + 2));
    eq(getModel().modes.confirmMode, false, '`n` rejected');
    eq(api.getInstanceSlice('layout').focus, focus, 'no focus change behind the vanished popup');
  });
});

describe('[2] menu replaced in place: Enter + click', () => {
  it('the click aimed at "Copy line" does not activate the replacement menu', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    require('../dispatch/runtime/host-wiring').wireFabricHost();
    const ports = require('../fabric/ports');
    const realList = ports.listPorts;
    ports.listPorts = () => [
      { dir: 'in', component: 'db', port: 'drop_table', type: 'text' },
      { dir: 'in', component: 'svc', port: 'note', type: 'text' },
    ];
    try {
      getModel().register = { history: [], cap: 100 };
      const items = [['Send selection to port…', 'send_to_port', 'hello'], ['Copy line', 'copy_text', 'line'], ['Copy word', 'copy_text', 'word']];
      sm.capture(() => sm.applyMsg({ type: 'menu_open', items, title: 'Actions', anchor: { x: 20, y: 5 } }));
      hc.paint();
      eq(hc.paintedText('menu', 'row:1').trim(), 'Copy line');
      const r1 = hc.region('menu', 'row:1').rect;
      chunk('\r' + sgr(r1.x + 3, r1.y));
      const injects = (getModel().fabric && getModel().fabric.injects) || {};
      eq(JSON.stringify(injects).includes('hello'), false, 'no injection into an unseen port');
      eq(getModel().register.history, [], 'nothing copied either');
    } finally { ports.listPorts = realList; }
  });
});

describe('[3] fabric-form: Space + click another field', () => {
  it('swallowed — no list-open-on-one-field / focus-on-another state', () => {
    const field = (port, extra) => ({ port, text: '', required: true, default: null, desc: `${port} desc`,
      choicesFnRef: null, choicesCmd: null, choicesLabeled: false, choicesTimeout: null, dependsOn: [], choices: null, ...extra });
    sm.bootFresh();
    sm.resize(120, 30);
    sm.capture(() => sm.applyMsg({ type: 'fabric_form_enter', pendingAction: { actionKey: 'restart', action: { label: 'Restart', type: 'run', script: 'true', ports: { in: { host: {}, svc: {} } } } },
      fields: [field('host'), field('svc', { choices: { items: ['nginx', 'sshd'], labels: null, truncated: false } })] }));
    sm.capture(() => sm.applyMsg({ type: 'fabric_form_focus', idx: 1 }));
    hc.paint();
    const host = hc.regions('fabric-form').find(r => r.id.startsWith('row:') && hc.paintedText('fabric-form', r.id).includes('host')).rect;
    chunk(' ' + sgr(host.x + 3, host.y));
    const f = getModel().modal.fabricForm;
    assert(f.picking && f.picking.port === 'svc', 'Space opened the list (the key ran)');
    eq(f.focusIdx, 1, 'focus stayed on svc — the stale click did not refocus host under an open list');
  });
});

describe('[4] stale frame drew nothing there → legacy decides', () => {
  it('pane-menu closed by T, click on a pane outside the dropdown → focus moves (as before)', () => {
    // pane-menu's outside-close is a below-chrome backdrop (R2), but an
    // INVISIBLE one: it does not count as drawn for the stale rule, so the
    // stale frame drew nothing under this point and legacy decides.
    sm.bootFresh();
    sm.resize(120, 30);
    sm.capture(() => api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups', cursor: 0, scroll: 0 })));
    hc.paint();
    const geo = require('../leaves/wm/geometry');
    const b = geo.visibleBoundsFor(api.getInstanceSlice('layout'), 'pane-detail');
    assert(b, 'detail pane visible');
    assert(!require('../panel/hit-map').claims(b.x + 3, b.y + b.h - 3), 'precondition: nothing drawn there claims it');
    // `T` closes the dropdown (a batched bare Esc + CSI is ambiguous to the tokenizer).
    chunk('T' + sgr(b.x + 3, b.y + b.h - 3));
    eq(getModel().modes.paneMenuMode, false, '`T` closed the dropdown');
    eq(api.getInstanceSlice('layout').focus, 'pane-detail', 'the click focused the pane the user saw');
  });
  it('`+` (view expand) + a click on a pane body → no region there, legacy focuses what is under it now', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    sm.capture(() => api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'normal' })));
    hc.paint();
    const geo = require('../leaves/wm/geometry');
    const b = geo.visibleBoundsFor(api.getInstanceSlice('layout'), 'pane-detail');
    const mx = b.x + 3, my = b.y + b.h - 3;
    assert(!require('../panel/hit-map').claims(mx, my), 'precondition: no region drawn there');
    chunk('+' + sgr(mx, my));
    eq(api.getInstanceSlice('layout').viewMode, 'half', 'the key ran (geometry changed → stale)');
    const now = geo.visibleBoundsFor(api.getInstanceSlice('layout'), 'pane-detail');
    if (now && mx >= now.x && mx < now.x + now.w && my >= now.y && my < now.y + now.h) {
      eq(api.getInstanceSlice('layout').focus, 'pane-detail', 'legacy focused the pane now under the pointer');
    }
    sm.capture(() => api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'normal' })));
  });
});

report();
