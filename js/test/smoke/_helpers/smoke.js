/**
 * Smoke-test helper — thin wrapper around the real input/dispatch/render
 * pipeline for end-to-end scenarios.
 *
 * The pattern is the same one `test-live-render.js` proved: hijack
 * stdout, drive `handleKey` / `handleMouse` / `applyMsg`, capture the
 * frame, assert on stripped text + post-step model state. This file
 * adds three things on top:
 *
 *   - bootFresh()  — reset the model + slices to a known starting shape
 *                    so smoke scenarios don't leak into each other.
 *   - step()       — run a chunk of input + capture + remember the
 *                    (label, frame-tail, focus, activeTab) snapshot.
 *                    On a later assertion failure, dump the history
 *                    with `dumpOnFail()` for a readable trace.
 *   - typed drivers — key(), msg(), mouse(), wheel() — same calls
 *                    `input.js` makes, exposed for direct use.
 *
 * Scenarios still use describe/it/assert from test-runner; the helper
 * doesn't reinvent assertions. It just covers the boot + drive +
 * snapshot ergonomics so every scenario file isn't 50 lines of
 * boilerplate.
 *
 * Run scenarios via `node js/scripts/run-smoke.js`.
 */
'use strict';

const { handleKey, applyMsg } = require('../../../dispatch/dispatch');
const { handleMouse, _handleWheel } = require('../../../dispatch/input');
const { render } = require('../../../render/paint');
const { getModel } = require('../../../app/runtime');
const { initState } = require('../../../app/state');
const route = require('../../../panel/route');
const api = require('../../../panel/api');
const tabs = require('../../../panel/viewer/tabs');

// --- ANSI strip (mirrors test-live-render's `stripAnsi`). ----------------

function stripAnsi(s) {
  return s
    // OSC sequences (e.g. OSC52 clipboard `\x1b]52;c;<b64>\x07`). These
    // wrap arbitrary payload — base64 / titles / paths — that can
    // collide with smoke assertions on the rendered text (b64 happens
    // to contain a MARKER). Strip with non-greedy match up to BEL or ST.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // CSI sequences
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // Alt-charset toggles
    .replace(/\x1b[=>]/g, '');
}

/** Run `fn` while capturing everything written to stdout; return both
 *  the raw bytes (kept for the rare test that needs to decode cursor
 *  moves — see test-live-render.js [collapse-shift]) and the ANSI-
 *  stripped visible frame. */
function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  const raw = chunks.join('');
  return { raw, frame: stripAnsi(raw) };
}

// --- Default config shape ------------------------------------------------
//
// A minimal config that exercises a navigator panel (groups) + a viewer
// panel (detail). Scenarios that need docker / files / actions panes
// pass an extended config to bootFresh().

const DEFAULT_GROUP = {
  containers: [],
  actions: { a1: { key: 'a1', label: 'Action 1', type: 'run', script: 'echo a1', tab: false } },
  children: [], parent: null, depth: 0, quick: false,
};

function _grp(name, label, overrides) {
  return { name, label, ...DEFAULT_GROUP, ...overrides };
}

/** Reset the model + Component slices to a known-fresh state.
 *
 *  Strategy:
 *    - Overwrite model.config with the requested groups (or sane default).
 *    - Call initState() — re-mints per-pane viewer/groups slices.
 *    - Clear viewer per-group maps that initState doesn't touch
 *      (contentTabs / ephemeralTerminals / tabState / viewerOverride).
 *
 *  The instance store survives across scenarios (modules are cached and
 *  test-runner auto-registers layout/detail/groups on first require).
 *  Re-registering would shadow the existing primary; instead we reset
 *  the visible state on the existing slices. */
function bootFresh(opts) {
  opts = opts || {};
  const groups = opts.groups || {
    g1: _grp('g1', 'Group 1'),
    g2: _grp('g2', 'Group 2'),
  };
  // Caller may pass arbitrary top-level config keys (files, plugins,
  // layout, register, …) — they ride through to initState's
  // rebuildLayoutFromConfig + state-seeding pass, which is the only way
  // to trigger the per-pane B1 instance mint for the resulting arrange.
  // Patching arrange after initState bypasses the mint and leaves later
  // paneId-keyed lookups missing — caught by the routing smoke.
  const { groups: _ignored, ...extras } = opts;
  getModel().config = {
    project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
    ...extras,
    groups,
  };
  initState();
  getModel().projectDir = '.';
  // Clear modal flags that may have been set by an earlier scenario.
  const modes = require('../../../leaves/modes');
  modes.resetModes(getModel().modes);
  // Wipe per-group tab maps + override on every viewer-kind slice.
  // Scenarios open tabs via tabs.addContentTab(); leaving the maps
  // populated between scenarios would produce phantom tabs.
  route.eachInstance((inst) => {
    if (inst.kind !== 'detail') return;
    const s = inst.slice;
    s.contentTabs = {};
    s.ephemeralTerminals = {};
    s.tabState = {};
    s.viewerOverride = null;
    s.tab = 0;
    s.lines = [];
    s.scroll = 0;
  });
  // Anchor on g1 so currentGroup is well-defined.
  const firstGroup = Object.keys(groups)[0];
  if (firstGroup) getModel().currentGroup = firstGroup;
}

/** Simulate a terminal resize the way production experiences it
 *  (resize-as-Msg P1): mutate process.stdout AND dispatch the
 *  term_resized Msg — the model's dims are the only clock geometry
 *  reads, so mutating stdout alone no longer changes layout. Mirrors
 *  the tui.js 'resize' listener minus the scheduleRender (tests drive
 *  renders explicitly). */
function resize(cols, rows) {
  process.stdout.columns = cols;
  process.stdout.rows = rows;
  // Mirror the production listener exactly: refresh io/term's COLS/ROWS
  // (the boot fallback + low-level term source) + dispatch the Msg that
  // moves the model clock. Footer/overlays read the MODEL clock
  // (layoutSlice.dims via render/panel.viewportDims), not io/term.
  require('../../../io/term').refreshSize();
  api.dispatchMsg(api.wrap('layout', { type: 'term_resized', cols, rows }));
}

// --- Session — step + snapshot ring buffer -------------------------------

/** Bounded history of (label, frame-tail, focus, activeTab) snapshots,
 *  printed by `dumpOnFail()` after an assertion failure. The default
 *  cap (16) is enough to cover any reasonable scenario without blowing
 *  the test output up. */
const SNAPSHOT_CAP = 16;
const FRAME_TAIL = 160;  // chars of the rendered frame kept per snapshot

function createSession(opts) {
  bootFresh(opts);
  const history = [];   // [{label, frame, focus, activeTab, msg?}]

  function _push(entry) {
    history.push(entry);
    if (history.length > SNAPSHOT_CAP) history.shift();
  }

  function _snapshot(label, frame) {
    const layout = api.getInstanceSlice('layout');
    const detail = api.primarySliceOf('detail');
    _push({
      label,
      frame: (frame || '').slice(-FRAME_TAIL).replace(/\s+/g, ' ').trim(),
      focus: layout && layout.focus,
      activeTab: detail && detail.tab,
    });
  }

  /** Run `fn`, capture the frame, snapshot the resulting state under
   *  `label`. fn is whatever drives the system (key/mouse/applyMsg —
   *  see drivers below). The returned object is the capture result
   *  ({raw, frame}) so the caller can assert on `frame` inline. */
  function step(label, fn) {
    const cap = capture(fn);
    _snapshot(label, cap.frame);
    return cap;
  }

  function key(k, seq) { return capture(() => handleKey(k, seq || k)); }
  function mouse(kind, mx, my) { return capture(() => handleMouse(kind, mx, my)); }
  function wheel(mx, my, delta) { return capture(() => _handleWheel(mx, my, delta)); }
  function msg(m) { return capture(() => applyMsg(m)); }

  function frame() { return capture(() => render()).frame; }

  /** Print the snapshot history to stderr. Call from inside an `it`
   *  block when an assertion fails to get a step-by-step trace. */
  function dumpOnFail() {
    process.stderr.write('\n  --- smoke history (last ' + history.length + ' steps) ---\n');
    for (const h of history) {
      process.stderr.write(
        `  [${h.label}] focus=${h.focus} tab=${h.activeTab}\n` +
        `      frame: ${h.frame}\n`,
      );
    }
  }

  return {
    bootFresh: (o) => bootFresh(o),
    step, key, mouse, wheel, msg, frame,
    dumpOnFail,
    history,
    capture,
  };
}

// --- Direct exports (for scenarios that don't want a session) ------------

module.exports = {
  bootFresh, createSession, capture, stripAnsi, resize,
  // Re-export the real drivers so scenarios don't have to import them
  // a second time.
  handleKey, handleMouse, _handleWheel, applyMsg, render,
  // And the route helpers, which scenarios use for the post-T3.5
  // paneId-vs-type comparators.
  route, api, tabs,
};
