/**
 * fabric-form (multi-field invoke popup) — mouse (docs/mouse-hit-map.md R1).
 *
 *   [1] fabric_form_focus { idx } — absolute; out-of-range is a no-op
 *   [2] click a field's input row (or its desc row) → focuses THAT field
 *   [3] chips: [tab] [shift-tab] [space] [esc] ≡ their keys
 *   [4] choices list: click a row → picks its value; [esc] chip two-step;
 *       clicking another field while it's open closes it, then focuses
 *   [5] outside click is SWALLOWED: typed text survives
 *
 * Run: node js/test/test-fabric-form-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const runtime = require('../app/runtime');
const { getModel } = runtime;

const O = 'fabric-form';
const field = (port, extra) => ({ port, text: '', required: true, default: null, desc: `${port} desc`,
  choicesFnRef: null, choicesCmd: null, choicesLabeled: false, choicesTimeout: null, dependsOn: [], choices: null, ...extra });
const FIELDS = () => [
  field('host'),
  field('svc', { choices: { items: ['nginx', 'sshd', 'cron'], labels: null, truncated: false } }),
];
const PENDING = { actionKey: 'restart', action: { label: 'Restart', type: 'run', script: 'true', ports: { in: { host: {}, svc: {} } } } };

function openForm() {
  sm.bootFresh();
  sm.resize(120, 30);
  sm.capture(() => sm.applyMsg({ type: 'fabric_form_enter', fields: FIELDS(), pendingAction: PENDING }));
  hc.paint();
}
const ff = () => getModel().modal.fabricForm;
const rowWith = (text) => hc.regions(O).find(r => r.id.startsWith('row:') && hc.paintedText(O, r.id).includes(text));

describe('[1] fabric_form_focus { idx }', () => {
  it('absolute; out-of-range / non-integer is a no-op', () => {
    let m = runtime.init();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: FIELDS(), pendingAction: PENDING });
    [m] = runtime.update(m, { type: 'fabric_form_focus', idx: 1 });
    eq(m.modal.fabricForm.focusIdx, 1);
    const before = m;
    [m] = runtime.update(m, { type: 'fabric_form_focus', idx: 7 });
    assert(m === before, 'out of range → unchanged');
    [m] = runtime.update(m, { type: 'fabric_form_focus', idx: '0' });
    assert(m === before, 'non-integer → unchanged');
  });
});

describe('[2] field rows', () => {
  it('clicking the svc input row focuses svc', () => {
    openForm();
    eq(ff().focusIdx, 0);
    hc.clickRegion(O, rowWith('svc').id);
    eq(ff().focusIdx, 1);
  });
  it('clicking a desc row focuses its field too', () => {
    openForm();
    hc.clickRegion(O, rowWith('svc desc').id);
    eq(ff().focusIdx, 1);
  });
  it('section headers / preview / help carry no row target', () => {
    openForm();
    assert(!rowWith('Required'), 'header inert');
  });
});

describe('[3] chips', () => {
  it('the form hint publishes tab / backtab / return / escape chips', () => {
    openForm();
    eq(hc.regions(O).filter(r => r.id.startsWith('chip:')).map(r => r.id).sort(),
      ['chip:\t', 'chip:backtab', 'chip:escape', 'chip:return']);
    eq(hc.paintedText(O, 'chip:backtab'), '[shift-tab] prev');
  });
  for (const [id, key, seq] of [['chip:\t', '\t', '\t'], ['chip:backtab', 'backtab', 'backtab'], ['chip:escape', 'escape', 'escape']]) {
    it(`${JSON.stringify(id)} ≡ the ${JSON.stringify(key)} key`, () => {
      openForm();
      sm.capture(() => sm.handleKey(key, seq));
      const viaKey = hc.snapshot();
      openForm();
      hc.clickRegion(O, id);
      eq(hc.snapshot(), viaKey);
    });
  }
  it('a choices field focused → a [space] choices chip that opens the list', () => {
    openForm();
    hc.clickRegion(O, rowWith('svc').id);
    hc.paint();
    assert(hc.region(O, 'chip: '), 'space chip published');
    hc.clickRegion(O, 'chip: ');
    eq(ff().picking && ff().picking.port, 'svc', 'list opened');
  });
});

describe('[4] choices list', () => {
  function openPicking() {
    openForm();
    sm.capture(() => sm.applyMsg({ type: 'fabric_form_focus', idx: 1 }));
    sm.capture(() => sm.applyMsg({ type: 'fabric_form_choices_open', port: 'svc' }));
    hc.paint();
  }
  it('clicking a choice picks that value (not the highlighted one)', () => {
    openPicking();
    hc.clickRegion(O, rowWith('cron').id);
    eq(ff().picking, null, 'list closed');
    eq(ff().fields.find(x => x.port === 'svc').text, 'cron');
  });
  it('the [esc] chip closes the list (not the form)', () => {
    openPicking();
    hc.clickRegion(O, 'chip:escape');
    eq(ff().picking, null);
    eq(getModel().modes.fabricFormMode, true, 'form still open');
  });
  it('wheel steps the highlighted choice', () => {
    openPicking();
    hc.wheelRegion(O, 'box', 'down');
    eq(ff().picking.idx, 1);
  });
  it('clicking another field closes the list, then focuses that field', () => {
    openPicking();
    hc.clickRegion(O, rowWith('host').id);
    eq(ff().picking, null);
    eq(ff().focusIdx, 0);
  });
});

describe('[5] outside', () => {
  it('is swallowed: still open, typed text intact', () => {
    openForm();
    for (const ch of 'web1') sm.capture(() => sm.handleKey(ch, ch));
    hc.paint();
    hc.click(0, 0);
    hc.click(0, 0, 2);
    eq(getModel().modes.fabricFormMode, true);
    eq(ff().fields[0].text, 'web1');
  });
});

report();
