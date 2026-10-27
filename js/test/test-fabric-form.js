/**
 * Fabric multi-field FORM (args→ports slice 1) — reducer-level tests for the
 * new invoke-time overlay that opens over an action with 2+ declared ports.in.
 *
 * The overlay / render-capture tests land with commit 2 (per
 * [[feedback_render_test_new_overlays]]); this file pins the reducer contract:
 * field materialization + sort order, chip semantics, focus wrap, atomic
 * submit, cancel-is-atomic, and the standard flat-modal / outside-mode guards.
 *
 * Run: node js/test/test-fabric-form.js
 */
'use strict';

const { describe, it, eq, assert, expectNoMutation, report } = require('./test-runner');
const runtime = require('../app/runtime');

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';
  m.register = { history: [], cap: 10 };
  return m;
}

const ACTION = {
  label: 'Provision node',
  type: 'run',
  script: 'provision "$host" --role "$role" --port "$port"',
  ports: {
    in: {
      host: { type: 'string', required: true, desc: 'target hostname' },
      role: { type: 'string', required: true, desc: 'node role', default: 'worker' },
      port: { type: 'string', required: false, default: '22', desc: 'SSH port' },
      tags: { type: 'string', required: false, desc: 'comma-separated tags' },
    },
  },
};

// What the caller (action-runner, commit 3) passes on fabric_form_enter —
// pre-resolved field snapshots. Order matches declaration here; the reducer
// re-sorts by required-first.
function fieldsFor(actionKey = 'provision') {
  return [
    { port: 'host', text: '',       required: true,  default: null, desc: 'target hostname' },
    { port: 'role', text: 'worker', required: true,  default: 'worker', desc: 'node role' },
    { port: 'port', text: '22',     required: false, default: '22', desc: 'SSH port' },
    { port: 'tags', text: '',       required: false, default: null, desc: 'comma-separated tags' },
  ];
}
// confirmed:true — these tests exercise the submit arm's `do_run` path, which
// is the POST-confirm-gate open (_promptMissing). The `[a]` edit-args open
// (confirmed:false → run_action) is covered in test-edit-args-confirm-gate.js.
const PENDING = { actionKey: 'provision', action: ACTION, confirmed: true };

const inj = (m) => (m.fabric.injects[m.currentGroup] || {});

// ---- [1] enter + materialization ------------------------------------

describe('[fabric-form] enter + field materialization', () => {
  it('opens the mode + materializes fields in required-first order (frozen input)', () => {
    const m = freshModel();
    const [next] = expectNoMutation(
      'fabric_form_enter leaves the input Msg + fields untouched',
      () => runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING }),
      m,
    );
    assert(next.modes.fabricFormMode, 'mode on');
    const f = next.modal.fabricForm;
    eq(f.focusIdx, 0, 'focus starts at the first field');
    eq(f.pendingAction.actionKey, 'provision');
    const order = f.fields.map((x) => x.port);
    eq(order.join(','), 'host,role,port,tags', 'required (host,role) sorted ahead of optional (port,tags), each in declaration order');
    // chip flags computed from (text, default): host is empty+no-default → neither chip,
    // role equals its default → isDefault, port equals its default → isDefault, tags blank → neither.
    const map = Object.fromEntries(f.fields.map((x) => [x.port, x]));
    assert(!map.host.isDefault && !map.host.isModified, 'host: unset');
    assert( map.role.isDefault && !map.role.isModified, 'role: default');
    assert( map.port.isDefault && !map.port.isModified, 'port: default');
    assert(!map.tags.isDefault && !map.tags.isModified, 'tags: unset');
  });

  it('a text differing from its default enters as isModified=true', () => {
    const m = freshModel();
    const fields = [
      { port: 'host', text: 'node-7.lan', required: true,  default: null },
      { port: 'role', text: 'control',    required: true,  default: 'worker' },
    ];
    const [next] = runtime.update(m, { type: 'fabric_form_enter', fields, pendingAction: PENDING });
    const map = Object.fromEntries(next.modal.fabricForm.fields.map((x) => [x.port, x]));
    assert( map.host.isModified && !map.host.isDefault, 'host: typed');
    assert( map.role.isModified && !map.role.isDefault, 'role: overridden default');
  });

  it('is refused over a live modal (flat-modal guard)', () => {
    const m = freshModel();
    m.modes.cmdMode = true;
    const [same] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    assert(!same.modes.fabricFormMode, 'did not open over cmdline');
  });

  it('refuses an empty or missing field list', () => {
    const m = freshModel();
    const [a] = runtime.update(m, { type: 'fabric_form_enter', fields: [], pendingAction: PENDING });
    assert(!a.modes.fabricFormMode, 'empty fields → no-op');
    const [b] = runtime.update(m, { type: 'fabric_form_enter', pendingAction: PENDING });
    assert(!b.modes.fabricFormMode, 'missing fields → no-op');
  });

  // ---- Hardening (pre-release review Fork 1 R1-R3) ----

  it('accepts a numeric or boolean default and stringifies it (R1 — defense-in-depth)', () => {
    const m = freshModel();
    const fields = [
      { port: 'count',  text: '',  required: true,  default: 22 },           // number
      { port: 'enable', text: '',  required: false, default: false },        // boolean
    ];
    const [next] = runtime.update(m, { type: 'fabric_form_enter', fields, pendingAction: PENDING });
    const map = Object.fromEntries(next.modal.fabricForm.fields.map((x) => [x.port, x]));
    eq(map.count.default, '22', 'numeric default stringified');
    eq(map.enable.default, 'false', 'boolean default stringified');
  });

  it('drops null/undefined slots and entries with empty port names (R2)', () => {
    const m = freshModel();
    const fields = [
      null,
      undefined,
      { port: '', text: 'ghost', required: true },
      { port: 'real', text: 'ok',   required: true, default: null },
    ];
    const [next] = runtime.update(m, { type: 'fabric_form_enter', fields, pendingAction: PENDING });
    const ports = next.modal.fabricForm.fields.map((x) => x.port);
    eq(ports.join(','), 'real', 'only the real one survived');
  });

  it('deduplicates by port name — last-wins (R3)', () => {
    const m = freshModel();
    const fields = [
      { port: 'host', text: 'first',  required: true,  default: null },
      { port: 'host', text: 'second', required: true,  default: null },
    ];
    const [next] = runtime.update(m, { type: 'fabric_form_enter', fields, pendingAction: PENDING });
    eq(next.modal.fabricForm.fields.length, 1, 'only one survived');
    eq(next.modal.fabricForm.fields[0].text, 'second', 'last-wins');
  });

  it('after cleaning, if nothing survives the modal is not opened (R2 belt-and-suspenders)', () => {
    const m = freshModel();
    const [next] = runtime.update(m, { type: 'fabric_form_enter',
      fields: [null, { port: '' }, undefined], pendingAction: PENDING });
    assert(!next.modes.fabricFormMode, 'no modal opened when all fields are garbage');
  });

  it('set_config clears a live fabric-form (round 2 Fork 3 Finding 1 — stale pendingAction guard)', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    assert(m.modes.fabricFormMode, 'form open before set_config');
    assert(m.modal.fabricForm.pendingAction, 'pendingAction stored');
    // Swap config — the arm must drop the modal state so a stale pendingAction
    // can never fire do_run against an action removed from the new config.
    const [after] = runtime.update(m, { type: 'set_config',
      config: { groups: {}, project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {} } });
    assert(!after.modes.fabricFormMode, 'form closed by set_config');
    eq(after.modal.fabricForm.fields.length, 0, 'fields cleared');
    eq(after.modal.fabricForm.pendingAction, null, 'pendingAction dropped');
    assert(!after.modes.fabricFieldMode, 'fabric-field also cleared (same arm, same class)');
  });

  it('set_config emits cancel_effect for every in-flight choices fetch (round-2 WAL review)', () => {
    // Pre-fix the sibling fabric_form_cancel arm cancelled pending fetches
    // but set_config did not — a hot-reload while a slow choices_cmd was
    // running left the Promise closure retaining host.applyMsg + the
    // AbortController until the child settled naturally. The arm now
    // walks the fabricForm fields and emits one cancel_effect per field
    // whose computed.state === 'pending', keyed the same way the fetch
    // was dispatched (so the keyed-effects registry aborts the right one).
    let m = freshModel();
    const fields = [{
      port: 'section', text: '', required: true, default: null,
      choicesFnRef: 'edit.sections_of', dependsOn: [],
    }];
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields,
      pendingAction: { actionKey: 'edit-section', group: 'g',
                       action: { label: 'ES', type: 'run', run: 'e {{section}}',
                                 ports: { in: { section: { type: 'string', required: true,
                                                           choices_fn: 'edit.sections_of' } } } } } });
    // Drive the field into pending state.
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 1 });
    const pending = m.modal.fabricForm.fields.find((x) => x.port === 'section');
    eq(pending.computed.state, 'pending', 'field is pending before set_config');
    const [, cmds] = runtime.update(m, { type: 'set_config',
      config: { groups: {}, project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {} } });
    const cancels = (cmds || []).filter((c) => c && c.type === 'cancel_effect');
    eq(cancels.length, 1, 'exactly one cancel_effect emitted');
    assert(/^choices_fn:edit-section\.section$/.test(cancels[0].key),
      `cancel key matches fetch key, got ${JSON.stringify(cancels[0].key)}`);
  });

  it('surrogate split guard: cap never leaves a lone high surrogate at the tail (round 4 Fork 4 Finding 2)', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    // Paste 8191 `x` + two emoji (`😀` = surrogate pair, 2 UTF-16 units each).
    // The cap at 8192 would otherwise cut between the HIGH and LOW surrogate
    // of the first emoji, leaving a lone high surrogate (D83D) at the tail.
    const payload = 'x'.repeat(8191) + '\u{1F600}\u{1F600}';   // length = 8191 + 4 = 8195
    [m] = runtime.update(m, { type: 'fabric_form_key', key: 'paste', seq: payload });
    const text = m.modal.fabricForm.fields[0].text;
    assert(text.length <= 8192, `text within cap, got ${text.length}`);
    const last = text.charCodeAt(text.length - 1);
    assert(!(last >= 0xD800 && last <= 0xDBFF),
      `tail must not be a lone HIGH surrogate (got 0x${last.toString(16)}) — the guard stepped back one unit`);
  });

  it('caps a field text at 8192 UTF-16 code units on paste and sustained typing (WAL / replay bound)', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    // Paste 100KB → capped to 8KB.
    const huge = 'x'.repeat(100 * 1024);
    [m] = runtime.update(m, { type: 'fabric_form_key', key: 'paste', seq: huge });
    eq(m.modal.fabricForm.fields[0].text.length, 8192, 'paste capped');
    // Try to append more via typing — still capped.
    [m] = runtime.update(m, { type: 'fabric_form_key', key: 'a', seq: 'a' });
    eq(m.modal.fabricForm.fields[0].text.length, 8192, 'typing past the cap is a no-op (text identity preserved)');
    // Backspace still works (shrinks fine).
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '\x7f' });
    eq(m.modal.fabricForm.fields[0].text.length, 8191, 'shrink past the cap works');
  });
});

// ---- [2] key editing (focused field only) ---------------------------

describe('[fabric-form] key editing', () => {
  function open() {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    return m;
  }

  it('printable chars append to the FOCUSED field only; sibling fields unchanged', () => {
    let m = open();
    for (const c of 'node-7.lan') {
      [m] = runtime.update(m, { type: 'fabric_form_key', key: c, seq: c });
    }
    const map = Object.fromEntries(m.modal.fabricForm.fields.map((x) => [x.port, x]));
    eq(map.host.text, 'node-7.lan', 'focused field received the text');
    assert(map.host.isModified && !map.host.isDefault, 'host flipped to modified');
    eq(map.role.text, 'worker', 'sibling untouched');
    assert(map.role.isDefault && !map.role.isModified, 'sibling chip unchanged');
  });

  it('backspace trims the focused field; Ctrl+U clears it', () => {
    let m = open();
    for (const c of 'abc') [m] = runtime.update(m, { type: 'fabric_form_key', key: c, seq: c });
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '\x7f' });
    eq(m.modal.fabricForm.fields[0].text, 'ab');
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '\x15' });
    eq(m.modal.fabricForm.fields[0].text, '');
    assert(!m.modal.fabricForm.fields[0].isModified, 'empty + no default → not modified');
  });

  it('typing on a defaulted field flips isDefault → isModified; typing the default back restores isDefault', () => {
    let m = open();
    // focus is on `host` (required-first order). Move to `role` (index 1).
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
    // Append an 's' to make it 'workers'.
    [m] = runtime.update(m, { type: 'fabric_form_key', key: 's', seq: 's' });
    let role = m.modal.fabricForm.fields[1];
    eq(role.text, 'workers');
    assert(role.isModified && !role.isDefault);
    // Backspace it back to 'worker'.
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '\x7f' });
    role = m.modal.fabricForm.fields[1];
    eq(role.text, 'worker');
    assert(role.isDefault && !role.isModified, 'back to default → chip restored');
  });

  it('ignores non-printable keys the editor does not handle', () => {
    let m = open();
    const [same] = runtime.update(m, { type: 'fabric_form_key', key: 'f7' });
    assert(same === m, 'no-op → identity preserved');
  });
});

// ---- [3] focus wrap -------------------------------------------------

describe('[fabric-form] focus wrap', () => {
  function open() {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    return m;
  }

  it('focus_next advances; wraps from last → first', () => {
    let m = open();
    for (let i = 0; i < 3; i++) [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
    eq(m.modal.fabricForm.focusIdx, 3, 'at the last field');
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
    eq(m.modal.fabricForm.focusIdx, 0, 'wrapped to first');
  });

  it('focus_prev retreats; wraps from first → last', () => {
    let m = open();
    [m] = runtime.update(m, { type: 'fabric_form_focus_prev' });
    eq(m.modal.fabricForm.focusIdx, 3, 'wrapped to last');
  });
});

// ---- [4] reset_default / clear --------------------------------------

describe('[fabric-form] reset / clear', () => {
  function open() {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    // Move focus to `role` (has a default).
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
    // Edit it to a non-default value.
    for (const c of 'control') [m] = runtime.update(m, { type: 'fabric_form_key', seq: '\x7f' });
    for (const c of 'control') [m] = runtime.update(m, { type: 'fabric_form_key', key: c, seq: c });
    return m;
  }

  it('reset_default restores a defaulted field to its default value', () => {
    let m = open();
    [m] = runtime.update(m, { type: 'fabric_form_reset_default' });
    const role = m.modal.fabricForm.fields[1];
    eq(role.text, 'worker');
    assert(role.isDefault && !role.isModified, 'back to default chip');
  });

  it('reset_default on a defaultless field clears it to empty', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    // Focus host (no default); type a value.
    for (const c of 'xyz') [m] = runtime.update(m, { type: 'fabric_form_key', key: c, seq: c });
    [m] = runtime.update(m, { type: 'fabric_form_reset_default' });
    const host = m.modal.fabricForm.fields[0];
    eq(host.text, '');
    assert(!host.isDefault && !host.isModified, 'empty + no default → neither chip');
  });

  it('clear always empties the focused field', () => {
    let m = open();
    [m] = runtime.update(m, { type: 'fabric_form_clear' });
    const role = m.modal.fabricForm.fields[1];
    eq(role.text, '');
    // role has default='worker', so empty-and-not-default = isModified
    assert(role.isModified && !role.isDefault, 'clear-with-default → modified (explicit blank)');
  });
});

// ---- [5] submit (atomic + modified-only injects) --------------------

describe('[fabric-form] submit', () => {
  it('writes a one-shot inject for every MODIFIED field; nothing for defaulted/unset fields; emits do_run', () => {
    let m = freshModel();
    m.now = 1234;
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    // Type a host (modified from unset); leave role at its default; override port to '2222'; leave tags blank.
    for (const c of 'node-7.lan') [m] = runtime.update(m, { type: 'fabric_form_key', key: c, seq: c });
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });  // role
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });  // port
    for (const c of 'port') [m] = runtime.update(m, { type: 'fabric_form_key', seq: '\x7f' });  // backspace '22' (2 chars → leaves '')
    // Actually '22' is 2 chars; let me explicitly empty + retype.
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '\x15' });  // Ctrl+U
    for (const c of '2222') [m] = runtime.update(m, { type: 'fabric_form_key', key: c, seq: c });
    const [next, cmds] = runtime.update(m, { type: 'fabric_form_submit' });
    const injects = inj(next);
    eq(injects['provision.host'].value, 'node-7.lan', 'host written');
    assert(injects['provision.host'].oneShot === true, 'host is one-shot');
    eq(injects['provision.port'].value, '2222', 'port written');
    assert(!('provision.role' in injects), 'role at default → no inject');
    assert(!('provision.tags' in injects), 'tags unset → no inject');
    assert(!next.modes.fabricFormMode, 'form closed');
    eq(next.modal.fabricForm.fields.length, 0, 'buffer cleared');
    eq(cmds.length, 1, 'exactly one cmd');
    eq(cmds[0].type, 'do_run');
    eq(cmds[0].actionKey, 'provision');
  });

  it('submit without a pendingAction just closes (degenerate state, no cmd emitted)', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: null });
    const [next, cmds] = runtime.update(m, { type: 'fabric_form_submit' });
    assert(!next.modes.fabricFormMode, 'closed');
    eq(cmds.length, 0, 'no cmd');
    eq(Object.keys(inj(next)).length, 0, 'no injects written');
  });
});

// ---- [6] cancel is atomic ------------------------------------------

describe('[fabric-form] cancel', () => {
  it('cancel closes WITHOUT writing any injects — the form is atomic by construction', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    for (const c of 'typed-stuff') [m] = runtime.update(m, { type: 'fabric_form_key', key: c, seq: c });
    const [next, cmds] = runtime.update(m, { type: 'fabric_form_cancel' });
    assert(!next.modes.fabricFormMode);
    eq(Object.keys(inj(next)).length, 0, 'nothing in injects');
    eq(cmds.length, 0, 'no cmd on cancel');
  });
});

// ---- [7] outside-mode no-ops ----------------------------------------

describe('[fabric-form] outside the mode', () => {
  it('key / focus / reset / clear / submit / cancel are no-ops when fabricFormMode is off', () => {
    const m = freshModel();
    for (const type of ['fabric_form_key', 'fabric_form_focus_next', 'fabric_form_focus_prev',
                        'fabric_form_reset_default', 'fabric_form_clear',
                        'fabric_form_submit', 'fabric_form_cancel']) {
      const [same] = runtime.update(m, { type, seq: 'x' });
      assert(same === m, `${type} returns identity`);
    }
  });
});

// ---- [10] key-PATH integration — Tab / Shift-Tab actually move focus ----
//
// Round 4 Fork 2 (terminal-emulator quirks) caught a SHIPPING BLOCKER: an
// earlier draft of the dispatch handler tested `key === 'tab'`, but `input.js`
// never emits that symbolic name. A bare Tab byte arrives at the handler as
// (key='\t', seq='\t'), and Shift-Tab (\x1b[Z) was DROPPED as unknown_escape
// before any handler saw it. The reducer-level cases above all pass Msgs
// directly, which hides this class of wiring bug — the reducer worked, but
// the user could never reach it with the keyboard. These cases drive the
// FULL key path through `_dispatchToken` so the string-name typo cannot
// recur silently.

describe('[fabric-form] KEY path integration — Tab / Shift-Tab reach the reducer', () => {
  const { _dispatchToken } = require('../dispatch/control/input');
  const store = require('../model/store');
  function open() {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING });
    store.setModel(m);                  // the dispatch loop reads live model via getModel
    return m;
  }

  it('a bare Tab byte advances focus (seq === "\\t" path)', () => {
    open();
    _dispatchToken('\t');
    const after = store.getModel();
    eq(after.modal.fabricForm.focusIdx, 1, 'Tab moved focus to the second field');
  });

  it('Shift-Tab (\\x1b[Z) retreats focus (backtab path)', () => {
    open();
    _dispatchToken('\x1b[Z');
    const after = store.getModel();
    // focus wraps from 0 → last field via focus_prev
    eq(after.modal.fabricForm.focusIdx, after.modal.fabricForm.fields.length - 1,
      'Shift-Tab wrapped focus to the last field');
  });

  it('Esc still cancels via the symbolic-name path', () => {
    open();
    _dispatchToken('\x1b');
    const after = store.getModel();
    assert(!after.modes.fabricFormMode, 'Esc closed the form');
  });

  it('Enter still submits via the symbolic-name path', () => {
    open();
    _dispatchToken('\r');
    const after = store.getModel();
    assert(!after.modes.fabricFormMode, 'Enter closed the form');
  });

  it('a printable key still edits the focused field (full key-path)', () => {
    open();
    _dispatchToken('n');
    const after = store.getModel();
    eq(after.modal.fabricForm.fields[0].text, 'n', 'typed char landed on the focused field');
  });
});

// args→ports slice 2 (choices_fn) — key-path integration for the choices
// popover. Same discipline as the slice-1 Tab blocker above: the reducer
// tests drive msgs directly, but the full stack can still break on the
// `space` key wiring, so pin that end-to-end here.
describe('[fabric-form] KEY path integration — choices popover (slice 2)', () => {
  const { _dispatchToken } = require('../dispatch/control/input');
  const store = require('../model/store');

  const CF_ACTION = {
    label: 'Edit section', type: 'run', script: 'edit "$file" "$section"',
    ports: { in: {
      file:    { type: 'path',   required: true,  desc: 'target file' },
      section: { type: 'string', required: true,  desc: 'section',
                 choices_fn: 'edit.sections_of', depends_on: ['file'] },
    } },
  };
  function cfFields() {
    return [
      { port: 'file',    text: '/tmp/x.md', required: true, default: null, desc: 'target file' },
      { port: 'section', text: '',          required: true, default: null, desc: 'section',
        choicesFnRef: 'edit.sections_of', dependsOn: ['file'] },
    ];
  }
  function openPopover(items = ['intro', 'body', 'outro']) {
    let m = freshModel();
    [m] = runtime.update(m, {
      type: 'fabric_form_enter', fields: cfFields(),
      pendingAction: { actionKey: 'edit-section', action: CF_ACTION },
    });
    // Focus the section field (second).
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
    // Simulate the resolved reply so the popover has something to display.
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 1 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 1,
      items, labels: null, error: null,
    });
    store.setModel(m);
  }

  it('Space on a focused computed-choices field opens the popover (end-to-end)', () => {
    openPopover();
    _dispatchToken(' ');
    const after = store.getModel().modal.fabricForm;
    assert(after.picking, 'picking state active');
    eq(after.picking.port, 'section', 'picking the section field');
    eq(after.picking.idx, 0, 'picker idx starts at 0');
  });

  it('Space on a plain focused field is a literal space (regression guard)', () => {
    let m = freshModel();
    [m] = runtime.update(m, {
      type: 'fabric_form_enter', fields: cfFields(),
      pendingAction: { actionKey: 'edit-section', action: CF_ACTION },
    });
    store.setModel(m);   // file is the focused field — no choicesFnRef
    _dispatchToken(' ');
    const after = store.getModel().modal.fabricForm;
    eq(after.picking, null, 'picker did NOT open on the plain port');
    eq(after.fields[0].text, '/tmp/x.md ', 'the space landed as a literal character in the file field');
  });

  it('Down inside the popover moves the highlight; Enter picks it', () => {
    openPopover(['a', 'b', 'c']);
    _dispatchToken(' ');           // open
    _dispatchToken('\x1b[B');      // Down (CSI B) → idx 1
    _dispatchToken('\r');          // Enter → pick 'b'
    const after = store.getModel().modal.fabricForm;
    eq(after.picking, null, 'popover closed after pick');
    const section = after.fields.find((x) => x.port === 'section');
    eq(section.text, 'b', 'picked value landed in the field text');
  });

  it('Esc inside the popover closes without picking', () => {
    openPopover();
    _dispatchToken(' ');
    _dispatchToken('\x1b');        // Esc
    const after = store.getModel().modal.fabricForm;
    eq(after.picking, null, 'popover closed');
    const section = after.fields.find((x) => x.port === 'section');
    eq(section.text, '', 'no value picked — section stays empty');
    assert(store.getModel().modes.fabricFormMode, 'form itself is still open — Esc closed the popover, not the form');
  });

  // R1E test-gap additions — key-path cases round-1 flagged as unpinned.

  it('Space twice toggles the popover open then closed', () => {
    openPopover();
    _dispatchToken(' ');           // open
    assert(store.getModel().modal.fabricForm.picking, 'open after first space');
    _dispatchToken(' ');           // close
    eq(store.getModel().modal.fabricForm.picking, null, 'closed after second space');
  });

  it('Space on a computed field in state=error still opens the popover (error row renders)', () => {
    let m = freshModel();
    [m] = runtime.update(m, {
      type: 'fabric_form_enter', fields: cfFields(),
      pendingAction: { actionKey: 'edit-section', action: CF_ACTION },
    });
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });   // → section
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 1 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 1,
      items: [], labels: null, error: 'file not found',
    });
    store.setModel(m);
    _dispatchToken(' ');
    const after = store.getModel().modal.fabricForm;
    assert(after.picking, 'popover opens on error state too — overlay paints the error row');
    eq(after.picking.port, 'section');
  });

  it('Enter in picker with empty items (ok state) closes without picking', () => {
    let m = freshModel();
    [m] = runtime.update(m, {
      type: 'fabric_form_enter', fields: cfFields(),
      pendingAction: { actionKey: 'edit-section', action: CF_ACTION },
    });
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section', requestId: 2 });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 2,
      items: [], labels: null, error: null,
    });
    store.setModel(m);
    _dispatchToken(' ');           // open
    assert(store.getModel().modal.fabricForm.picking, 'open');
    _dispatchToken('\r');          // Enter with no items[0] to pick
    const after = store.getModel().modal.fabricForm;
    eq(after.picking, null, 'popover closed on Enter-with-empty-items');
    const section = after.fields.find((x) => x.port === 'section');
    eq(section.text, '', 'nothing picked — section stays empty');
  });

  it('printable key while picking APPENDS to picking.filter (Brief 2 type-to-filter)', () => {
    // Pre-Brief-2 behavior was close-and-fall-through on any printable; Brief 2
    // reroutes printables + backspace to picking.filter so the user can narrow
    // the list without first closing. The popover stays open; the field text
    // DOES NOT change. The filter-clear + filter-close test coverage lives in
    // test-form-choices-filter.js alongside the new reducer arms.
    openPopover(['a', 'b']);
    _dispatchToken(' ');                        // open
    _dispatchToken('n');                        // printable → filter append
    const after = store.getModel().modal.fabricForm;
    assert(after.picking, 'popover still open');
    eq(after.picking.filter, 'n', 'filter appended');
    const section = after.fields.find((x) => x.port === 'section');
    eq(section.text, '', 'field text UNCHANGED — printable no longer falls through');
  });
});

// -------------------------------------------------------------------------
// [10] fabric_form_enter PAINT-GUARANTEE — v0.6.48 BUG fix.
//
// The empty-resubmit cycle on a required-missing-port action:
//   user Enter on empty field → submit arm closes form + emits do_run →
//   setImmediate → doRun → _promptMissing → applyMsg(fabric_form_enter)
// The last applyMsg lands INSIDE a setImmediate, OUTSIDE the input
// pump's trailing-render span. Pre-fix, no paint was scheduled — the
// reopened form was invisible but alive (every subsequent key eaten
// by it). Fix: fabric_form_enter arm emits force_full_repaint + render
// Cmds so a reopen reliably paints, and the diff cache invalidation
// prevents the v0.6.33 overlay-shrink class (ghost chrome from a
// close+reopen pair).
// -------------------------------------------------------------------------

describe('[10] fabric_form_enter paint-guarantee', () => {
  it('REGRESSION — fabric_form_enter emits force_full_repaint + render Cmds', () => {
    let m = freshModel();
    const [, cmds] = runtime.update(m, { type: 'fabric_form_enter',
      fields: fieldsFor(), pendingAction: PENDING });
    const types = cmds.map((c) => c && c.type);
    assert(types.includes('force_full_repaint'),
      `fabric_form_enter must emit force_full_repaint (diff-cache invalidation ` +
      `prevents the v0.6.33 ghost-chrome class on close+reopen). Got: ${JSON.stringify(types)}`);
    assert(types.includes('render'),
      `fabric_form_enter must emit render (schedules a paint for the reopen ` +
      `path which lands inside setImmediate, outside the input pump's trailing ` +
      `render). Got: ${JSON.stringify(types)}`);
  });

  it('paint Cmds come BEFORE any initial choices fetch requests', () => {
    // Not a correctness requirement (both effects are idempotent on the
    // render-queue level), but a diagnostic one — a reader walking the
    // cmd list should see "ensure painted" before "fetch choices" so the
    // intent is obvious.
    const choicesField = {
      port: 'section', text: '', required: true, default: null, desc: '',
      choicesFnRef: 'edit.sections_of', dependsOn: [],
    };
    let m = freshModel();
    const [, cmds] = runtime.update(m, { type: 'fabric_form_enter',
      fields: [choicesField], pendingAction: PENDING });
    const types = cmds.map((c) => c && c.type);
    const paintIdx = Math.min(types.indexOf('force_full_repaint'), types.indexOf('render'));
    const fetchIdx = types.findIndex((t) => t === 'msg');
    assert(paintIdx >= 0 && fetchIdx >= 0,
      `both paint and fetch cmds expected. Got: ${JSON.stringify(types)}`);
    assert(paintIdx < fetchIdx,
      `paint cmds should precede fetch cmds. Got: ${JSON.stringify(types)}`);
  });

  it('empty-resubmit cycle: close + reopen leaves modal state consistent (model side)', () => {
    // The BUG was a paint race; the MODEL was always right. Pin that
    // explicitly here so a future refactor of the paint-guarantee doesn't
    // break the underlying close+reopen cycle. Enter → submit (no modified
    // fields) → model closes → do_run Cmd stages → simulate the reopen
    // (what doRun → _promptMissing would do).
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter',
      fields: [{ port: 'name', text: '', required: true, default: null, desc: '' }],
      pendingAction: PENDING });
    assert(m.modes.fabricFormMode, 'open');
    // Empty submit — no modified fields, so no injects written.
    const [m2, submitCmds] = runtime.update(m, { type: 'fabric_form_submit' });
    assert(!m2.modes.fabricFormMode, 'closed after submit');
    assert(submitCmds.some((c) => c && c.type === 'do_run'),
      `submit emits do_run (which would reach _promptMissing → re-enter)`);
    // Simulate the reopen that doRun → _promptMissing would do.
    const [m3, reopenCmds] = runtime.update(m2, { type: 'fabric_form_enter',
      fields: [{ port: 'name', text: '', required: true, default: null, desc: '' }],
      pendingAction: PENDING });
    assert(m3.modes.fabricFormMode, 'reopened after fabric_form_enter');
    assert(reopenCmds.some((c) => c && c.type === 'force_full_repaint'),
      `reopen must emit force_full_repaint — the paint-guarantee invariant`);
    assert(reopenCmds.some((c) => c && c.type === 'render'),
      `reopen must emit render — the paint-guarantee invariant`);
  });
});

report();
