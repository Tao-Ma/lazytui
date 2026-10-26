/**
 * Replay WAL round-trip for `fabric_form_choices_resolved` — the Msg both
 * `fetch_choices_fn` and `fetch_choices_cmd` effect runtimes dispatch when
 * their fetch settles.
 *
 * Why: slice 2 (choices_fn) and slice 3 (choices_cmd) added two sibling
 * effect families whose resolved payloads carry {items, labels, error,
 * truncated} across the WAL boundary. The fabric-form arm (dispatch/update/
 * modal/fabric-form.js:531 "fabric_form_choices_resolved") has a cap-on-
 * replay guard precisely because "a pre-R1 WAL where the recorded payload is
 * un-capped" was a known class — but no test ever folded one of these Msgs
 * through replayEntries to verify the payload survives round-trip. This file
 * closes that gap, directly implementing [[feedback_sibling_channel_parity_sweep]]
 * for the replay dimension: both channels' payloads must land identically.
 *
 * Pattern (modeled on test-fabric-replay.js): snapshot a minimal model with
 * fabric form open + fetching field, fold a WAL containing the resolved Msg,
 * assert reconstructed field.computed matches.
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { init, setModel, getModel } = require('../app/runtime');
const replay = require('../dispatch/runtime/replay');

/**
 * Seed a model with the fabric form open + a single "fetching" port.
 * Both choices_fn and choices_cmd end up in the same `fabric_form_choices_resolved`
 * arm, so one seed covers both channels; the `channel` + `choicesCmd` flags
 * only parameterize the cap applied on resolution.
 */
function seedFetching({ actionKey, port, channel }) {
  const m = init();
  m.currentGroup = 'g';
  m.modes.fabricFormMode = true;
  m.modal.fabricForm = {
    fields: [{
      port,
      text: '',
      isDefault: false,
      isModified: false,
      required: true,
      default: '',
      desc: '',
      choicesCmd: channel === 'cmd',          // paces the cap (32 vs 1024)
      computed: {
        state: 'fetching',
        requestId: 1,
        items: [],
        labels: null,
        error: null,
        truncated: false,
      },
    }],
    focusIdx: 0,
    pendingAction: { actionKey, action: {} },
    picking: null,
    requestSeq: 1,
  };
  setModel(m);
  return m;
}

function resolvedField() {
  return getModel().modal.fabricForm.fields[0];
}

describe('[replay] fabric_form_choices_resolved — WAL round-trip for choices_fn payload', () => {
  it('items + labels round-trip through replay to the field.computed', () => {
    const snap = (() => {
      seedFetching({ actionKey: 'enable', port: 'name', channel: 'fn' });
      return replay.snapshotState();
    })();

    const WAL = [{
      kind: 'msg', lane: 'root',
      msg: {
        type: 'fabric_form_choices_resolved',
        port: 'name',
        actionKey: 'enable',
        requestId: 1,
        items: ['nginx', 'sshd', 'postgres'],
        labels: ['Nginx', 'SSHd', 'PostgreSQL'],
        error: null,
        truncated: false,
      },
    }];

    replay.replayEntries(WAL, { fromState: snap });

    const f = resolvedField();
    eq(f.computed.state, 'ok', 'state advanced from fetching → ok');
    eq(f.computed.items, ['nginx', 'sshd', 'postgres'], 'items survive round-trip');
    eq(f.computed.labels, ['Nginx', 'SSHd', 'PostgreSQL'], 'labels survive round-trip');
    eq(f.computed.error, null, 'error null preserved');
    eq(f.computed.truncated, false, 'truncated flag preserved');
    eq(f.computed.requestId, 1, 'requestId preserved (guard key)');
  });

  it('error payload round-trips (fetch failed → state=error, items=[], error=string)', () => {
    const snap = (() => {
      seedFetching({ actionKey: 'enable', port: 'name', channel: 'fn' });
      return replay.snapshotState();
    })();
    const WAL = [{
      kind: 'msg', lane: 'root',
      msg: {
        type: 'fabric_form_choices_resolved',
        port: 'name', actionKey: 'enable', requestId: 1,
        items: [], labels: null,
        error: 'choices_fn threw: TypeError: x is not a function',
        truncated: false,
      },
    }];
    replay.replayEntries(WAL, { fromState: snap });
    const f = resolvedField();
    eq(f.computed.state, 'error', 'error state landed');
    eq(f.computed.items, [], 'items empty on error');
    assert(/choices_fn threw/.test(f.computed.error || ''), `error carries message, got: ${f.computed.error}`);
  });

  it('un-capped pre-R1 payload (1500 items on fn channel) gets re-capped on replay to 1024', () => {
    // The arm's belt-and-suspenders cap for a pre-R1 WAL. choices_fn cap is 1024.
    const snap = (() => {
      seedFetching({ actionKey: 'enable', port: 'name', channel: 'fn' });
      return replay.snapshotState();
    })();
    const giant = [];
    for (let i = 0; i < 1500; i++) giant.push(`item-${i}`);
    const WAL = [{
      kind: 'msg', lane: 'root',
      msg: {
        type: 'fabric_form_choices_resolved',
        port: 'name', actionKey: 'enable', requestId: 1,
        items: giant, labels: null, error: null, truncated: false,
      },
    }];
    replay.replayEntries(WAL, { fromState: snap });
    const f = resolvedField();
    eq(f.computed.items.length, 1024, 'fn channel re-capped to 1024 on replay');
    eq(f.computed.truncated, true, 'truncated flipped to true by the cap');
  });
});

describe('[replay] fabric_form_choices_resolved — WAL round-trip for choices_cmd payload', () => {
  it('items + labels round-trip identically to the fn channel (sibling parity)', () => {
    const snap = (() => {
      seedFetching({ actionKey: 'restart', port: 'service', channel: 'cmd' });
      return replay.snapshotState();
    })();
    const WAL = [{
      kind: 'msg', lane: 'root',
      msg: {
        type: 'fabric_form_choices_resolved',
        port: 'service', actionKey: 'restart', requestId: 1,
        items: ['nginx', 'sshd'],
        labels: ['Nginx (web)', 'SSH (daemon)'],
        error: null, truncated: false,
      },
    }];
    replay.replayEntries(WAL, { fromState: snap });
    const f = resolvedField();
    eq(f.computed.state, 'ok', 'cmd channel state advanced from fetching → ok');
    eq(f.computed.items, ['nginx', 'sshd'], 'cmd items round-trip');
    eq(f.computed.labels, ['Nginx (web)', 'SSH (daemon)'], 'cmd labels round-trip');
  });

  it('cmd channel caps at 32 on replay (tighter than fn\'s 1024)', () => {
    // Slice-3 rationale: humans scan ≤32, past that author must narrow at the shell.
    const snap = (() => {
      seedFetching({ actionKey: 'restart', port: 'service', channel: 'cmd' });
      return replay.snapshotState();
    })();
    const forty = [];
    for (let i = 0; i < 40; i++) forty.push(`svc-${i}`);
    const WAL = [{
      kind: 'msg', lane: 'root',
      msg: {
        type: 'fabric_form_choices_resolved',
        port: 'service', actionKey: 'restart', requestId: 1,
        items: forty, labels: null, error: null, truncated: false,
      },
    }];
    replay.replayEntries(WAL, { fromState: snap });
    const f = resolvedField();
    eq(f.computed.items.length, 32, 'cmd channel capped to 32 on replay');
    eq(f.computed.truncated, true, 'truncated flipped to true by the cap');
    eq(f.computed.items[0], 'svc-0', 'first items kept in order');
    eq(f.computed.items[31], 'svc-31', 'last kept item is 31 (zero-indexed)');
  });

  it('truncated flag survives round-trip when the recorded payload was already capped', () => {
    const snap = (() => {
      seedFetching({ actionKey: 'restart', port: 'service', channel: 'cmd' });
      return replay.snapshotState();
    })();
    const WAL = [{
      kind: 'msg', lane: 'root',
      msg: {
        type: 'fabric_form_choices_resolved',
        port: 'service', actionKey: 'restart', requestId: 1,
        items: ['a', 'b'], labels: null, error: null,
        truncated: true,              // recorded with truncated already true
      },
    }];
    replay.replayEntries(WAL, { fromState: snap });
    const f = resolvedField();
    eq(f.computed.truncated, true, 'truncated=true from the WAL survives (no false-flip)');
    eq(f.computed.items.length, 2, 'small items array passes through un-capped');
  });
});

describe('[replay] stale-reply guards fire on replay too (defense-in-depth)', () => {
  it('msg.actionKey mismatch → arm drops payload; computed stays "fetching"', () => {
    const snap = (() => {
      seedFetching({ actionKey: 'enable', port: 'name', channel: 'fn' });
      return replay.snapshotState();
    })();
    const WAL = [{
      kind: 'msg', lane: 'root',
      msg: {
        type: 'fabric_form_choices_resolved',
        port: 'name',
        actionKey: 'disable',       // doesn't match 'enable'
        requestId: 1,
        items: ['leaked'], labels: null, error: null, truncated: false,
      },
    }];
    replay.replayEntries(WAL, { fromState: snap });
    const f = resolvedField();
    eq(f.computed.state, 'fetching', 'cross-form actionKey mismatch dropped on replay');
    eq(f.computed.items, [], 'leaked items did NOT land');
  });

  it('msg.requestId mismatch → arm drops payload', () => {
    const snap = (() => {
      seedFetching({ actionKey: 'enable', port: 'name', channel: 'fn' });
      return replay.snapshotState();
    })();
    const WAL = [{
      kind: 'msg', lane: 'root',
      msg: {
        type: 'fabric_form_choices_resolved',
        port: 'name', actionKey: 'enable',
        requestId: 999,                      // field's current.requestId is 1
        items: ['stale'], labels: null, error: null, truncated: false,
      },
    }];
    replay.replayEntries(WAL, { fromState: snap });
    const f = resolvedField();
    eq(f.computed.state, 'fetching', 'requestId mismatch dropped on replay');
    eq(f.computed.items, [], 'stale items did NOT land');
  });
});

report();
