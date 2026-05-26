/**
 * `files` panel — unified plugin covering source: declared|filesystem|both
 * plus the file-manager / file-browser legacy aliases.
 *
 * Uses a real os.tmpdir() scratch tree so dir-listing exercises real fs.
 * The async file-open path polls for completion (fs.promises sits on
 * libuv's threadpool — setImmediate alone won't suffice).
 *
 * Run: node js/test/test-files.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { S } = require('../state');
const { describe, it, eq, assert, section, report } = require('./test-runner');

// Register the unified core plugin so api.getItems can find the defs.
const corePlugin = require('../plugins/core');
const api = require('../plugins/api');
api.registerPlugin(corePlugin);

const filesMod = require('../plugins/core/files');
const filesDef     = filesMod.find(e => e.panelType === 'files').def;
const fmDef        = filesMod.find(e => e.panelType === 'file-manager').def;
const fbDef        = filesMod.find(e => e.panelType === 'file-browser').def;
const fbCommands   = filesMod.find(e => e.commands).commands;

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
  S.config = {
    project_dir: root,
    files: [
      { path: 'README.md', desc: 'project readme', var: null, exclude: [], category: null },
      { path: 'src/main.js', desc: null, var: null, exclude: [], category: 'code' },
    ],
    groups: { g: { label: 'G', actions: { noop: { cmd: 'true', label: 'Noop' } } } },
  };
  S.projectDir = root;
  S.currentGroup = 'g';
  S.layout = {
    leftPanels: [{
      type: panelType, root,
      title: panelType, hotkey: '1', column: 'left',
      ...extraPanelCfg,
    }],
    rightPanels: [],
    leftWidth: 30, detailHeightPct: 60,
  };
  S.sel = {}; S.scroll = {}; S.filters = {};
  S.fileBrowser = null;
  S.contentTabs = {};
  S.ephemeralTerminals = {};
  S.activeTab = 0;
  S.focus = panelType;
  S.detailLines = [];
}

describe('[1] file-manager alias — VERBATIM v0.3 def (back-compat)', () => {
  it('returns S.config.files items in the original shape', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-manager');
      const items = fmDef.getItems(S);
      const paths = items.map(i => i.path);
      eq(items.length, 2, 'two declared entries');
      assert(paths.includes('README.md') && paths.includes('src/main.js'));
      // v0.3 shape: no `kind` field, no `name` field — bare YAML record.
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
  it('ignores fs dirs entirely', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-manager');
      const items = fmDef.getItems(S);
      assert(!items.some(i => i.name === 'subdir'));
      assert(!items.some(i => i.name === 'alpha.txt'));
    } finally { rm(root); }
  });
});

describe('[2] file-browser alias — filesystem source', () => {
  it('lists dirs first then files, dotfiles hidden', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-browser');
      const names = fbDef.getItems(S).map(i => i.name);
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
      const names = filesDef.getItems(S).map(i => i.name);
      eq(names[0], '..');
      assert(names.includes('alpha.txt'));
    } finally { rm(root); }
  });
});

describe('[4] files with source: declared — same as file-manager alias', () => {
  it('reads S.config.files', () => {
    const root = mkTree();
    try {
      freshState(root, 'files', { source: 'declared' });
      const names = filesDef.getItems(S).map(i => i.name);
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
      const items = filesDef.getItems(S);
      // Declared come first (kind=declared), then parent + dirs + files
      eq(items[0].kind, 'declared');
      eq(items[1].kind, 'declared');
      // Find the parent
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
      S.filters['file-browser'] = 'be';
      const names1 = fbDef.getItems(S).map(i => i.name);
      assert(names1.includes('beta.txt') && names1.includes('..'));
      assert(!names1.includes('alpha.txt'));

      S.filters['file-browser'] = '[';
      const names2 = fbDef.getItems(S).map(i => i.name);
      assert(names2.includes('alpha.txt') && names2.includes('beta.txt'),
        'invalid regex passes everything through');
    } finally { rm(root); }
  });
});

describe('[7] :show-hidden cmdline command', () => {
  it('toggles dotfile visibility', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-browser');
      const cmd = fbCommands.find(c => c.name === 'show-hidden');
      cmd.run(['on'], S);
      const names = fbDef.getItems(S).map(i => i.name);
      assert(names.includes('.hidden'));
      cmd.run(['off'], S);
      const names2 = fbDef.getItems(S).map(i => i.name);
      assert(!names2.includes('.hidden'));
    } finally { rm(root); }
  });
});

describe('[8] onKey — Enter on dir navigates; on declared no-op-cd', () => {
  it('navigating filesystem dirs updates S.fileBrowser.cwd', () => {
    const root = mkTree();
    try {
      freshState(root, 'file-browser');
      const items = fbDef.getItems(S);
      const sub = items.find(i => i.name === 'subdir');
      fbDef.onKey('return', sub, S);
      eq(S.fileBrowser.cwd, path.join(root, 'subdir'));
      assert(fbDef.getItems(S).some(i => i.name === 'gamma.txt'));
    } finally { rm(root); }
  });
});

// --- async section ---

section('[9] file open → content tab (async loader)');
(async () => {
  const root = mkTree();
  try {
    freshState(root, 'file-browser');
    const items = fbDef.getItems(S);
    const alpha = items.find(i => i.name === 'alpha.txt');
    fbDef.onKey('return', alpha, S);
    // Synchronous placeholder
    const key = `file:${alpha.path}`;
    assert(S.contentTabs['g'] && S.contentTabs['g'][key], 'tab created');
    // Async: poll up to ~500ms for the loader to resolve
    const start = Date.now();
    let lines;
    while (Date.now() - start < 500) {
      lines = S.contentTabs['g'][key].lines;
      if (lines && lines[0] === 'aaa') break;
      await new Promise(r => setTimeout(r, 10));
    }
    eq(lines[0], 'aaa', 'file contents loaded');
  } finally {
    rm(root);
    report();
  }
})().catch(err => { console.error(err); process.exit(1); });
