/**
 * Brief 3 (v0.6.43) — last-used value prefill for form ports (`[last]` chip).
 *
 * Covers four surfaces that need to agree:
 *   - Reducer: `fabric_form_submit` writes model.formHistory (per-port,
 *     LRU-bounded, remember-opt-out honored); `fabric_form_enter` of a
 *     seeded field normalizes with isLast=true + isModified=true;
 *     `fabric_form_key` on a [last] field clears isLast (chip flips to
 *     [modified] on the next render).
 *   - Builder (`_buildFormField` via openPortsForm): precedence resolved
 *     > last > default > empty; isLast only when text actually came from
 *     history; remember:false opts out at READ time too.
 *   - Overlay: `[last]` paints under accent when isLast=true (render-
 *     capture, not source grep).
 *   - Parser: `remember: boolean` passes; `remember: "yes"` / `remember: 1`
 *     warn-drop with code 'port.bad_remember' (strict boolean, no truthy
 *     coercion).
 *
 * Also pins the two must-not-regress invariants from the brief:
 *   - A [last]-seeded field the user does NOT touch STILL writes a
 *     one-shot inject on submit (otherwise the chip would lie — form
 *     paints the memory, spawn falls back to decl default).
 *   - set_config clears formHistory (the action universe just changed;
 *     stale pre-fills under `[last]` against a redefined action is
 *     exactly the trap the brief calls out).
 *
 * Run: node js/test/test-form-history-last.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const store = require('../model/store');
const { validate } = require('../parser/schema');
const actionRunner = require('../dispatch/runtime/action-runner');
const { freshOverlayModel, captureOverlay } = require('./_helpers/overlay-capture');
const { renderFabricFormOverlay } = require('../overlay/fabric-form');

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';
  m.register = { history: [], cap: 10 };
  return m;
}

// Build a minimal field shape that mirrors what action-runner._buildFormField
// produces — the reducer tests drive fabric_form_enter directly with these.
function field(opts) {
  return {
    port: opts.port,
    text: opts.text || '',
    required: opts.required !== false,
    default: opts.default != null ? String(opts.default) : null,
    desc: opts.desc || '',
    isLast: !!opts.isLast,
    remember: !(opts.remember === false),
  };
}

const PENDING = (actionKey = 'session.worktree') => ({
  actionKey,
  action: { label: 'wt', type: 'run', run: 'git worktree add {{dir}} {{branch}}',
            ports: { in: { dir: { type: 'string', required: true },
                           branch: { type: 'string', required: true } } } },
});

function openForm(m, fields, pending) {
  const [next] = runtime.update(m, { type: 'fabric_form_enter',
    fields, pendingAction: pending || PENDING() });
  return next;
}

function submit(m) {
  const [next] = runtime.update(m, { type: 'fabric_form_submit' });
  return next;
}

const injectsFor = (m, actionKey) => {
  const g = (m.fabric && m.fabric.injects && m.fabric.injects[m.currentGroup]) || {};
  const out = {};
  for (const [addr, rec] of Object.entries(g)) {
    if (addr.startsWith(actionKey + '.')) out[addr.slice(actionKey.length + 1)] = rec;
  }
  return out;
};

// ---- [1] submit WRITES formHistory ------------------------------------

describe('[form-history] submit writes model.formHistory per-action', () => {
  it('a modified field is remembered under its actionKey', () => {
    let m = freshModel();
    m = openForm(m, [
      field({ port: 'dir',    text: '/srv/repo',   required: true }),
      field({ port: 'branch', text: 'feature/x',   required: true }),
    ]);
    m = submit(m);
    const entry = m.formHistory.entries['session.worktree'];
    assert(entry, 'actionKey landed in formHistory');
    eq(entry.dir, '/srv/repo', 'dir remembered');
    eq(entry.branch, 'feature/x', 'branch remembered');
    const order = m.formHistory.order;
    eq(order[order.length - 1], 'session.worktree', 'MRU-promoted');
  });

  it('an unmodified non-empty field (text equals default) IS remembered — brief: "fields left at a non-empty value"', () => {
    let m = freshModel();
    m = openForm(m, [
      field({ port: 'branch', text: 'main', required: true, default: 'main' }),   // == default, non-empty
      field({ port: 'dir',    text: '/srv', required: true }),
    ]);
    m = submit(m);
    const entry = m.formHistory.entries['session.worktree'];
    assert(entry, 'actionKey present');
    eq(entry.branch, 'main', 'default-equal non-empty IS remembered (pins memory against future default changes)');
    eq(entry.dir, '/srv', 'and dir');
  });

  it('an empty field with no default is skipped (nothing worth remembering)', () => {
    let m = freshModel();
    m = openForm(m, [
      field({ port: 'maybe', text: '', required: false, default: null }),
      field({ port: 'dir',   text: '/srv', required: true }),
    ]);
    m = submit(m);
    const entry = m.formHistory.entries['session.worktree'];
    assert(entry, 'actionKey present');
    assert(!('maybe' in entry), 'empty-no-default: skipped');
    eq(entry.dir, '/srv', 'other field remembered');
  });

  it('remember:false opts a port OUT at write time', () => {
    let m = freshModel();
    m = openForm(m, [
      field({ port: 'dir',    text: '/srv/repo',  required: true }),
      field({ port: 'secret', text: 'p@ssw0rd',   required: true, remember: false }),
    ]);
    m = submit(m);
    const entry = m.formHistory.entries['session.worktree'];
    assert(entry, 'something landed');
    eq(entry.dir, '/srv/repo', 'dir remembered');
    assert(!('secret' in entry), 'secret NOT remembered — remember:false honored');
  });

  it('submit with EVERY port skipped writes no entry (empty-entry suppressed)', () => {
    let m = freshModel();
    m = openForm(m, [
      field({ port: 'secret', text: 'p@ssw0rd', required: true, remember: false }),
      field({ port: 'empty',  text: '',         required: false, default: null }),
    ]);
    m = submit(m);
    assert(!m.formHistory.entries['session.worktree'],
      'actionKey absent — no persistent empty slot');
    eq(m.formHistory.order.length, 0, 'order untouched');
  });

  it('LRU cap: inserting the 65th actionKey evicts the oldest', () => {
    let m = freshModel();
    for (let i = 0; i < 64; i++) {
      m = openForm(m, [field({ port: 'x', text: `v${i}`, required: true })], PENDING(`act.${i}`));
      m = submit(m);
    }
    eq(Object.keys(m.formHistory.entries).length, 64, 'at cap');
    assert(m.formHistory.entries['act.0'], 'oldest still present pre-overflow');
    m = openForm(m, [field({ port: 'x', text: 'new', required: true })], PENDING('act.65'));
    m = submit(m);
    eq(Object.keys(m.formHistory.entries).length, 64, 'still at cap after overflow');
    assert(!m.formHistory.entries['act.0'], 'act.0 evicted — LRU-most dropped');
    assert(m.formHistory.entries['act.65'], 'act.65 present — MRU added');
  });

  it('resubmit of same actionKey updates in place + promotes MRU', () => {
    let m = freshModel();
    m = openForm(m, [field({ port: 'x', text: 'v1', required: true })], PENDING('other'));
    m = submit(m);
    m = openForm(m, [field({ port: 'x', text: 'v2', required: true })]);
    m = submit(m);
    eq(m.formHistory.entries['session.worktree'].x, 'v2', 'overwritten');
    const order = m.formHistory.order;
    eq(order[order.length - 1], 'session.worktree', 'MRU is session.worktree');
    eq(Object.keys(m.formHistory.entries).length, 2, 'both kept');
  });
});

// ---- [2] [last] seed + chip + inject ---------------------------------

describe('[form-history] [last] seeded field is isLast + inject-worthy', () => {
  it('a field entered with isLast=true normalizes with isLast=true', () => {
    let m = freshModel();
    m = openForm(m, [
      field({ port: 'dir', text: '/srv/repo', isLast: true, required: true }),
    ]);
    const f = m.modal.fabricForm.fields[0];
    assert(f.isLast, 'isLast carried through normalization');
    assert(f.isModified, 'differs from default (null) → isModified=true');
    assert(!f.isDefault, 'not default');
  });

  it('overlay chip renderer paints `[last]` for an isLast field (render-capture)', () => {
    // True render-capture, not source grep — [[feedback_render_test_new_overlays]]
    // wants the pixels, not the regex. Boot a wide model so the chip never
    // gets truncated out, open the form with a [last]-seeded field, capture
    // the overlay output.
    const m = freshOverlayModel({ cols: 120, rows: 30 });
    m.currentGroup = 'g';
    const [m2] = runtime.update(m, { type: 'fabric_form_enter',
      fields: [field({ port: 'dir', text: '/srv/repo', isLast: true, required: true })],
      pendingAction: PENDING() });
    const out = captureOverlay(m2, () => renderFabricFormOverlay());
    assert(out.includes('[last]'), `overlay should paint "[last]" chip; got: ${JSON.stringify(out.slice(0, 400))}`);
    assert(!out.includes('[modified]'), 'should NOT paint [modified] on an unedited [last] field');
    assert(!out.includes('[default]'), 'should NOT paint [default]');
  });

  it('after an edit, overlay paints `[modified]` instead of `[last]`', () => {
    let m = freshOverlayModel({ cols: 120, rows: 30 });
    m.currentGroup = 'g';
    [m] = runtime.update(m, { type: 'fabric_form_enter',
      fields: [field({ port: 'dir', text: '/srv/repo', isLast: true, required: true })],
      pendingAction: PENDING() });
    [m] = runtime.update(m, { type: 'fabric_form_key', key: 'z', seq: 'z' });
    const out = captureOverlay(m, () => renderFabricFormOverlay());
    assert(!out.includes('[last]'), 'edit must flip the chip off [last]');
    assert(out.includes('[modified]'), `expected [modified] after edit; got: ${JSON.stringify(out.slice(0, 400))}`);
  });

  it('a [last]-seeded field UNTOUCHED still writes a one-shot inject on submit', () => {
    let m = freshModel();
    m = openForm(m, [
      field({ port: 'dir', text: '/srv/repo', isLast: true, required: true, default: null }),
    ]);
    m = submit(m);
    const injs = injectsFor(m, 'session.worktree');
    assert(injs.dir, 'untouched [last] field STILL injected on submit');
    eq(injs.dir.value, '/srv/repo', 'inject carries the remembered text');
    assert(injs.dir.oneShot, 'one-shot inject (consumed by the run)');
  });

  it('editing a [last]-seeded field clears isLast (next frame would show [modified])', () => {
    let m = freshModel();
    m = openForm(m, [
      field({ port: 'dir', text: '/srv/repo', isLast: true, required: true, default: null }),
    ]);
    assert(m.modal.fabricForm.fields[0].isLast, 'pre-edit: isLast=true');
    const [next] = runtime.update(m, { type: 'fabric_form_key', key: 'a', seq: 'a' });
    const f = next.modal.fabricForm.fields[0];
    assert(!f.isLast, 'post-edit: isLast cleared');
    assert(f.isModified, 'still differs from default → [modified] takes over');
  });
});

// ---- [3] _buildFormField precedence (via openPortsForm → reducer) ----

describe('[form-history] openPortsForm precedence resolved > last > default > empty', () => {
  // openPortsForm reads model.formHistory via getModel() and dispatches
  // fabric_form_enter. We seed getModel() with a doctored model carrying
  // a formHistory entry, call openPortsForm, and read the normalized
  // fields the reducer stamped onto model.modal.fabricForm.fields.
  function openFor(historyEntry, resolvedValues, inputs) {
    const m = runtime.init();
    m.currentGroup = 'g';
    m.formHistory = { entries: historyEntry ? { 'act.k': historyEntry } : {},
                      order: historyEntry ? ['act.k'] : [], cap: 64 };
    store.setModel(m);
    actionRunner.openPortsForm('act.k',
      { ports: { in: inputs } },
      { values: resolvedValues || {}, missing: [], sources: {} });
    const after = store.getModel();
    assert(after.modes && after.modes.fabricFormMode, 'form opened');
    return after.modal.fabricForm.fields;
  }

  it('resolved value wins over history + default', () => {
    const fields = openFor(
      { p: 'HISTORY' },
      { p: 'RESOLVED' },
      { p: { type: 'string', required: true, default: 'DEFAULT' } });
    const f = fields.find((x) => x.port === 'p');
    eq(f.text, 'RESOLVED', 'resolved wins');
    assert(!f.isLast, 'isLast NOT set — text came from resolve, not history');
  });

  it('history wins over default when no resolved value', () => {
    const fields = openFor(
      { p: 'HISTORY' },
      {},
      { p: { type: 'string', required: true, default: 'DEFAULT' } });
    const f = fields.find((x) => x.port === 'p');
    eq(f.text, 'HISTORY', 'history beats default');
    assert(f.isLast, 'isLast=true — text came from history');
  });

  it('default wins over empty when no history', () => {
    const fields = openFor(
      null,
      {},
      { p: { type: 'string', required: true, default: 'DEFAULT' } });
    const f = fields.find((x) => x.port === 'p');
    eq(f.text, 'DEFAULT', 'default used');
    assert(!f.isLast, 'isLast NOT set');
  });

  it('empty when nothing seeds it', () => {
    const fields = openFor(
      null,
      {},
      { p: { type: 'string', required: true } });
    const f = fields.find((x) => x.port === 'p');
    eq(f.text, '', 'empty');
    assert(!f.isLast, 'isLast NOT set');
  });

  it('remember:false opts a port OUT at READ time too (defense-in-depth)', () => {
    const fields = openFor(
      { p: 'HISTORY' },                                    // history HAS a slot
      {},
      { p: { type: 'string', required: true, default: 'DEFAULT', remember: false } });
    const f = fields.find((x) => x.port === 'p');
    eq(f.text, 'DEFAULT', 'remember:false ignores a stray history slot (opt-out at read)');
    assert(!f.isLast, 'isLast NOT set under opt-out');
    assert(!f.remember, 'remember flag carried through to the normalized field');
  });
});

// ---- [4] set_config clears formHistory -------------------------------

describe('[form-history] set_config clears formHistory', () => {
  it('after a set_config, previously-remembered entries are gone', () => {
    let m = freshModel();
    m = openForm(m, [field({ port: 'dir', text: '/srv/repo', required: true })]);
    m = submit(m);
    assert(m.formHistory.entries['session.worktree'], 'pre-swap entry present');
    const [after] = runtime.update(m, { type: 'set_config',
      config: { groups: {}, project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {} } });
    eq(Object.keys(after.formHistory.entries).length, 0, 'entries cleared');
    eq(after.formHistory.order.length, 0, 'order cleared');
    eq(after.formHistory.cap, 64, 'cap preserved');
  });
});

// ---- [5] parser `remember` validation --------------------------------

describe('[form-history] parser accepts remember:boolean, warn-drops non-bool', () => {
  function cfgWithRemember(val) {
    return {
      groups: {
        g: {
          label: 'g',
          actions: {
            run: {
              label: 'r', cmd: 'echo "$arg"',
              ports: { in: { arg: { type: 'string', required: true, remember: val } } },
            },
          },
        },
      },
    };
  }

  it('remember:true loads cleanly (no warning); key preserved', () => {
    const w = [];
    const cfg = cfgWithRemember(true);
    validate(cfg, undefined, w);
    assert(!w.some((x) => x.code === 'port.bad_remember'),
      `no bad_remember warning expected, got: ${JSON.stringify(w)}`);
    eq(cfg.groups.g.actions.run.ports.in.arg.remember, true, 'remember:true preserved');
  });
  it('remember:false loads cleanly (no warning); key preserved', () => {
    const w = [];
    const cfg = cfgWithRemember(false);
    validate(cfg, undefined, w);
    assert(!w.some((x) => x.code === 'port.bad_remember'),
      `no bad_remember warning expected, got: ${JSON.stringify(w)}`);
    eq(cfg.groups.g.actions.run.ports.in.arg.remember, false,
      'remember:false preserved — the field remembers the opt-out at build time');
  });
  it('remember:"yes" is dropped with a bad_remember warning', () => {
    const w = [];
    const cfg = cfgWithRemember('yes');
    validate(cfg, undefined, w);
    assert(w.some((x) => x.code === 'port.bad_remember' && /string/.test(x.message)),
      `expected port.bad_remember naming "string", got: ${JSON.stringify(w)}`);
    assert(!('remember' in cfg.groups.g.actions.run.ports.in.arg),
      'bad remember dropped from the schema in-place');
  });
  it('remember:1 is dropped with a bad_remember warning (no truthy coercion)', () => {
    const w = [];
    const cfg = cfgWithRemember(1);
    validate(cfg, undefined, w);
    assert(w.some((x) => x.code === 'port.bad_remember' && /number/.test(x.message)),
      `expected port.bad_remember naming "number", got: ${JSON.stringify(w)}`);
    assert(!('remember' in cfg.groups.g.actions.run.ports.in.arg),
      'bad remember dropped from the schema in-place');
  });
});

report();
