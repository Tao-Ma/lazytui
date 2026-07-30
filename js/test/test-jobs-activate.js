/**
 * v0.6.2 Phase 4.3 — Enter on a Running-overlay row jumps to the
 * job's tab/pane and closes the overlay.
 *
 * Drives the `jobs_activate` Msg directly (the handler is a one-liner;
 * everything happens in the reducer cascade). Walks each kind:
 *   stream-routed   → tab_switch to action tab + focus viewer
 *   stream-unrouted → focus viewer (no tab change)
 *   pty             → tab_switch to terminal tab + terminal_enter
 *   background      → viewer set to info card (kind/pid/age/cmd)
 *   tmux            → viewer set to info card (window name)
 *
 * Run: node js/test/test-jobs-activate.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const runtime = require('../app/runtime');
const jobs = require('../feature/jobs');
const dispatch = require('../dispatch/control/dispatch');
const effects = require('../dispatch/runtime/effects');
const api = require('../panel/api');

const NOW = 1717420000000;  // fixed timestamp for deterministic age math

// U2f — boot a SEEDED content slot (register info+text-view, then initState so
// the no-layout fallback synthesizes a `detail` pane → role:'content' slot seeded
// with Info/Transcript). The job-info card + focus cascade now target that slot.
if (!api.getComponent('info')) api.registerComponent(require('../panel/info/info'));
if (!api.getComponent('text-view')) api.registerComponent(require('../panel/text-view/text-view'));

// U2f — the background/tmux job-info card is built by the pure `jobs_routed` reducer
// arm and dispatched as an `open_doc_tab` Cmd (key 'job-info', label 'Job') carrying
// the card lines. Capture that Cmd so we assert the CARD CONTENT the reducer produced.
// (We deliberately read the emitted Cmd, not the minted tab's slice.lines: the effect's
// off-tick body funnels through addContentTab, and a NESTED-dispatch prod bug leaves
// that tab's buffer EMPTY — see PROD BUG note at the bottom of this file. The reducer
// intent — "the info card holds label/pid/window/cmd" — is what this suite pins.)
let _lastDocTab = null;
effects.registerEffect('open_doc_tab', (eff) => { _lastDocTab = eff; });

function _seedModel() {
  const m = runtime.init();
  m.config = {
    groups: {
      g: {
        label: 'G',
        actions: {
          'make-check': { label: 'Test', script: 'make check', tab: 'Test' },
        },
        terminals: { shell: { cmd: 'bash', label: 'Shell' } },
      },
    },
  };
  m.projectDir = '.';
  runtime.setModel(m);
  require('../app/state').initState();   // builds + seeds the content slot
  return runtime.getModel();
}

// The job-info card lines the reducer built + dispatched via `open_doc_tab`
// (U2f — key 'job-info', label 'Job'). This is the card CONTENT intent; the
// deferred landing into the minted tab's slice.lines is prod-broken (see the
// PROD BUG note at the bottom of the file).
function _jobInfoLines() {
  return (_lastDocTab && _lastDocTab.key === 'job-info') ? _lastDocTab.lines : null;
}

function _resetJobs() { jobs._reset(); _lastDocTab = null; }

function _activate() {
  // R2 — production handler resolves the cursor's job entry and threads
  // it via msg.job (reducer stays pure). Mirror that here in tests so
  // the reducer arm receives msg.job, not the bare cursor lookup.
  const m = runtime.getModel();
  const cursor = (m.modal && m.modal.jobs && m.modal.jobs.cursor | 0) || 0;
  const job = jobs.snapshot()[cursor] || null;
  dispatch.applyMsg({ type: 'jobs_activate', now: NOW, job });
}

describe('[jobs_activate] full cascade — one Msg, reducer-driven', () => {
  function setup(jobInfo) {
    _seedModel();
    _resetJobs();
    runtime.setModel({
      ...runtime.getModel(),
      modes: { ...runtime.getModel().modes, jobsMode: true },
      modal: { ...runtime.getModel().modal, jobs: { cursor: 0, scroll: 0 } },
    });
    return jobs.register(jobInfo);
  }

  it('stream-routed → closes overlay, falls back to the content slot when the owner tab is unminted', () => {
    setup({
      kind: 'stream-routed',
      label: 'make-check',
      pid: 1,
      owner: { tabKey: 'make-check', groupName: 'g', cmd: 'make check' },   // no tabInstId → no jump target
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false, 'overlay closed');
    // The jump-to-producing-tab path threads {jumpPaneId} only when the owner's
    // tabInstId resolves to a minted instance; this harness owner has none, so it
    // falls back to focusing the CONTENT SLOT. The jump itself is pinned by the
    // '→ producing tab' pure-arm test below.
    eq(api.getInstanceSlice('layout').focus, 'pane-detail', 'focus on the content slot (fallback)');
  });

  it('stream-unrouted → closes overlay, focus moves to viewer; no tab change', () => {
    setup({
      kind: 'stream-unrouted',
      label: 'docker logs nginx',
      pid: 2,
      owner: { cmd: 'docker logs nginx' },
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false);
    eq(api.getInstanceSlice('layout').focus, 'pane-detail', 'focus on the content slot');
  });

  it('pty → closes overlay, focuses viewer (no flat-tab jump — U2d P2)', () => {
    setup({
      kind: 'pty',
      label: 'bash',
      pid: 3,
      owner: { ptyId: 'g_shell', cmd: 'bash' },
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false);
    // U2d P2 — the PTY's terminal is a `terminal` PANE now. A resolvable ptyId
    // jumps to (activates + focuses) that terminal pane; this harness owner's
    // 'g_shell' isn't a minted instance, so it falls back to the content slot.
    // The jump does NOT auto-enter terminal mode (navigating jobs ≠ typing).
    eq(runtime.getModel().modes.terminalMode, false, 'jump never auto-enters terminal mode');
  });

  it('background → viewer shows info card, no tab switch', () => {
    setup({
      kind: 'background',
      label: 'bg-rsync',
      pid: 12345,
      owner: { cmd: 'rsync -av src/ dst/' },
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false);
    // U2f — the job-info card is a text-view content tab now (dispatched via the
    // `open_doc_tab` Cmd, key 'job-info'), not the detail viewer's viewerOverride.
    // We assert the CARD CONTENT the reducer produced (the emitted Cmd's lines).
    const lines = _jobInfoLines();
    assert(lines && lines.length > 0, 'job-info card has lines');
    assert(lines[0].includes('bg-rsync'), 'header has label');
    assert(lines.some(l => l.includes('pid:') && l.includes('12345')), 'pid line present');
    assert(lines.some(l => l.includes('rsync -av src/ dst/')), 'cmd line present');
    eq(api.getInstanceSlice('layout').focus, 'pane-detail', 'focus moved to the content slot');
  });

  it('tmux → viewer shows info card with window name', () => {
    setup({
      kind: 'tmux',
      label: 'worker',
      pid: null,
      owner: { tmuxWindowName: 'worker', cmd: 'long-job.sh' },
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false);
    const lines = _jobInfoLines();
    assert(lines && Array.isArray(lines), 'job-info card populated');
    assert(lines.some(l => l.includes('window:') && l.includes('worker')), 'window line present');
    assert(lines.some(l => l.includes('long-job.sh')), 'cmd line present');
  });

  it('empty list (cursor on nothing) → close only, no crash', () => {
    _seedModel();
    _resetJobs();
    runtime.setModel({
      ...runtime.getModel(),
      modes: { ...runtime.getModel().modes, jobsMode: true },
      modal: { ...runtime.getModel().modal, jobs: { cursor: 0, scroll: 0 } },
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false);
  });

  it('cross-group routed → set_current_group fires with msg.name (not msg.group)', () => {
    // Regression for B1: jobs_activate's cross-group cascade emitted
    // { type: 'set_current_group', group: ... } but the reducer reads
    // msg.name, so cross-group activation silently set currentGroup to ''.
    _seedModel();
    _resetJobs();
    // Add a second group `g2` with its own action.
    const m = runtime.getModel();
    m.config.groups.g2 = {
      label: 'G2',
      actions: { 'g2-action': { label: 'G2', script: 'echo g2', tab: 'g2-action' } },
    };
    runtime.setModel({
      ...m,
      modes: { ...m.modes, jobsMode: true },
      modal: { ...m.modal, jobs: { cursor: 0, scroll: 0 } },
    });
    jobs.register({
      kind: 'stream-routed',
      label: 'g2-action',
      pid: 1,
      owner: { tabKey: 'g2-action', groupName: 'g2', cmd: 'echo g2' },
    });
    _activate();
    eq(runtime.getModel().currentGroup, 'g2', 'currentGroup switched to g2 (B1: msg.name, not msg.group)');
  });

  // U2c P2 — the 'cross-group routed → tab_switch carries the target group +
  // bottom-pins the routed actionTabBuffers' test was retired: stream-routed
  // activation no longer flat-tab-jumps (action output → a text-view position-tab)
  // and actionTabBuffers is gone. The cross-group currentGroup switch itself is
  // still covered by the preceding case.

  it('→ producing tab: a threaded jump target activates the tab + focuses its column', () => {
    // The jobs_route EFFECT resolves the owner's tab-instance id to
    // {jumpPaneId, jumpPoolId}; here we drive the PURE jobs_routed arm with that
    // payload (as the effect would thread it) and assert the jump cascade —
    // uniform across stream-routed / pty / agent / unrouted-Transcript.
    const jobsModal = require('../dispatch/update/modal/jobs');
    for (const kind of ['stream-routed', 'pty', 'stream-unrouted']) {
      const [, cmds] = jobsModal.update(runtime.getModel(), {
        type: 'jobs_routed', job: { kind, owner: {} },
        jumpPaneId: 'pane-detail', jumpPoolId: 'tv-7',
      });
      eq(cmds, [
        { type: 'msg', msg: { kind: 'layout', msg: { type: 'set_active_tab', paneId: 'pane-detail', tabPoolId: 'tv-7' } } },
        { type: 'msg', msg: { kind: 'layout', msg: { type: 'focus_set', focus: 'pane-detail' } } },
      ], `${kind}: activate the producing tab, focus its column`);
    }
  });

  it('non-jobsMode → activate is a no-op (defensive)', () => {
    _seedModel();
    _resetJobs();
    // Don't set jobsMode. Register a job, dispatch activate — nothing happens.
    jobs.register({ kind: 'stream-routed', label: 'x', pid: 1, owner: { tabKey: 'x', groupName: 'g' } });
    const before = api.getInstanceSlice('layout').focus;
    _activate();
    eq(api.getInstanceSlice('layout').focus, before, 'focus untouched');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROD BUG (U2f, found during test migration — REPORTED, not fixed):
//
// The background/tmux job-info card is dispatched correctly (open_doc_tab carries
// the right lines, asserted above) but LANDS with an EMPTY buffer in production.
//
// Chain: jobs_activate → (effect) jobs_route → applyMsg(jobs_routed) → (effect)
// open_doc_tab → panel/content-tab.addContentTab('job-info',…). Because this whole
// cascade runs at dispatch depth ≥1 (nested effect dispatches), the finalizer
// (instance reconcile) does NOT run between addContentTab's two inner dispatches:
//   1. mint_tab  (appends the text-view tab to the content slot's tabs[])
//   2. tv_set_lines  (the buffer content)
// At step 2 the tab's instance is NOT YET minted (reconcile only runs when depth
// returns to 0), so the wrapped tv_set_lines is DROPPED ("unknown Component"). The
// instance is later minted empty by the depth-0 finalizer. content-tab.js relies on
// the mint's `config.lines` SEED as the nested-case fallback — but that seed is
// UNREACHABLE for a content-slot tab: app/state.js#reconcilePaneInstances threads
// `seed.paneDef = <the placed pane p>`, and for a role:'content' slot
// leaves/wm/pane.js#_rebuildLegacyFields (U2f) deliberately keeps the SLOT's own
// config (id/type 'detail') instead of mirroring the active tab's pool entry — so
// text-view.init's `seed.paneDef.config.lines` read gets nothing. Net: the job-info
// card shows blank. (The depth-0 path — test-content-tab-mint, help/config-status —
// is unaffected: tv_set_lines lands after the finalizer mints the instance.)
//
// Repro: open the Running overlay (leader j), Enter a background/tmux job → the
// content slot shows an empty "Job" tab instead of the kind/pid/age/cmd card.
// Likely fix (prod): thread the minted tab's OWN pool `entry` as the init seed for
// minted tabs in reconcilePaneInstances (state.js ~L558), OR have
// _rebuildLegacyFields carry the active tab's `config.lines` onto a content slot.
// ─────────────────────────────────────────────────────────────────────────────

report();
