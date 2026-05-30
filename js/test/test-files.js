/**
 * files — directory/registry browser (Component / TEA API), plus the legacy
 * file-manager alias (still a Plugin).
 *
 * The Component loads listings ASYNCHRONOUSLY through the effect loop, so the
 * tests drive a small effect pump: `update(msg, slice) → [slice, effects]` is
 * threaded by hand, and each `loadDir` effect is resolved synchronously off
 * the same real os.tmpdir() scratch tree the production effect reads (via the
 * shared _readDirRows). `dirLoaded` is fed back through update() — exactly the
 * Cmd→Msg fold the framework performs.
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
const { getModel } = require('../runtime');
const { getComponentSlice } = require('../components/api');


// Register the file-manager Component so the api facade can resolve the def.
// (test-runner.js already registered layout + detail + groups when required
// above — that's the production order tui.js uses.)
const api = require('../components/api');

const fmMod = require('../components/file-manager');
api.registerComponent(fmMod);
const fmDef = fmMod.panelTypes['file-manager'];

// The files Component. Phase 4a — registering up front so panel-type →
// Component lookup resolves for `getSel`/`setSel`/`setScroll` in sections
// [1-8]. Section [9] re-registers explicitly while exercising the real
// effect loop; re-register is idempotent.
const filesComp = require('../components/files');
api.registerComponent(filesComp);

const { setSel, setScroll, getSel } = require('../state');

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
  getComponentSlice("layout").arrange = {
    leftPanels: [{
      type: panelType, root,
      title: panelType, hotkey: '1', column: 'left',
      ...extraPanelCfg,
    }],
    rightPanels: [],
    leftWidth: 30, detailHeightPct: 60,
  };
  // Phase 4a — only `ui.filters` survives at root; cursor/scroll/multiSel
  // live on each Component's nav slice. Re-home the panels we touch.
  getModel().ui.filters = {};
  setSel(panelType, 0); setScroll(panelType, 0);
  getComponentSlice('detail').contentTabs = {};
  getComponentSlice('detail').ephemeralTerminals = {};
  getComponentSlice('detail').tab = 0;
  getComponentSlice("layout").focus = panelType;
  getComponentSlice('detail').lines = [];
}

/**
 * Effect-pump driver: owns the slice, threads update(), and resolves the
 * effects the Component emits. `loadDir` is read synchronously off the real fs
 * (the same _readDirRows the production effect uses) and folded back via a
 * `dirLoaded` Msg; `resetPanelChrome` mirrors the reducer's panel_reset;
 * `openFile` is captured (the real open is exercised in the async section).
 */
function makeDriver() {
  let slice = filesComp._init();
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
      dispatch({ type: 'dirLoaded', panelType: eff.panelType, cwd: eff.cwd, seq: eff.seq, items, error });
    } else if (eff.type === 'resetPanelChrome') {
      // Mirrors the reducer's panel_reset: cursor/scroll → 0 via wrapped
      // Msgs into the owning Component's nav slice; filter map at root.
      setSel(eff.panel, 0); setScroll(eff.panel, 0);
      delete getModel().ui.filters[eff.panel];
    } else if (eff.type === 'openFile') {
      opened.push(eff);
    }
    // 'render' → no-op in the harness
  }
  function dispatch(msg) {
    const result = filesComp._update(msg, slice);
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
    browser: (panelType) => slice.browsers[panelType],
    opened,
  };
}

describe('[1] file-manager alias — VERBATIM v0.3 def (back-compat)', () => {
  it('returns getModel().config.files items in the original shape', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-manager');
      const items = fmDef.getItems();
      const paths = items.map(i => i.path);
      eq(items.length, 2, 'two declared entries');
      assert(paths.includes('README.md') && paths.includes('src/main.js'));
      assert(items.every(i => i.kind === undefined), 'legacy def: no kind field');
      assert(items.every(i => typeof i.path === 'string'), 'items have path');
    } finally { rm(root); }
  });
  it('no onKey: pressing Enter is unclaimed (v0.3 behavior)', () => {
    eq(fmDef.onKey, undefined, 'no onKey on the legacy alias def');
  });
  it('no customFilter: framework substring filter still owns the / pipeline', () => {
    eq(fmDef.customFilter, undefined);
    eq(typeof fmDef.filterText, 'function', 'filterText still exposed for framework substring');
    eq(fmDef.filterText({ path: 'README.md' }), 'README.md');
  });
});

describe('[2] file-browser — filesystem source, loaded via the effect loop', () => {
  it('lists dirs first then files, dotfiles hidden', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-browser');
      const d = makeDriver();
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
      const d = makeDriver();
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
      const d = makeDriver();
      d.dispatch({ type: 'refresh' });
      // declared source is a pure projection: no browser slot was created.
      eq(d.browser('files'), undefined, 'no fs load kicked for declared');
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
      const d = makeDriver();
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
      const d = makeDriver();
      d.dispatch({ type: 'refresh' });

      getModel().ui.filters['file-browser'] = 'be';
      const names1 = d.items('file-browser', 'filesystem').map(i => i.name);
      assert(names1.includes('beta.txt') && names1.includes('..'));
      assert(!names1.includes('alpha.txt'));

      getModel().ui.filters['file-browser'] = '[';
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
      const d = makeDriver();
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
      const d = makeDriver();
      d.dispatch({ type: 'refresh' });
      const items = d.items('file-browser', 'filesystem');
      const subIdx = items.findIndex(i => i.name === 'subdir');
      assert(subIdx >= 0, 'subdir present');
      setSel('file-browser', subIdx);
      d.dispatch({ type: 'key', key: 'return', seq: '' });
      eq(d.browser('file-browser').cwd, path.join(root, 'subdir'), 'cwd advanced');
      assert(d.items('file-browser', 'filesystem').some(i => i.name === 'gamma.txt'), 'subdir listing loaded');
      eq(getSel('file-browser'), 0, 'resetPanelChrome re-homed the cursor');
    } finally { rm(root); }
  });
  it('Enter on a file emits an openFile effect (no cwd change)', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-browser');
      const d = makeDriver();
      d.dispatch({ type: 'refresh' });
      const items = d.items('file-browser', 'filesystem');
      const alphaIdx = items.findIndex(i => i.name === 'alpha.txt');
      setSel('file-browser', alphaIdx);
      d.dispatch({ type: 'key', key: 'return', seq: '' });
      eq(d.opened.length, 1, 'one openFile effect emitted');
      eq(d.opened[0].item.name, 'alpha.txt');
      eq(d.browser('file-browser').cwd, root, 'cwd unchanged when opening a file');
    } finally { rm(root); }
  });
});

// --- async section: real registered Component + effect registry end-to-end ---

section('[9] file open → content tab (real effect loop, async loader)');
(async () => {
  const root = mkTree();
  try {
    // Install the built-in effect handlers (render) + register the Component so
    // the real loadDir/openFile effects run and dispatchMsg routes key events.
    require('../effects').installBuiltins();
    api.registerComponent(filesComp);
    freshState(root, 'file-browser');

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
      const b = api.getComponentSlice('files').browsers['file-browser'];
      return b && Array.isArray(b.items) && b.items.length > 1;
    });
    assert(loaded, 'real loadDir populated the slice');

    const items = api.getItems('file-browser');
    const alphaIdx = items.findIndex(i => i.name === 'alpha.txt');
    setSel('file-browser', alphaIdx);
    getComponentSlice("layout").focus = 'file-browser';
    // The real key path: routes to the focused Component's update → openFile.
    api.dispatchMsg({ type: 'key', key: 'return', seq: '' });

    const alpha = items[alphaIdx];
    const key = `file:${alpha.path}`;
    assert(getComponentSlice('detail').contentTabs['g'] && getComponentSlice('detail').contentTabs['g'][key], 'tab created');
    const ready = await poll(() => {
      const lines = getComponentSlice('detail').contentTabs['g'][key].lines;
      return lines && lines[0] === 'aaa';
    });
    assert(ready, 'file contents loaded into the content tab');
  } finally {
    rm(root);
    report();
  }
})().catch(err => { console.error(err); process.exit(1); });
