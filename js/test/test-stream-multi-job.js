/**
 * v0.6.2 Large — multi-job stream invariants.
 *
 * Pins:
 *   - cross-slot concurrent: two routed streams with DIFFERENT slotKey slots
 *     (U2c P1 — the per-action concurrency key, distinct from the display target)
 *     register both into the jobs registry and leave both alive.
 *   - same-slot preempt: re-running a routed stream in the SAME slot
 *     kills the previous (status='killed') before the new one starts.
 *   - unrouted singleton: a new unrouted stream preempts the previous
 *     unrouted (one 'unrouted' slot).
 *   - routed vs unrouted independence: starting unrouted does NOT
 *     kill routed (and vice versa).
 *
 * Run: node js/test/test-stream-multi-job.js
 *
 * Spawns are real `sh -c 'sleep N'` processes so jobs persist long
 * enough to inspect; cleanup at the end kills them all.
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const stream = require('../dispatch/runtime/stream');
const jobs = require('../feature/jobs');
const runtime = require('../app/runtime');
const api = require('../panel/api');

// U2e P1b — unrouted streams land in the content slot's TRANSCRIPT text-view
// instance (route.resolveTarget('viewer_transcript')), and dispatch/runtime/stream
// DROPS an unrouted stream when no content slot is placed (the transcript target
// is null). The old bare-runtime.init() seed had no layout, so every unrouted
// test silently no-op'd. Boot a SEEDED content slot (a `detail` pane → Info +
// Transcript tabs) via parser + initState so the unrouted target resolves.
// ROUTED streams run regardless of a placed viewer (fixed in production) — the
// seeded slot doesn't affect them.
api.registerComponent(require('../panel/info/info'));
api.registerComponent(require('../panel/text-view/text-view'));

function seedModel() {
  const { parse } = require('../parser/index');
  const { initState } = require('../app/state');
  const m = runtime.init();
  // Parse the repo test.yml for its layout (a `detail` pane → seeded content
  // slot), then swap in this test's synthetic groups (the `test`/`server-log`
  // actions the routed cases drive). resolveTarget('viewer_transcript') keys on
  // the layout arrange, not config.groups, so the swap is safe.
  m.config = parse(require('path').resolve(__dirname, '../../test/test.yml'));
  m.config.groups = {
    g: {
      label: 'G',
      actions: {
        'test':       { label: 'Test',   script: 'sleep 5', tab: 'Test' },
        'server-log': { label: 'Server', script: 'sleep 5', tab: 'Server' },
      },
    },
  };
  m.currentGroup = 'g';
  m.projectDir = '.';
  runtime.setModel(m);
  initState();
}

function running() {
  return jobs.snapshot().filter(j => j.status === 'running');
}

describe('[multi-job] cross-slot routed streams run concurrently', () => {
  it('Test + Server log both alive after sequential starts', () => {
    seedModel();
    jobs._reset();
    stream.streamCommand('test', 'sleep 5', [], { slotKey: 'pane-tv-act-g-test', tabKey: 'test', groupName: 'g' });
    stream.streamCommand('server-log', 'sleep 5', [], { slotKey: 'pane-tv-act-g-server-log', tabKey: 'server-log', groupName: 'g' });
    const r = running();
    eq(r.length, 2, 'two running jobs');
    const labels = r.map(j => j.label).sort();
    eq(labels[0], 'server-log');
    eq(labels[1], 'test');
    stream.killAll({ silent: true });
    eq(running().length, 0, 'cleanup');
  });
});

describe('[multi-job] same-slot re-run preempts', () => {
  it('two starts of the same routed slot → one running, one killed', () => {
    seedModel();
    jobs._reset();
    stream.streamCommand('test', 'sleep 5', [], { slotKey: 'pane-tv-act-g-test', tabKey: 'test', groupName: 'g' });
    const firstId = running()[0].id;
    stream.streamCommand('test', 'sleep 5', [], { slotKey: 'pane-tv-act-g-test', tabKey: 'test', groupName: 'g' });
    const r = running();
    eq(r.length, 1, 'only one alive in the slot');
    const all = jobs.snapshot();
    const prior = all.find(j => j.id === firstId);
    eq(prior.status, 'killed', 'previous slot occupant marked killed');
    stream.killAll({ silent: true });
  });
});

describe('[multi-job] unrouted preempt — different label stages confirm', () => {
  it('different label → confirm overlay; existing stays alive', () => {
    seedModel();
    jobs._reset();
    runtime.setModel({ ...runtime.getModel(), modes: { ...runtime.getModel().modes, confirmMode: false } });
    stream.streamCommand('docker logs nginx', 'sleep 5', []);
    stream.streamCommand('docker logs db',    'sleep 5', []);
    // Existing stream still alive; new one is gated behind the confirm
    // overlay (default action = reject, so the existing keeps running).
    const r = running();
    eq(r.length, 1, 'still exactly one running');
    eq(r[0].label, 'docker logs nginx', 'previous unrouted preserved (NOT silently replaced)');
    eq(runtime.getModel().modes.confirmMode, true, 'confirm overlay was staged');
    eq(runtime.getModel().modal.continuation.type, 'unrouted_preempt_and_run',
       'pending Cmd staged on continuation targets the unrouted-preempt path');
    stream.killAll({ silent: true });
    runtime.setModel({ ...runtime.getModel(),
      modes: { ...runtime.getModel().modes, confirmMode: false },
      modal: { ...runtime.getModel().modal, confirm: { message: '' }, continuation: null },
    });
  });
});

describe('[multi-job] unrouted preempt — same label silent restart', () => {
  it('same headerLabel re-run silently preempts (no confirm)', () => {
    seedModel();
    jobs._reset();
    runtime.setModel({ ...runtime.getModel(),
      modes: { ...runtime.getModel().modes, confirmMode: false },
      modal: { ...runtime.getModel().modal, confirm: { message: '', cmd: null } },
    });
    stream.streamCommand('docker logs nginx', 'sleep 5', []);
    const firstId = running()[0].id;
    stream.streamCommand('docker logs nginx', 'sleep 5', []);
    // Same label → no confirm; previous killed, new one alive.
    eq(runtime.getModel().modes.confirmMode, false, 'no confirm overlay for same-label rerun');
    const r = running();
    eq(r.length, 1, 'exactly one alive');
    assert(r[0].id !== firstId, 'new job replaced the old one');
    const all = jobs.snapshot();
    const prior = all.find(j => j.id === firstId);
    eq(prior.status, 'killed', 'prior marked killed');
    stream.killAll({ silent: true });
  });
});

describe('[multi-job] unrouted stream auto-jumps the slot to Transcript', () => {
  it('an unrouted run makes Transcript the active content tab', () => {
    // Regression: v0.6.7's flat-strip `stream_start` reducer auto-jumped to the
    // Transcript tab so the user saw an unrouted run (e.g. docker `Status`). The
    // U2e P1b position-tab migration seeded the header but dropped the switch;
    // restored via streamCommand → set_active_tab (route.resolveTranscriptTab).
    seedModel();
    jobs._reset();
    const route = require('../panel/route');
    const transcript = route.resolveTarget('viewer_transcript');
    assert(transcript != null, 'transcript instance resolves');
    // A freshly seeded content slot starts on Info, not Transcript — so a switch
    // is observable (guards against a vacuous pass).
    assert(route.resolveTarget('viewer') !== transcript, 'starts off Transcript (on Info)');
    stream.streamCommand('docker ps', 'sleep 5', []);
    eq(route.resolveTarget('viewer'), transcript, 'Transcript is now the active content tab');
    stream.killAll({ silent: true });
    eq(running().length, 0, 'cleanup');
  });
});

describe('[multi-job] routed + unrouted independent', () => {
  it('starting unrouted does NOT kill routed', () => {
    seedModel();
    jobs._reset();
    stream.streamCommand('test', 'sleep 5', [], { slotKey: 'pane-tv-act-g-test', tabKey: 'test', groupName: 'g' });
    stream.streamCommand('docker logs',  'sleep 5', []);
    const r = running();
    eq(r.length, 2, 'both alive');
    const kinds = r.map(j => j.kind).sort();
    eq(kinds[0], 'stream-routed');
    eq(kinds[1], 'stream-unrouted');
    stream.killAll({ silent: true });
  });
});

// Review [16] SEAM — the reverse-filled completion chip was originally wired ONLY
// into the normal `close` path, so a preempt (`killJob`) exit was left silently
// unmarked. A non-silent `killJob` now routes a killed job through the shared
// `emitStatusChip` seam, exactly like a clean close. This drives a DIRECT
// non-silent killJob to observe the appended ⊗ row.
//
// This asserts the SEAM (killed → ⊗), NOT user-visible output — in the live
// paths the in-pane chip does not survive:
//   • routed same-slot re-run: killJob(non-silent) emits it, then the new run's
//     tv_stream_start reseed WIPES it (pinned by test-action-status
//     "tv_stream_start (re-run reseed) clears statusRows"); the kill lives in
//     the history record.
//   • unrouted preempt: now kills SILENTLY and seeds a SURVIVING "⊗ killed
//     previous" preamble instead (the C block below). The seam stays live for
//     the routed re-run and any future standalone "stop job" path.
describe('[multi-job] killJob stamps the ⊗ completion chip (review [16] seam)', () => {
  it('a killed job appends a ⊗ status row to its target buffer, like a clean close', () => {
    seedModel();
    jobs._reset();
    const route = require('../panel/route');
    const { stripMarkup } = require('../leaves/text/ansi');
    const transcript = route.resolveTarget('viewer_transcript');
    assert(transcript != null, 'transcript instance resolves');

    // An unrouted stream lands its header + chip on the Transcript instance
    // (ctx.target is null → emitStatusChip routes to viewer_transcript).
    stream.streamCommand('docker logs x', 'sleep 5', []);
    const jobId = running()[0].id;
    const before = (route.getInstanceSlice(transcript).statusRows || []).length;

    stream.killJob(jobId);   // NOT silent → the preempt footer + chip are emitted

    const slice = route.getInstanceSlice(transcript);
    const rows = slice.statusRows || [];
    eq(rows.length, before + 1, 'killJob appended exactly one status row (was silent on the old code)');
    const chip = stripMarkup(slice.lines[rows[rows.length - 1]]);
    assert(chip.includes('⊗'), `the killed chip carries the ⊗ glyph: ${JSON.stringify(chip)}`);
    eq(running().length, 0, 'job cleared');
  });
});

// C — the unrouted preempt's "what did I just kill" notice SURVIVES the reseed.
// killJob's own footer/chip would be wiped by the new run's tv_stream_start, so
// the preempt path (effects.unrouted_preempt_and_run) captures a one-line notice,
// kills SILENTLY, and seeds the notice as a `preamble` ahead of the new header.
describe('[multi-job] unrouted preempt seeds a surviving "killed previous" preamble (C)', () => {
  const { stripMarkup } = require('../leaves/text/ansi');
  it('the new Transcript starts with the ⊗ notice, then the new command header', () => {
    seedModel();
    jobs._reset();
    const route = require('../panel/route');
    const transcript = route.resolveTarget('viewer_transcript');
    assert(transcript != null, 'transcript instance resolves');
    stream.streamCommand('docker logs A', 'sleep 5', []);
    const aId = running()[0].id;
    const notice = stream.preemptNotice(aId);          // captured BEFORE the kill removes the job
    assert(/⊗ killed previous: docker logs A/.test(stripMarkup(notice)),
      `notice text: ${JSON.stringify(stripMarkup(notice))}`);
    stream.killJob(aId, { silent: true });             // silent → no wiped footer/chip
    stream.streamCommand('docker logs B', 'sleep 5', [], { preamble: notice });
    const lines = (route.getInstanceSlice(transcript).lines || []).map(stripMarkup);
    assert(/⊗ killed previous: docker logs A/.test(lines[0] || ''),
      `preamble survives at the top: ${JSON.stringify(lines[0])}`);
    assert(/\$ docker logs B/.test(lines[1] || ''),
      `new command header follows the preamble: ${JSON.stringify(lines[1])}`);
    stream.killAll({ silent: true });
  });
  it("preemptNotice('<unknown>') is '' (no crash when the job is already gone)", () => {
    eq(stream.preemptNotice('does-not-exist'), '');
  });
});

// v0.6.2 R9 — model.unroutedStreaming was retired. The field was
// written by dispatch/runtime/stream.js on every slot lifecycle event but no
// production reader consumed it (the Transcript-tab refactor at
// ab1a0dc removed the last reader — viewer_show_info's
// off-Transcript-bail). The describe block that pinned the flag's
// toggling lifecycle was removed alongside the field.

setTimeout(() => report(), 200);  // give onExit a tick to land for the test runner's count
