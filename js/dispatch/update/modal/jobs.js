/**
 * Running-overlay (jobs) sub-reducer (#D12 — Phase 4.2). Cursor/scroll live in
 * model.modal.jobs; the items list is read live from feature/jobs.list() at
 * render time, so clamping takes the count + vh in the Msg. Also hosts the job
 * ROUTING cascade (jobs_activate → jobs_route effect → jobs_routed): activate
 * closes the overlay + queues the group switch, the effect reads the post-switch
 * viewer slice, and the pure jobs_routed tail emits the tab/focus/info cascade.
 * `update(model, msg) → [model, cmds]`.
 */
'use strict';

const { withModes: _withModes, withModal: _withModal } = require('../model-ops');
const route = require('../../../panel/route');
// esc() for the jobs_routed info-card lines (background/tmux).
const { esc } = require('../../../leaves/text/ansi');

const TYPES = ['jobs_open', 'jobs_close', 'jobs_nav', 'jobs_activate', 'jobs_routed'];

/** ptyId is `${group}_${key}`; group keys can contain underscores, so
 *  match greedily against the live config. Falls back to the substring
 *  before the first underscore. Used by jobs_activate to resolve a target
 *  group when the registered job only carries the ptyId (no explicit
 *  owner.groupName). */
function _parsePtyIdGroup(model, ptyId) {
  const groups = (model.config && model.config.groups) || {};
  for (const name of Object.keys(groups)) {
    if (ptyId.startsWith(`${name}_`)) return name;
  }
  const u = ptyId.indexOf('_');
  return u < 0 ? ptyId : ptyId.slice(0, u);
}

function update(model, msg) {
  switch (msg.type) {
    case 'jobs_open':
      if (model.modes.jobsMode) return [model, []];
      // Stamp `now` from the handler (msg.now) so the first frame shows a fresh
      // age. The frame clock ticks via the model-conditional `clock` interval
      // Sub (app/state.js#_appSubscriptions, declared while an age overlay is
      // open) — FIX-3 Phase 6 retired the self-re-armed arm_clock Cmd.
      return [{
        ..._withModes(model, { jobsMode: true }),
        modal: { ...model.modal, jobs: { cursor: 0, scroll: 0 } },
        now: msg.now || model.now,
      }, []];
    case 'jobs_close':
      if (!model.modes.jobsMode) return [model, []];
      return [_withModes(model, { jobsMode: false }), []];
    case 'jobs_nav': {
      const j = model.modal.jobs;
      const count = msg.count | 0;
      const vh = Math.max(1, msg.vh | 0);
      if (count <= 0) return [model, []];
      let next = j.cursor;
      if (msg.to === 'top')           next = 0;
      else if (msg.to === 'bottom')    next = count - 1;
      else if (msg.to === 'pageup')    next = j.cursor - vh;
      else if (msg.to === 'pagedown')  next = j.cursor + vh;
      else                              next = j.cursor + ((msg.dir | 0) || 0);
      next = Math.max(0, Math.min(count - 1, next));
      let scroll = j.scroll | 0;
      if (next < scroll)            scroll = next;
      else if (next >= scroll + vh) scroll = next - vh + 1;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, count - vh)));
      if (next === j.cursor && scroll === j.scroll) return [model, []];
      return [_withModal(model, { jobs: { cursor: next, scroll } }), []];
    }
    case 'jobs_activate': {
      // v0.6.4 Phase C — PURE orchestrator. The handler resolves the
      // (out-of-TEA) feature/jobs entry by cursor and threads it via
      // msg.job; msg.now is the dispatch-time timestamp for the
      // background/tmux age display. This arm only closes the overlay,
      // resolves the target group from the job payload (a model-only
      // read), and queues the cascade — it performs NO Component-slice
      // read. The tab-routing that USED to live here read the viewer slice
      // and depended on the POST-switch currentGroup; Phase C hands that off
      // to the dispatch-side jobs_route Cmd, which runs AFTER the queued
      // set_current_group commits and threads the resolved tab into the pure
      // jobs_routed tail below.
      if (!model.modes.jobsMode) return [model, []];
      const job = msg.job || null;
      const closedModel = _withModes(model, { jobsMode: false });
      if (!job) return [closedModel, []];

      const { owner = {} } = job;
      const cmds = [];
      const targetGroup = owner.groupName
        || (owner.ptyId ? _parsePtyIdGroup(model, owner.ptyId) : null);
      if (targetGroup && targetGroup !== model.currentGroup) {
        cmds.push({ type: 'msg', msg: { type: 'set_current_group', name: targetGroup } });
      }
      // The routing read happens post-switch in the jobs_route effect; it
      // re-dispatches the pure jobs_routed Msg with the destination threaded.
      cmds.push({ type: 'jobs_route', job, now: msg.now });
      return [closedModel, cmds];
    }
    case 'jobs_routed': {
      // v0.6.4 Phase C — PURE tail of jobs_activate. The dispatch-side
      // jobs_route effect already read the post-switch viewer slice and
      // threaded the resolved destination (viewerTarget / groupName / tabIdx
      // / targetKey / fromTabKey). This arm reads NO Component slice — it
      // only emits the Cmd cascade (tab_switch + focus + terminal_enter /
      // info card) from the threaded payload. msg.now feeds the
      // background/tmux age display.
      const job = msg.job || null;
      if (!job) return [model, []];
      const { kind, owner = {} } = job;
      const viewerTarget = msg.viewerTarget || 'detail';
      const groupName = msg.groupName || model.currentGroup;
      const cmds = [];

      if (kind === 'stream-routed' && owner.tabKey) {
        // tabIdx is set only when the effect found the action tab.
        if (msg.tabIdx != null) {
          cmds.push({ type: 'msg', msg: route.wrap(viewerTarget, {
            type: 'tab_switch', idx: msg.tabIdx,
            targetKey: msg.targetKey,
            currentGroup: groupName,
          }) });
          cmds.push({ type: 'msg', msg: route.wrap('layout', { type: 'focus_set', focus: viewerTarget }) });
        }
      } else if (kind === 'stream-unrouted') {
        cmds.push({ type: 'msg', msg: route.wrap('layout', { type: 'focus_set', focus: viewerTarget }) });
      } else if (kind === 'pty' && owner.ptyId) {
        if (msg.tabIdx != null) {
          cmds.push({ type: 'msg', msg: route.wrap(viewerTarget, {
            type: 'tab_switch', idx: msg.tabIdx,
            targetKey: msg.targetKey,
            currentGroup: groupName,
          }) });
          cmds.push({ type: 'msg', msg: route.wrap('layout', { type: 'focus_set', focus: viewerTarget }) });
          cmds.push({ type: 'msg', msg: { type: 'terminal_enter' } });
        }
      } else if (kind === 'background' || kind === 'tmux') {
        const now = msg.now | 0;
        const ageS = Math.max(0, Math.floor(((job.endedAt || now) - job.startedAt) / 1000));
        const lines = [
          `[dim]$ ${esc(job.label)}[/]`,
          '',
          `[dim]kind:[/]     ${kind}`,
          kind === 'background'
            ? `[dim]pid:[/]      ${job.pid == null ? '(unknown)' : job.pid}`
            : `[dim]window:[/]   ${esc(owner.tmuxWindowName || '')}`,
          `[dim]status:[/]   ${job.status}${job.exitCode == null ? '' : ` (exit ${job.exitCode})`}`,
          `[dim]age:[/]      ${ageS}s`,
          '',
          `[dim]cmd:[/]`,
          `  ${esc(owner.cmd || '(no cmd recorded)')}`,
        ];
        // v0.6.3 Phase D1 — thread root facts the viewer_set_content arm
        // needs (currentGroup, fromTabKey). fromTabKey was read from the
        // viewer slice by the jobs_route effect; bg/tmux never switch group,
        // so model.currentGroup here equals the pre-switch value.
        cmds.push({ type: 'msg', msg: route.wrap(viewerTarget, {
          type: 'viewer_set_content', lines,
          currentGroup: model.currentGroup,
          fromTabKey: msg.fromTabKey,
        }) });
        cmds.push({ type: 'msg', msg: route.wrap('layout', { type: 'focus_set', focus: viewerTarget }) });
      }
      return [model, cmds];
    }
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
