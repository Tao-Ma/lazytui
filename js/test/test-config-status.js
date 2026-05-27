/**
 * config-status plugin smoke test — exercises tab math, category sort,
 * tracked-vs-all filtering, and (in the end-to-end section) real
 * status comparison against a git branch in an ephemeral repo.
 *
 * Most pure-unit tests pre-populate `S.configStatusCache` so they don't
 * trigger the auto-refresh path; the end-to-end suite does the real
 * git work.
 *
 * Run: node js/test/test-config-status.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const cs = require('../plugins/config-status');
const { describe, it, assert, eq, report } = require('./test-runner');

const TUI = path.resolve(__dirname, '..', 'tui.js');
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

// Build an S with files + a pre-populated cache so buildItems
// won't spawn git. `statuses` maps path → status; missing paths default
// to STATUS.UNKNOWN. children = {} so expandEntry treats every
// declared path as a leaf (no fanout — fixture paths are flat strings,
// not real dirs on disk).
function freshS(statuses = {}) {
  const cf = fixtureFiles();
  const byPath = {};
  const children = {};
  for (const e of cf) {
    byPath[e.path] = statuses[e.path] || STATUS.UNKNOWN;
    children[e.path] = [];
  }
  return {
    config: { files: cf },
    configStatusCache: { byPath, children, branch: 'config', computedAt: 0 },
  };
}

describe('[1] tab state — defaults to 0, cycles forward and backward', () => {
  it('default tabIdx is 0 when configStatusTab unset', () => {
    eq(cs._tabIdx({}), 0);
    eq(cs._tabIdx({ configStatusTab: undefined }), 0);
    eq(cs._tabIdx({ configStatusTab: 'bad' }), 0);
    eq(cs._tabIdx({ configStatusTab: 99 }), 0);
  });
  it('cycleTab +1 goes 0 → 1 → 2 → 0', () => {
    const S = {};
    cs._cycleTab(S, 1); eq(cs._tabIdx(S), 1);
    cs._cycleTab(S, 1); eq(cs._tabIdx(S), 2);
    cs._cycleTab(S, 1); eq(cs._tabIdx(S), 0);
  });
  it('cycleTab -1 goes 0 → 2 → 1 → 0', () => {
    const S = {};
    cs._cycleTab(S, -1); eq(cs._tabIdx(S), 2);
    cs._cycleTab(S, -1); eq(cs._tabIdx(S), 1);
    cs._cycleTab(S, -1); eq(cs._tabIdx(S), 0);
  });
});

describe('[2] _byCategory orders headers (secret → config → other → uncategorized)', () => {
  it('all categories present with correct counts (no predicate)', () => {
    const S = freshS();
    const items = cs._byCategory(fixtureFiles(), S, null);
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
    const S = freshS({
      'client/id_ed25519': STATUS.MATCHES,
      'data/dev9/bashrc': STATUS.MATCHES,
    });
    const items = cs._byCategory(fixtureFiles(), S, (s) => s === STATUS.MATCHES);
    const headers = items.filter((i) => i.kind === 'header');
    eq(headers.length, 2, 'secret + config; uncategorized dropped');
    eq(headers[0].count, 1, 'one matching secret');
    eq(headers[1].count, 1, 'one matching config');
  });
});

describe('[3] buildItems dispatches by current tab + applies cache statuses', () => {
  it('tab 0 (file tree) — every declared path with cached status', () => {
    const S = freshS({
      'client/id_ed25519': STATUS.MATCHES,
      'data/dev9/bashrc': STATUS.DIFFERS,
    });
    const items = cs._buildItems(S);
    const files = items.filter((i) => i.kind === 'file');
    eq(files.length, 7);
    eq(files.find((f) => f.path === 'client/id_ed25519').status, STATUS.MATCHES);
    eq(files.find((f) => f.path === 'data/dev9/bashrc').status, STATUS.DIFFERS);
    eq(files.find((f) => f.path === 'extra.txt').status, STATUS.UNKNOWN, 'unknown for missing-from-cache fallback');
  });
  it('tab 1 (tracked tree) — narrows to ✓ / * / ! only', () => {
    const S = freshS({
      'client/id_ed25519': STATUS.MATCHES,
      'client/id_ed25519.pub': STATUS.LOCAL_ONLY,
      'data/openvpn/ca.crt': STATUS.BRANCH_ONLY,
      'data/dev9/bashrc': STATUS.DIFFERS,
    });
    cs._cycleTab(S, 1);
    const items = cs._buildItems(S);
    const files = items.filter((i) => i.kind === 'file');
    const paths = files.map((f) => f.path).sort();
    eq(paths.join(','), 'client/id_ed25519,data/dev9/bashrc,data/openvpn/ca.crt',
       '✓ * ! kept; + and ? excluded');
  });
  it('tab 1 with no tracked files surfaces a note', () => {
    const S = freshS();  // all paths default to ?, none tracked
    cs._cycleTab(S, 1);
    const items = cs._buildItems(S);
    eq(items.length, 1);
    eq(items[0].kind, 'note');
    assert(items[0].text.includes('no tracked paths'));
  });
  it('tab 2 (tracked flat) — same set as tab 1, alphabetical (case-insensitive), no headers', () => {
    const S = freshS({
      'data/dev9/tmux.conf': STATUS.MATCHES,
      'client/id_ed25519': STATUS.DIFFERS,
      'README': STATUS.BRANCH_ONLY,
    });
    cs._cycleTab(S, 2);
    const items = cs._buildItems(S);
    const headers = items.filter((i) => i.kind === 'header');
    eq(headers.length, 0, 'flat view has no category headers');
    const paths = items.filter((i) => i.kind === 'file').map((f) => f.path);
    // localeCompare is case-insensitive: c < d < r (treating README as 'readme').
    eq(paths.join(','), 'client/id_ed25519,data/dev9/tmux.conf,README');
  });
  it('cache.error surfaces a head note in every tab', () => {
    const S = freshS();
    S.configStatusCache.error = 'branch "config" does not exist';
    cs._cycleTab(S, 0);
    const items = cs._buildItems(S);
    eq(items[0].kind, 'note');
    assert(items[0].text.includes('does not exist'));
  });
});

describe('[4] panel onKey — cycles tabs and refreshes', () => {
  const def = require('../plugins/config-status').panelTypes['config-status'];
  it('] advances the tab', () => {
    const S = freshS();
    eq(def.onKey(']', null, S), true);
    eq(cs._tabIdx(S), 1);
  });
  it('[ retreats the tab', () => {
    const S = freshS();
    S.configStatusTab = 1;
    eq(def.onKey('[', null, S), true);
    eq(cs._tabIdx(S), 0);
  });
  it('r clears the cache and schedules a deferred (off-keypress) refresh', () => {
    const S = freshS();
    // Unreachable branch + tmpdir so the deferred refreshStatus bails
    // fast (and harmlessly) when its setImmediate fires after the test.
    S.configStatusBranch = 'definitely-not-a-real-branch-' + Date.now();
    S.projectDir = os.tmpdir();
    eq(def.onKey('r', null, S), true);
    // The keypress no longer blocks on git: the cache is cleared and the
    // recompute is deferred (computing flag set), not run inline.
    eq(S.configStatusCache, null, 'cache cleared synchronously');
    eq(S._configStatusComputing, true, 'recompute scheduled off the keypress path');
  });
  it('any other key passes through', () => {
    const S = freshS();
    eq(def.onKey('x', null, S), false);
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

// Layout matching what the plugin sees: client/, data/openvpn/, etc.
fs.mkdirSync(path.join(TMP, 'client'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'data', 'openvpn'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'data', 'dev9'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-V1\n');
fs.writeFileSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'), 'CA-V1\n');
fs.writeFileSync(path.join(TMP, 'data', 'dev9', 'bashrc'), 'export FOO=bar\n');

// Snapshot to a config branch via the config-branch plugin's logic
// (mirrored inline here so this test is self-contained).
const cb = require('../plugins/config-branch');
const saveScript = cb.groupActions({
  config_branch: {
    branch: 'config',
    paths: ['client', 'data/openvpn', 'data/dev9/bashrc'],
  },
}).save.script;
const saveResult = spawnSync('sh', ['-c', saveScript], { cwd: TMP, encoding: 'utf8' });
if (saveResult.status !== 0) {
  throw new Error(`prepare-branch failed:\n${saveResult.stderr}`);
}

function makeS(overrides = {}) {
  return {
    config: {
      files: [
        { path: 'client/id_ed25519', category: 'secret' },
        { path: 'data/openvpn/ca.crt', category: 'secret' },
        { path: 'data/dev9/bashrc', category: 'config' },
        { path: 'data/dev9/missing.conf', category: 'config' },  // declared but never written
      ],
    },
    configStatusBranch: 'config',
    projectDir: TMP,
    ...overrides,
  };
}

describe('[5] refreshStatus — real git diff against the config branch', () => {
  it('clean snapshot → every saved path matches (✓), missing-local stays !', () => {
    const S = makeS();
    cs._refreshStatus(S);
    const cache = S.configStatusCache;
    eq(cache.byPath['client/id_ed25519'], STATUS.MATCHES, 'client key matches');
    eq(cache.byPath['data/openvpn/ca.crt'], STATUS.MATCHES, 'CA matches');
    eq(cache.byPath['data/dev9/bashrc'], STATUS.MATCHES, 'bashrc matches');
    eq(cache.byPath['data/dev9/missing.conf'], STATUS.UNKNOWN,
       'declared but never written + not in branch → ?');
  });
  it('local edit → status flips to *', () => {
    fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-V2-MUTATED\n');
    const S = makeS();
    cs._refreshStatus(S);
    eq(S.configStatusCache.byPath['client/id_ed25519'], STATUS.DIFFERS);
  });
  it('delete a local path that\'s in branch → !', () => {
    fs.unlinkSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'));
    const S = makeS();
    cs._refreshStatus(S);
    eq(S.configStatusCache.byPath['data/openvpn/ca.crt'], STATUS.BRANCH_ONLY);
  });
  it('add a local file that\'s declared but never saved → +', () => {
    fs.writeFileSync(path.join(TMP, 'data', 'dev9', 'missing.conf'), 'fresh\n');
    const S = makeS();
    cs._refreshStatus(S);
    eq(S.configStatusCache.byPath['data/dev9/missing.conf'], STATUS.LOCAL_ONLY);
  });
  it('branch missing → every path becomes ?, error surfaced', () => {
    const S = makeS({ configStatusBranch: 'nope-' + Date.now() });
    cs._refreshStatus(S);
    const cache = S.configStatusCache;
    assert(cache.error && cache.error.includes('does not exist'), 'error captured');
    for (const v of Object.values(cache.byPath)) eq(v, STATUS.UNKNOWN);
  });
});

describe('[6] buildItems with a real refresh — Tracked tabs hold the right subset', () => {
  it('after a clean refresh, tab 1 shows the in-branch paths, tab 0 shows everything', () => {
    // Restore baseline, refresh once.
    fs.writeFileSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'), 'CA-V1\n');
    fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-V1\n');
    fs.unlinkSync(path.join(TMP, 'data', 'dev9', 'missing.conf'));
    const S = makeS();
    cs._refreshStatus(S);

    // Tab 0 — everything declared appears
    const all = cs._buildItems(S);
    const allFiles = all.filter((i) => i.kind === 'file').map((f) => f.path);
    eq(allFiles.length, 4);

    // Tab 1 — in-branch (non-?) only
    cs._cycleTab(S, 1);
    const tracked = cs._buildItems(S).filter((i) => i.kind === 'file').map((f) => f.path).sort();
    eq(tracked.join(','), 'client/id_ed25519,data/dev9/bashrc,data/openvpn/ca.crt',
       'tracked subset is the three saved files; the never-written one is excluded');
  });
});

// --- [7] Pagination — declared dirs fan out to per-file rows; ---
// "... N more" appears when the dir has > WALK_LIMIT files; pressing
// Enter on it expands by another WALK_LIMIT.

describe('[7] paginated dir expansion', () => {
  // Build a synthetic project root with one declared dir containing
  // 25 files. We don't need a config branch here — we manipulate the
  // cache directly to focus the test on expansion mechanics.
  const PG = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pg-'));
  process.on('exit', () => { try { fs.rmSync(PG, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(PG, 'big'), { recursive: true });
  for (let i = 1; i <= 25; i++) {
    fs.writeFileSync(path.join(PG, 'big', `file-${String(i).padStart(2, '0')}.txt`), `${i}\n`);
  }

  function makeBigS() {
    // Pre-build a cache that mimics what refreshStatus would produce
    // for a 25-file dir, all matching the branch (✓) — then test
    // pagination + Enter-to-expand without spawning git.
    const children = [];
    const byPath = {};
    byPath['big'] = STATUS.MATCHES;
    for (let i = 1; i <= 25; i++) {
      const sub = `big/file-${String(i).padStart(2, '0')}.txt`;
      children.push(sub);
      byPath[sub] = STATUS.MATCHES;
    }
    return {
      config: {
        files: [{ path: 'big', category: 'config' }],
      },
      configStatusCache: {
        branch: 'config', byPath,
        children: { big: children },
        computedAt: 0,
      },
      projectDir: PG,
    };
  }

  it('default expansion shows WALK_LIMIT files + "more" marker', () => {
    const S = makeBigS();
    const items = cs._buildItems(S);
    const fileRows = items.filter((i) => i.kind === 'file');
    eq(fileRows.length, 10, '10 files visible by default (WALK_LIMIT)');
    const moreRows = items.filter((i) => i.kind === 'more');
    eq(moreRows.length, 1, 'one "more" marker');
    eq(moreRows[0].declaredPath, 'big');
    eq(moreRows[0].shown, 10);
    eq(moreRows[0].total, 25);
  });

  it('Enter on the "more" row expands by another WALK_LIMIT', () => {
    const def = require('../plugins/config-status').panelTypes['config-status'];
    const S = makeBigS();
    const moreRow = cs._buildItems(S).find((i) => i.kind === 'more');
    eq(def.onKey('return', moreRow, S), true, 'plugin claims Enter on more row');
    eq(S.configStatusExpanded.big, 20, 'expansion bumped from 10 → 20');

    const items2 = cs._buildItems(S);
    eq(items2.filter((i) => i.kind === 'file').length, 20, '20 files now visible');
    eq(items2.filter((i) => i.kind === 'more').length, 1, 'still 5 more');
  });

  it('repeated Enter eventually shows all and removes the marker', () => {
    const def = require('../plugins/config-status').panelTypes['config-status'];
    const S = makeBigS();
    // Hit Enter twice on more rows
    for (let n = 0; n < 3; n++) {
      const moreRow = cs._buildItems(S).find((i) => i.kind === 'more');
      if (!moreRow) break;
      def.onKey('return', moreRow, S);
    }
    const items = cs._buildItems(S);
    eq(items.filter((i) => i.kind === 'file').length, 25, 'all files shown');
    eq(items.filter((i) => i.kind === 'more').length, 0, 'no more marker');
  });

  it('Enter on a non-"more" row does not crash (file rows now claim Enter for diff view — see [8])', () => {
    const def = require('../plugins/config-status').panelTypes['config-status'];
    const S = makeBigS();
    const fileRow = cs._buildItems(S).find((i) => i.kind === 'file');
    // File rows now claim Enter (drops a preview into detail) — assert
    // the claim happens but don't dig into the diffFor output here;
    // [8] does that against a real git fixture.
    eq(def.onKey('return', fileRow, S), true);
    assert(Array.isArray(S.detailLines), 'detail panel populated');
  });

  it('"more" marker hidden in tracked tabs (predicate filtering)', () => {
    const S = makeBigS();
    cs._cycleTab(S, 1);  // tracked tree
    const items = cs._buildItems(S);
    eq(items.filter((i) => i.kind === 'more').length, 0, 'no pagination marker under filtering');
    // All 25 files have status ✓ → all in tracked
    eq(items.filter((i) => i.kind === 'file').length, 25, 'all tracked rows present');
  });
});

// --- [8] diffFor — Enter on a file row produces a status-aware preview ---

describe('[8] diffFor — preview shape per status', () => {
  // Reuses the real-git fixture from [5]/[6]. Re-set the baseline so
  // we have predictable file states before each diffFor probe. (Yes,
  // this depends on test ordering — same as [5]/[6] do.)
  function baselineS() {
    fs.writeFileSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'), 'CA-V1\n');
    fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-V1\n');
    if (fs.existsSync(path.join(TMP, 'data', 'dev9', 'missing.conf'))) {
      fs.unlinkSync(path.join(TMP, 'data', 'dev9', 'missing.conf'));
    }
    const S = makeS();
    cs._refreshStatus(S);
    return S;
  }

  it('✓ matches → header + "no diff" note', () => {
    const S = baselineS();
    const out = cs._diffFor({ kind: 'file', path: 'client/id_ed25519', status: STATUS.MATCHES }, S);
    assert(out.some((l) => l.includes('client/id_ed25519')), 'header includes path');
    assert(out.some((l) => l.includes('matches branch')), 'no-diff note');
  });

  it('* differs → header + diff body', () => {
    const S = baselineS();
    fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-V2-MUTATED\n');
    const out = cs._diffFor({ kind: 'file', path: 'client/id_ed25519', status: STATUS.DIFFERS }, S);
    const joined = out.join('\n');
    assert(joined.includes('client/id_ed25519'), 'header includes path');
    assert(joined.includes('differs'), 'differs note');
    // git diff --no-index emits both --- and +++ headers; plus the
    // mutated content surfacing in a +line.
    assert(joined.includes('+PRIVATE-V2-MUTATED') || joined.includes('+ PRIVATE-V2-MUTATED'),
           'diff body shows new content');
    assert(joined.includes('-PRIVATE-V1') || joined.includes('- PRIVATE-V1'),
           'diff body shows old content');
  });

  it('+ local-only → head of local file', () => {
    const S = baselineS();
    fs.writeFileSync(path.join(TMP, 'data', 'dev9', 'missing.conf'), 'fresh-content\n');
    const out = cs._diffFor({
      kind: 'file', path: 'data/dev9/missing.conf', status: STATUS.LOCAL_ONLY,
    }, S);
    const joined = out.join('\n');
    assert(joined.includes('local-only'), 'local-only note');
    assert(joined.includes('fresh-content'), 'local content rendered');
  });

  it('! branch-only → head of branch:path content', () => {
    const S = baselineS();
    fs.unlinkSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'));
    const out = cs._diffFor({
      kind: 'file', path: 'data/openvpn/ca.crt', status: STATUS.BRANCH_ONLY,
    }, S);
    const joined = out.join('\n');
    assert(joined.includes('branch-only'), 'branch-only note');
    assert(joined.includes('CA-V1'), 'branch content rendered');
  });

  it('? unknown → short note, no spawn', () => {
    const S = baselineS();
    const out = cs._diffFor({
      kind: 'file', path: 'data/dev9/never-existed', status: STATUS.UNKNOWN,
    }, S);
    const joined = out.join('\n');
    assert(joined.includes('absent on both sides'));
  });

  it('Enter on a file row in tab 0 populates S.detailLines', () => {
    const def = require('../plugins/config-status').panelTypes['config-status'];
    const S = baselineS();
    // Force a known *stale* state for one file so the preview has body
    fs.writeFileSync(path.join(TMP, 'data', 'dev9', 'bashrc'), 'export FOO=mutated\n');
    cs._refreshStatus(S);
    const items = cs._buildItems(S);
    const fileRow = items.find((i) => i.kind === 'file' && i.path === 'data/dev9/bashrc');
    assert(fileRow, 'fixture file present in items');
    eq(def.onKey('return', fileRow, S), true, 'Enter claimed');
    assert(Array.isArray(S.detailLines) && S.detailLines.length > 2, 'detail populated');
    assert(S.detailScroll === 0, 'scroll reset');
  });
});

report();
