/**
 * config-status (Component) — tab math, category sort, tracked-vs-all
 * filtering, the update() reducer + effects, and (end-to-end) real status
 * comparison against a git branch in an ephemeral repo.
 *
 * State lives in the component slice (not S). Pure helpers take the slice /
 * explicit args; the reducer is cs._update(msg, slice). The blocking git work
 * is cs._computeStatus(branch, files, projectDir).
 *
 * Run: node js/test/test-config-status.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const cs = require('../panel/navigator/config-status');
const effects = require('../dispatch/effects');
const { getModel } = require('../app/runtime');
const api = require('../panel/api');
// Phase 4a — `getSel('config-status')` walks panel-type → owning
// Component → that Component's slice.nav, so the Component must be
// registered (layout first per Phase 3) for the helper to resolve.
api.registerComponent(require('../panel/layout'));
api.registerComponent(cs);
const { setSel } = require('../app/state');
const { describe, it, assert, eq, report } = require('./test-runner');

const STATUS = cs.STATUS;

function fixtureFiles() {
  return [
    { path: 'client/id_ed25519', category: 'secret' },
    { path: 'client/id_ed25519.pub', category: 'secret' },
    { path: 'data/openvpn/ca.crt', category: 'secret' },
    { path: 'data/dev9/bashrc', category: 'config' },
    { path: 'data/dev9/tmux.conf', category: 'config' },
    { path: 'README', category: undefined },     // uncategorized
    { path: 'extra.txt' },                       // no category at all
  ];
}

// A slice + its files, with a pre-populated cache so buildItems won't need git.
// `statuses` maps path → status (default ?); children = {} so every declared
// path is a leaf (fixture paths are flat strings, not real dirs).
function freshSlice(statuses = {}) {
  const cf = fixtureFiles();
  const byPath = {}, children = {};
  for (const e of cf) { byPath[e.path] = statuses[e.path] || STATUS.UNKNOWN; children[e.path] = []; }
  return {
    cf,
    slice: { tab: 0, expanded: {}, branch: 'config', computing: false,
             cache: { byPath, children, branch: 'config', computedAt: 0 } },
  };
}

// Apply a key Msg, returning the next slice (drops any effects).
function keyUpdate(slice, key) {
  const r = cs._update({ type: 'key', key }, slice);
  return Array.isArray(r) ? r[0] : r;
}

// Point the framework cursor (which the Enter handler re-derives the selected
// row from) + the files the reducer reads via _files().
function setCursor(files, idx) {
  const m = getModel();
  m.config = { files };
  // Phase 4a — cursor lives on the Component's nav slice; write via the
  // helper (which dispatches a wrapped set_cursor Msg → Component update).
  setSel('config-status', idx);
}

describe('[1] tab cycling via the reducer', () => {
  it('] advances 0 → 1 → 2 → 0', () => {
    let { slice } = freshSlice();
    slice = keyUpdate(slice, ']'); eq(slice.tab, 1);
    slice = keyUpdate(slice, ']'); eq(slice.tab, 2);
    slice = keyUpdate(slice, ']'); eq(slice.tab, 0);
  });
  it('[ retreats 0 → 2 → 1 → 0', () => {
    let { slice } = freshSlice();
    slice = keyUpdate(slice, '['); eq(slice.tab, 2);
    slice = keyUpdate(slice, '['); eq(slice.tab, 1);
    slice = keyUpdate(slice, '['); eq(slice.tab, 0);
  });
  it('tabIdx tolerates a malformed slice', () => {
    eq(cs._tabIdx({}), 0);
    eq(cs._tabIdx({ tab: 'bad' }), 0);
    eq(cs._tabIdx({ tab: 99 }), 0);
  });
  it('an unrelated key leaves the slice unchanged', () => {
    const { slice } = freshSlice();
    eq(keyUpdate(slice, 'x'), slice);
  });
});

describe('[2] _byCategory orders headers (secret → config → other → uncategorized)', () => {
  it('all categories present with correct counts (no predicate)', () => {
    const { cf, slice } = freshSlice();
    const items = cs._byCategory(cf, slice, null);
    const headers = items.filter((i) => i.kind === 'header');
    eq(headers.length, 3, 'three categories present');
    eq(headers[0].cat, 'secret', 'secret first');
    eq(headers[0].count, 3);
    eq(headers[1].cat, 'config', 'config second');
    eq(headers[1].count, 2);
    eq(headers[2].cat, 'uncategorized', 'uncategorized last');
    eq(headers[2].count, 2);
  });
  it('predicate filters per-file; categories with no surviving files are dropped', () => {
    const { cf, slice } = freshSlice({
      'client/id_ed25519': STATUS.MATCHES,
      'data/dev9/bashrc': STATUS.MATCHES,
    });
    const items = cs._byCategory(cf, slice, (s) => s === STATUS.MATCHES);
    const headers = items.filter((i) => i.kind === 'header');
    eq(headers.length, 2, 'secret + config; uncategorized dropped');
    eq(headers[0].count, 1, 'one matching secret');
    eq(headers[1].count, 1, 'one matching config');
  });
});

describe('[3] buildItems dispatches by current tab + applies cache statuses', () => {
  it('tab 0 (file tree) — every declared path with cached status', () => {
    const { cf, slice } = freshSlice({
      'client/id_ed25519': STATUS.MATCHES,
      'data/dev9/bashrc': STATUS.DIFFERS,
    });
    const items = cs._buildItems(slice, cf);
    const files = items.filter((i) => i.kind === 'file');
    eq(files.length, 7);
    eq(files.find((f) => f.path === 'client/id_ed25519').status, STATUS.MATCHES);
    eq(files.find((f) => f.path === 'data/dev9/bashrc').status, STATUS.DIFFERS);
    eq(files.find((f) => f.path === 'extra.txt').status, STATUS.UNKNOWN, 'unknown for missing-from-cache fallback');
  });
  it('tab 1 (tracked tree) — narrows to ✓ / * / ! only', () => {
    let { cf, slice } = freshSlice({
      'client/id_ed25519': STATUS.MATCHES,
      'client/id_ed25519.pub': STATUS.LOCAL_ONLY,
      'data/openvpn/ca.crt': STATUS.BRANCH_ONLY,
      'data/dev9/bashrc': STATUS.DIFFERS,
    });
    slice = keyUpdate(slice, ']');
    const items = cs._buildItems(slice, cf);
    const files = items.filter((i) => i.kind === 'file');
    const paths = files.map((f) => f.path).sort();
    eq(paths.join(','), 'client/id_ed25519,data/dev9/bashrc,data/openvpn/ca.crt',
       '✓ * ! kept; + and ? excluded');
  });
  it('tab 1 with no tracked files surfaces a note', () => {
    let { cf, slice } = freshSlice();  // all paths default to ?, none tracked
    slice = keyUpdate(slice, ']');
    const items = cs._buildItems(slice, cf);
    eq(items.length, 1);
    eq(items[0].kind, 'note');
    assert(items[0].text.includes('no tracked paths'));
  });
  it('tab 2 (tracked flat) — same set as tab 1, alphabetical (case-insensitive), no headers', () => {
    let { cf, slice } = freshSlice({
      'data/dev9/tmux.conf': STATUS.MATCHES,
      'client/id_ed25519': STATUS.DIFFERS,
      'README': STATUS.BRANCH_ONLY,
    });
    slice = keyUpdate(slice, ']'); slice = keyUpdate(slice, ']');
    const items = cs._buildItems(slice, cf);
    const headers = items.filter((i) => i.kind === 'header');
    eq(headers.length, 0, 'flat view has no category headers');
    const paths = items.filter((i) => i.kind === 'file').map((f) => f.path);
    eq(paths.join(','), 'client/id_ed25519,data/dev9/tmux.conf,README');
  });
  it('cache.error surfaces a head note in every tab', () => {
    const { cf, slice } = freshSlice();
    slice.cache.error = 'branch "config" does not exist';
    const items = cs._buildItems(slice, cf);
    eq(items[0].kind, 'note');
    assert(items[0].text.includes('does not exist'));
  });
});

describe('[4] update() reducer — refresh→compute→result loop', () => {
  it('refresh kicks a compute (computing flag + cfgStatusCompute effect)', () => {
    const { slice } = freshSlice();
    const r = cs._update({ type: 'refresh' }, { ...slice, computing: false });
    assert(Array.isArray(r), 'returns [slice, effects]');
    eq(r[0].computing, true, 'computing flag set');
    eq(r[1][0].type, 'cfgStatusCompute', 'compute effect emitted');
  });
  it('a second refresh while computing is a no-op', () => {
    const { slice } = freshSlice();
    const r = cs._update({ type: 'refresh' }, { ...slice, computing: true });
    assert(!Array.isArray(r), 'no effects');
    eq(r.computing, true);
  });
  it('cfgStatusResult folds the cache into the slice + requests a render', () => {
    const { slice } = freshSlice();
    const cache = { byPath: { a: STATUS.MATCHES }, children: {}, branch: 'config', computedAt: 1 };
    const r = cs._update({ type: 'cfgStatusResult', cache }, { ...slice, computing: true });
    eq(r[0].cache, cache, 'cache folded in');
    eq(r[0].computing, false, 'computing cleared');
    eq(r[1][0].type, 'render', 'render requested');
  });
});

// --- End-to-end: real git repo, real status comparison ---

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout;
}

git(TMP, 'init', '--quiet', '--initial-branch=main');
git(TMP, 'config', 'user.email', 'test@example.com');
git(TMP, 'config', 'user.name', 'Test');
fs.writeFileSync(path.join(TMP, 'README.md'), 'init\n');
git(TMP, 'add', 'README.md');
git(TMP, 'commit', '-m', 'init', '--quiet');

fs.mkdirSync(path.join(TMP, 'client'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'data', 'openvpn'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'data', 'dev9'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-V1\n');
fs.writeFileSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'), 'CA-V1\n');
fs.writeFileSync(path.join(TMP, 'data', 'dev9', 'bashrc'), 'export FOO=bar\n');

const cb = require('../panel/navigator/config-branch');
const saveScript = cb.groupActions({
  config_branch: { branch: 'config', paths: ['client', 'data/openvpn', 'data/dev9/bashrc'] },
}).save.script;
const saveResult = spawnSync('sh', ['-c', saveScript], { cwd: TMP, encoding: 'utf8' });
if (saveResult.status !== 0) throw new Error(`prepare-branch failed:\n${saveResult.stderr}`);

const E2E_FILES = [
  { path: 'client/id_ed25519', category: 'secret' },
  { path: 'data/openvpn/ca.crt', category: 'secret' },
  { path: 'data/dev9/bashrc', category: 'config' },
  { path: 'data/dev9/missing.conf', category: 'config' },  // declared but never written
];

describe('[5] computeStatus — real git diff against the config branch', () => {
  it('clean snapshot → every saved path matches (✓), missing-local stays ?', () => {
    const cache = cs._computeStatus('config', E2E_FILES, TMP);
    eq(cache.byPath['client/id_ed25519'], STATUS.MATCHES, 'client key matches');
    eq(cache.byPath['data/openvpn/ca.crt'], STATUS.MATCHES, 'CA matches');
    eq(cache.byPath['data/dev9/bashrc'], STATUS.MATCHES, 'bashrc matches');
    eq(cache.byPath['data/dev9/missing.conf'], STATUS.UNKNOWN,
       'declared but never written + not in branch → ?');
  });
  it('local edit → status flips to *', () => {
    fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-V2-MUTATED\n');
    const cache = cs._computeStatus('config', E2E_FILES, TMP);
    eq(cache.byPath['client/id_ed25519'], STATUS.DIFFERS);
  });
  it('delete a local path that\'s in branch → !', () => {
    fs.unlinkSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'));
    const cache = cs._computeStatus('config', E2E_FILES, TMP);
    eq(cache.byPath['data/openvpn/ca.crt'], STATUS.BRANCH_ONLY);
  });
  it('add a local file that\'s declared but never saved → +', () => {
    fs.writeFileSync(path.join(TMP, 'data', 'dev9', 'missing.conf'), 'fresh\n');
    const cache = cs._computeStatus('config', E2E_FILES, TMP);
    eq(cache.byPath['data/dev9/missing.conf'], STATUS.LOCAL_ONLY);
  });
  it('branch missing → every path becomes ?, error surfaced', () => {
    const cache = cs._computeStatus('nope-' + Date.now(), E2E_FILES, TMP);
    assert(cache.error && cache.error.includes('does not exist'), 'error captured');
    for (const v of Object.values(cache.byPath)) eq(v, STATUS.UNKNOWN);
  });
});

describe('[6] buildItems with a real cache — Tracked tabs hold the right subset', () => {
  it('after a clean refresh, tab 1 shows the in-branch paths, tab 0 shows everything', () => {
    fs.writeFileSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'), 'CA-V1\n');
    fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-V1\n');
    if (fs.existsSync(path.join(TMP, 'data', 'dev9', 'missing.conf'))) {
      fs.unlinkSync(path.join(TMP, 'data', 'dev9', 'missing.conf'));
    }
    const cache = cs._computeStatus('config', E2E_FILES, TMP);
    let slice = { tab: 0, expanded: {}, branch: 'config', computing: false, cache };

    const all = cs._buildItems(slice, E2E_FILES).filter((i) => i.kind === 'file').map((f) => f.path);
    eq(all.length, 4);

    slice = keyUpdate(slice, ']');
    const tracked = cs._buildItems(slice, E2E_FILES).filter((i) => i.kind === 'file').map((f) => f.path).sort();
    eq(tracked.join(','), 'client/id_ed25519,data/dev9/bashrc,data/openvpn/ca.crt',
       'tracked subset is the three saved files; the never-written one is excluded');
  });
});

// --- [7] Pagination — declared dirs fan out to per-file rows ---

describe('[7] paginated dir expansion', () => {
  function bigCache() {
    const children = [];
    const byPath = { big: STATUS.MATCHES };
    for (let i = 1; i <= 25; i++) {
      const sub = `big/file-${String(i).padStart(2, '0')}.txt`;
      children.push(sub);
      byPath[sub] = STATUS.MATCHES;
    }
    return { branch: 'config', byPath, children: { big: children }, computedAt: 0 };
  }
  const BIG_FILES = [{ path: 'big', category: 'config' }];
  function bigSlice() {
    return { tab: 0, expanded: {}, branch: 'config', computing: false, cache: bigCache() };
  }

  it('default expansion shows WALK_LIMIT files + "more" marker', () => {
    const items = cs._buildItems(bigSlice(), BIG_FILES);
    eq(items.filter((i) => i.kind === 'file').length, 10, '10 files visible by default (WALK_LIMIT)');
    const moreRows = items.filter((i) => i.kind === 'more');
    eq(moreRows.length, 1, 'one "more" marker');
    eq(moreRows[0].declaredPath, 'big');
    eq(moreRows[0].shown, 10);
    eq(moreRows[0].total, 25);
  });

  it('Enter on the "more" row expands by another WALK_LIMIT', () => {
    let slice = bigSlice();
    const items = cs._buildItems(slice, BIG_FILES);
    const moreIdx = items.findIndex((i) => i.kind === 'more');
    setCursor(BIG_FILES, moreIdx);
    slice = keyUpdate(slice, 'return');
    eq(slice.expanded.big, 20, 'expansion bumped from 10 → 20');

    const items2 = cs._buildItems(slice, BIG_FILES);
    eq(items2.filter((i) => i.kind === 'file').length, 20, '20 files now visible');
    eq(items2.filter((i) => i.kind === 'more').length, 1, 'still 5 more');
  });

  it('repeated Enter eventually shows all and removes the marker', () => {
    let slice = bigSlice();
    for (let n = 0; n < 3; n++) {
      const items = cs._buildItems(slice, BIG_FILES);
      const moreIdx = items.findIndex((i) => i.kind === 'more');
      if (moreIdx < 0) break;
      setCursor(BIG_FILES, moreIdx);
      slice = keyUpdate(slice, 'return');
    }
    const items = cs._buildItems(slice, BIG_FILES);
    eq(items.filter((i) => i.kind === 'file').length, 25, 'all files shown');
    eq(items.filter((i) => i.kind === 'more').length, 0, 'no more marker');
  });

  it('"more" marker hidden in tracked tabs (predicate filtering)', () => {
    let slice = keyUpdate(bigSlice(), ']');  // tracked tree
    const items = cs._buildItems(slice, BIG_FILES);
    eq(items.filter((i) => i.kind === 'more').length, 0, 'no pagination marker under filtering');
    eq(items.filter((i) => i.kind === 'file').length, 25, 'all tracked rows present');
  });
});

// --- [8] diffFor + the cfgStatusDiff effect ---

describe('[8] diffFor — preview shape per status', () => {
  function baseline() {
    fs.writeFileSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'), 'CA-V1\n');
    fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-V1\n');
    if (fs.existsSync(path.join(TMP, 'data', 'dev9', 'missing.conf'))) {
      fs.unlinkSync(path.join(TMP, 'data', 'dev9', 'missing.conf'));
    }
  }

  it('✓ matches → header + "no diff" note', () => {
    baseline();
    const out = cs._diffFor({ kind: 'file', path: 'client/id_ed25519', status: STATUS.MATCHES }, 'config', TMP);
    assert(out.some((l) => l.includes('client/id_ed25519')), 'header includes path');
    assert(out.some((l) => l.includes('matches branch')), 'no-diff note');
  });

  it('* differs → header + diff body', () => {
    baseline();
    fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-V2-MUTATED\n');
    const out = cs._diffFor({ kind: 'file', path: 'client/id_ed25519', status: STATUS.DIFFERS }, 'config', TMP);
    const joined = out.join('\n');
    assert(joined.includes('client/id_ed25519'), 'header includes path');
    assert(joined.includes('differs'), 'differs note');
    assert(joined.includes('+PRIVATE-V2-MUTATED') || joined.includes('+ PRIVATE-V2-MUTATED'),
           'diff body shows new content');
    assert(joined.includes('-PRIVATE-V1') || joined.includes('- PRIVATE-V1'),
           'diff body shows old content');
  });

  it('+ local-only → head of local file', () => {
    baseline();
    fs.writeFileSync(path.join(TMP, 'data', 'dev9', 'missing.conf'), 'fresh-content\n');
    const out = cs._diffFor({ kind: 'file', path: 'data/dev9/missing.conf', status: STATUS.LOCAL_ONLY }, 'config', TMP);
    const joined = out.join('\n');
    assert(joined.includes('local-only'), 'local-only note');
    assert(joined.includes('fresh-content'), 'local content rendered');
  });

  it('! branch-only → head of branch:path content', () => {
    baseline();
    fs.unlinkSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'));
    const out = cs._diffFor({ kind: 'file', path: 'data/openvpn/ca.crt', status: STATUS.BRANCH_ONLY }, 'config', TMP);
    const joined = out.join('\n');
    assert(joined.includes('branch-only'), 'branch-only note');
    assert(joined.includes('CA-V1'), 'branch content rendered');
  });

  it('? unknown → short note, no spawn', () => {
    const out = cs._diffFor({ kind: 'file', path: 'data/dev9/never-existed', status: STATUS.UNKNOWN }, 'config', TMP);
    assert(out.join('\n').includes('absent on both sides'));
  });

  it('Enter on a file row runs cfgStatusDiff → populates the detail panel', () => {
    effects.installBuiltins();  // setDetail effect (cfgStatusDiff calls state.setDetail directly)
    // Phase B: setDetail routes via dispatchMsg → detail Component; register it.
    require('../panel/api').registerComponent(require('../panel/viewer/viewer'));
    baseline();
    fs.writeFileSync(path.join(TMP, 'data', 'dev9', 'bashrc'), 'export FOO=mutated\n');
    const cache = cs._computeStatus('config', E2E_FILES, TMP);
    const slice = { tab: 0, expanded: {}, branch: 'config', computing: false, cache };
    const items = cs._buildItems(slice, E2E_FILES);
    const idx = items.findIndex((i) => i.kind === 'file' && i.path === 'data/dev9/bashrc');
    assert(idx >= 0, 'fixture file present in items');
    setCursor(E2E_FILES, idx);
    const r = cs._update({ type: 'key', key: 'return' }, slice);
    assert(Array.isArray(r) && r[1][0].type === 'cfgStatusDiff', 'Enter on a file emits cfgStatusDiff');
    effects.runEffects(r[1]);  // run the diff effect → setDetail → viewer slice
    const md = require('../panel/api').getComponentSlice('detail');
    assert(Array.isArray(md.lines) && md.lines.length > 2, 'detail populated');
    eq(md.scroll, 0, 'scroll reset');
  });
});

report();
