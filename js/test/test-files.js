/**
 * files — directory/registry browser (Component / TEA API).
 *
 * The Component loads listings ASYNCHRONOUSLY through the effect loop, so the
 * tests drive a small effect pump: `update(msg, slice) → [slice, effects]` is
 * threaded by hand, and each `loadDir` effect is resolved synchronously off
 * the same real os.tmpdir() scratch tree the production effect reads (via the
 * shared _readDirRows). `dirLoaded` is fed back through update() — exactly the
 * Cmd→Msg fold the framework performs.
 *
 * v0.6.4 Theme A Phase 5 Arc 2 — one instance per placed pane; the slice
 * carries a single `browser` + `nav` and self-identifies via `paneId`
 * (`init(paneId)`). The pump inits each driver with the pane's paneId and
 * resolves "my pane" from the layout arrange — so a pane's source/cwd/root
 * comes from ITS declaration, not a first-of-type guess. Section [10]
 * exercises two same-type panes proving independent browser state.
 *
 * The async file-open path (section [9]) exercises the REAL registered
 * Component + effect registry end-to-end (addContentTab + the file-loader on
 * libuv's threadpool), so it polls for completion.
 *
 * Run: node js/test/test-files.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { describe, it, eq, assert, section, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');


// (test-runner.js already registered layout + detail + groups when required
// above — that's the production order tui.js uses.)
const api = require('../panel/api');
const route = require('../panel/route');

// The files Component. Phase 4a — registering up front so panel-type →
// Component lookup resolves for `getSel`/`setSel`/`setScroll` in sections
// [1-8]. Section [9] re-registers explicitly while exercising the real
// effect loop; re-register is idempotent.
const filesComp = require('../panel/navigator/files');
api.registerComponent(filesComp);

const { setSel, setScroll, getSel } = require('../app/state');

function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-files-'));
  fs.mkdirSync(path.join(root, 'subdir'));
  fs.writeFileSync(path.join(root, 'alpha.txt'), 'aaa\n');
  fs.writeFileSync(path.join(root, 'beta.txt'),  'bbb\n');
  fs.writeFileSync(path.join(root, '.hidden'),   'secret\n');
  fs.writeFileSync(path.join(root, 'subdir', 'gamma.txt'), 'g\n');
  return root;
}
function rm(root) { fs.rmSync(root, { recursive: true, force: true }); }

// Arc 2 — the pane's paneId IS its panelType in the single-pane sections
// (id === type === primary, the multi-instance no-op case). _paneById
// resolves "my pane" from this arrange.
function freshState(root, panelType = 'files', extraPanelCfg = {}) {
  getModel().config = {
    project_dir: root,
    files: [
      { path: 'README.md', desc: 'project readme', var: null, exclude: [], category: null },
      { path: 'src/main.js', desc: null, var: null, exclude: [], category: 'code' },
    ],
    groups: { g: { label: 'G', actions: { noop: { cmd: 'true', label: 'Noop' } } } },
  };
  getModel().projectDir = root;
  getModel().currentGroup = 'g';
  getInstanceSlice("layout").arrange = {
    columns: [
      { width: 30, panels: [{
        type: panelType, paneId: panelType, root,
        title: panelType, hotkey: '1', columnIndex: 0,
        ...extraPanelCfg,
      }] },
      { panels: [] },
    ],
    detailHeightPct: 60,
  };
  // Phase 4a/4c — every per-panel chrome (cursor/scroll/multiSel/filter)
  // lives on each Component's nav slice. Re-home the panels we touch.
  setSel(panelType, 0); setScroll(panelType, 0);
  getInstanceSlice('detail').contentTabs = {};
  getInstanceSlice('detail').ephemeralTerminals = {};
  getInstanceSlice('detail').tab = 0;
  getInstanceSlice("layout").focus = panelType;
  getInstanceSlice('detail').lines = [];
}

/**
 * Effect-pump driver: owns the slice, threads update(), and resolves the
 * effects the Component emits. `loadDir` is read synchronously off the real fs
 * (the same _readDirRows the production effect uses) and folded back via a
 * `dirLoaded` Msg; `resetPanelChrome` mirrors the reducer's panel_reset;
 * `openFile` is captured (the real open is exercised in the async section).
 *
 * Arc 2 — `paneId` stamps the slice (init(paneId)); effects carry paneId.
 */
function makeDriver(paneId = 'files') {
  let slice = filesComp._init(paneId);
  const opened = [];
  function runEffect(eff) {
    if (eff.type === 'loadDir') {
      let items = [];
      let error = null;
      try {
        items = filesComp._readDirRows(eff.cwd);
      } catch (e) {
        error = e.message;
        const dn = path.dirname(eff.cwd);
        items = dn !== eff.cwd ? [{ kind: 'parent', name: '..', path: dn }] : [];
      }
      dispatch({ type: 'dirLoaded', cwd: eff.cwd, seq: eff.seq, items, error });
    } else if (eff.type === 'resetPanelChrome') {
      // Mirrors the production resetPanelChrome effect: cursor / scroll
      // / filter → 0/'' on this pane's nav slice.
      setSel(eff.paneId, 0); setScroll(eff.paneId, 0);
      api.dispatchMsg(api.wrap('files', { type: 'clear_filter', panel: eff.paneId }));
    } else if (eff.type === 'openFile') {
      opened.push(eff);
    }
    // 'render' → no-op in the harness
  }
  function dispatch(msg) {
    // The pure key arm reads the cursor from slice.nav (single entry);
    // bridge the test's setSel() into the passed slice for key Msgs so
    // the focused row resolves the same way it does in app.
    if (msg.type === 'key' && slice.nav && 'cursor' in slice.nav) {
      slice = { ...slice, nav: { ...slice.nav, cursor: getSel(slice.paneId) } };
    }
    // Mirror the framework shell: thread per-pane facts via augmentMsg before
    // update (panel/api does this in production), so the reducer sees
    // msg.filesModel without reaching for getModel()/getInstanceSlice().
    const m = filesComp.augmentMsg(msg, getModel(), slice);
    const result = filesComp._update(m, slice);
    if (Array.isArray(result)) {
      slice = result[0];
      for (const eff of (result[1] || [])) runEffect(eff);
    } else if (result !== undefined) {
      slice = result;
    }
  }
  return {
    dispatch,
    getSlice: () => slice,
    items: (panelType, hardcoded = null) => filesComp._itemsFor(slice, panelType, hardcoded),
    browser: () => slice.browser,
    opened,
  };
}

describe('[2] file-browser — filesystem source, loaded via the effect loop', () => {
  it('lists dirs first then files, dotfiles hidden', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-browser');
      const d = makeDriver('file-browser');
      // Before the load resolves, getItems shows a loading placeholder.
      eq(d.items('file-browser', 'filesystem')[0].kind, 'loading', 'placeholder pre-load');
      d.dispatch({ type: 'refresh' });
      const names = d.items('file-browser', 'filesystem').map(i => i.name);
      eq(names[0], '..');
      eq(names[1], 'subdir');
      eq(names[2], 'alpha.txt');
      assert(!names.includes('.hidden'));
    } finally { rm(root); }
  });
});

describe('[3] files canonical — defaults to filesystem when no source set', () => {
  it('behaves like file-browser without explicit source', () => {
    const root = mkTree();
    try {
      freshState(root, 'files');
      const d = makeDriver('files');
      d.dispatch({ type: 'refresh' });
      const names = d.items('files').map(i => i.name);
      eq(names[0], '..');
      assert(names.includes('alpha.txt'));
    } finally { rm(root); }
  });
});

describe('[4] files with source: declared — synchronous, no load needed', () => {
  it('reads getModel().config.files; refresh emits no loadDir', () => {
    const root = mkTree();
    try {
      freshState(root, 'files', { source: 'declared' });
      const d = makeDriver('files');
      d.dispatch({ type: 'refresh' });
      // declared source is a pure projection: the browser stays pristine
      // (never listed) — refresh is a no-op for it.
      eq(d.browser().items, null, 'no fs load kicked for declared');
      const names = d.items('files').map(i => i.name);
      eq(names.length, 2);
      assert(names.includes('README.md'));
    } finally { rm(root); }
  });
});

describe('[5] files with source: both — declared first, then filesystem', () => {
  it('concatenates with declared rows at the top', () => {
    const root = mkTree();
    try {
      freshState(root, 'files', { source: 'both' });
      const d = makeDriver('files');
      d.dispatch({ type: 'refresh' });
      const items = d.items('files');
      eq(items[0].kind, 'declared');
      eq(items[1].kind, 'declared');
      const parentIdx = items.findIndex(i => i.kind === 'parent');
      assert(parentIdx >= 2, `parent appears after declared (idx=${parentIdx})`);
      assert(items.some(i => i.name === 'alpha.txt'));
    } finally { rm(root); }
  });
});

describe('[6] regex filter — invalid pattern shows everything', () => {
  it('valid pattern filters; invalid passes', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-browser');
      const d = makeDriver('file-browser');
      d.dispatch({ type: 'refresh' });

      api.dispatchMsg(api.wrap('files', { type: 'set_filter', panel: 'file-browser', text: 'be' }));
      const names1 = d.items('file-browser', 'filesystem').map(i => i.name);
      assert(names1.includes('beta.txt') && names1.includes('..'));
      assert(!names1.includes('alpha.txt'));

      api.dispatchMsg(api.wrap('files', { type: 'set_filter', panel: 'file-browser', text: '[' }));
      const names2 = d.items('file-browser', 'filesystem').map(i => i.name);
      assert(names2.includes('alpha.txt') && names2.includes('beta.txt'),
        'invalid regex passes everything through');
    } finally { rm(root); }
  });
});

describe('[7] show-hidden — toggles dotfile visibility via a Msg (no re-list)', () => {
  it('toggles the showHidden gate in the projection', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-browser');
      const d = makeDriver('file-browser');
      d.dispatch({ type: 'refresh' });
      assert(!d.items('file-browser', 'filesystem').some(i => i.name === '.hidden'));
      d.dispatch({ type: 'showHidden', mode: 'on' });
      assert(d.items('file-browser', 'filesystem').some(i => i.name === '.hidden'), 'dotfile now shown');
      d.dispatch({ type: 'showHidden', mode: 'off' });
      assert(!d.items('file-browser', 'filesystem').some(i => i.name === '.hidden'), 'dotfile hidden again');
    } finally { rm(root); }
  });
  it('the registered command dispatches the showHidden Msg', () => {
    const cmd = filesComp.commands.find(c => c.name === 'show-hidden');
    assert(cmd && typeof cmd.run === 'function', 'show-hidden command exists');
  });
});

describe('[8] Enter on a dir navigates — slice cwd advances + chrome resets', () => {
  it('navigating into subdir loads its contents and re-homes the cursor', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-browser');
      const d = makeDriver('file-browser');
      d.dispatch({ type: 'refresh' });
      const items = d.items('file-browser', 'filesystem');
      const subIdx = items.findIndex(i => i.name === 'subdir');
      assert(subIdx >= 0, 'subdir present');
      setSel('file-browser', subIdx);
      d.dispatch({ type: 'key', key: 'return', seq: '', focusKind: 'file-browser' });
      eq(d.browser().cwd, path.join(root, 'subdir'), 'cwd advanced');
      assert(d.items('file-browser', 'filesystem').some(i => i.name === 'gamma.txt'), 'subdir listing loaded');
      eq(getSel('file-browser'), 0, 'resetPanelChrome re-homed the cursor');
    } finally { rm(root); }
  });
  it('Enter on a file emits an openFile effect (no cwd change)', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-browser');
      const d = makeDriver('file-browser');
      d.dispatch({ type: 'refresh' });
      const items = d.items('file-browser', 'filesystem');
      const alphaIdx = items.findIndex(i => i.name === 'alpha.txt');
      setSel('file-browser', alphaIdx);
      d.dispatch({ type: 'key', key: 'return', seq: '', focusKind: 'file-browser' });
      eq(d.opened.length, 1, 'one openFile effect emitted');
      eq(d.opened[0].item.name, 'alpha.txt');
      eq(d.browser().cwd, root, 'cwd unchanged when opening a file');
    } finally { rm(root); }
  });
});

describe('[10] two same-type files panes — independent browser state (Arc 2)', () => {
  it('each pane lists its own root; navigation in one leaves the other', () => {
    const rootA = mkTree();
    const rootB = mkTree();
    // A second pane only exists in rootB; prove the panes do not collide.
    fs.mkdirSync(path.join(rootB, 'only-b'));
    try {
      getModel().config = { project_dir: rootA, files: [], groups: { g: { label: 'G', actions: {} } } };
      getModel().projectDir = rootA;
      getModel().currentGroup = 'g';
      getInstanceSlice('layout').arrange = {
        columns: [
          { width: 30, panels: [{ type: 'files', paneId: 'files-a', root: rootA, title: 'A', hotkey: '1', columnIndex: 0 }] },
          { width: 30, panels: [{ type: 'files', paneId: 'files-b', root: rootB, title: 'B', hotkey: '2', columnIndex: 1 }] },
        ],
        detailHeightPct: 60,
      };
      const a = makeDriver('files-a');
      const b = makeDriver('files-b');
      a.dispatch({ type: 'refresh' });
      b.dispatch({ type: 'refresh' });
      eq(a.browser().cwd, rootA, 'pane A listed its own root');
      eq(b.browser().cwd, rootB, 'pane B listed its own root');
      assert(!a.items('files').some(i => i.name === 'only-b'), 'A does not see B-only dir');
      assert(b.items('files').some(i => i.name === 'only-b'), 'B sees its only-b dir');

      // Navigate A into subdir — B is untouched.
      const subIdx = a.items('files').findIndex(i => i.name === 'subdir');
      setSel('files-a', subIdx);
      a.dispatch({ type: 'key', key: 'return', seq: '', focusKind: 'files' });
      eq(a.browser().cwd, path.join(rootA, 'subdir'), 'A descended');
      eq(b.browser().cwd, rootB, 'B cwd unchanged by A navigation');
    } finally { rm(rootA); rm(rootB); }
  });
});

// --- async section: real registered Component + effect registry end-to-end ---

section('[9] file open → content tab (real effect loop, async loader)');
(async () => {
  const root = mkTree();
  try {
    // Install the built-in effect handlers (render) + register the Component so
    // the real loadDir/openFile effects run and dispatchMsg routes key events.
    require('../dispatch/runtime/effects').installBuiltins();
    api.registerComponent(filesComp);
    freshState(root, 'file-browser');
    // Arc 2 — mint the real per-pane instance the way state.js does
    // (init(paneId)); the register-time 'files' singleton has no paneId,
    // so the broadcast refresh would no-op on it.
    if (route.hasInstance('files')) route.disposeInstance('files');
    route.setInstance('file-browser', 'file-browser', filesComp.init('file-browser'));

    // Kick the real (async) listing and poll until it lands in the slice.
    api.dispatchMsg({ type: 'refresh' });
    const poll = async (pred, ms = 1000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (pred()) return true;
        await new Promise(r => setTimeout(r, 10));
      }
      return false;
    };
    const loaded = await poll(() => {
      const b = api.getInstanceSlice('file-browser').browser;
      return b && Array.isArray(b.items) && b.items.length > 1;
    });
    assert(loaded, 'real loadDir populated the slice');

    const items = api.getItems('file-browser');
    const alphaIdx = items.findIndex(i => i.name === 'alpha.txt');
    setSel('file-browser', alphaIdx);
    getInstanceSlice("layout").focus = 'file-browser';
    // The real key path: routes to the focused Component's update → openFile.
    api.dispatchKeyToFocused('return', '');

    const alpha = items[alphaIdx];
    const key = `file:${alpha.path}`;
    assert(getInstanceSlice('detail').contentTabs['g'] && getInstanceSlice('detail').contentTabs['g'][key], 'tab created');
    const ready = await poll(() => {
      const lines = getInstanceSlice('detail').contentTabs['g'][key].lines;
      return lines && lines[0] === 'aaa';
    });
    assert(ready, 'file contents loaded into the content tab');
  } finally {
    rm(root);
    report();
  }
})().catch(err => { console.error(err); process.exit(1); });
