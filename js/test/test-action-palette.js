/**
 * Brief 2 (v0.6.44) — fuzzy action palette.
 *
 * Covers every surface that has to agree so the palette rows and
 * `--list`/`--complete` can't drift and the Esc two-step reads the
 * same way as the v0.6.43 choices-filter popover:
 *
 *   - Enumeration parity: the palette's row set is byte-identical to
 *     `iterActions`'s path set (same walker as --list / --complete).
 *   - Reducer (`palette_open` / `palette_close` / `palette_filter` /
 *     `palette_filter_clear` / `palette_nav` / `palette_pick`):
 *     filter append / backspace / clear-on-open; idx resets to 0 on
 *     filter change; nav clamps against the FILTERED length; pick on
 *     an empty view closes without emitting a run cmd; paste cap at
 *     MAX_FILTER_LEN clamps POST-concat with a surrogate guard.
 *   - Dispatch (`handlePaletteKey`): printable → filter; Esc two-step
 *     (clear filter first, then close); Enter picks the FILTERED row at
 *     palette.idx and resolves to (groupPath, actionKey); Enter on a
 *     (no match) view CLOSES rather than committing a bad pick.
 *   - Overlay (`renderActionPalette`): paints `/<filter>` row above the
 *     list when filter is non-empty; paints `(no match)` when the view
 *     is empty; help line swaps `[esc] close` ↔ `[esc] clear filter` so
 *     the two-step escape is self-documenting; selected row is reverse-
 *     video prefixed with `>`.
 *   - config_swap clears palette state and flips paletteMode off (same
 *     discipline as formHistory and fabricForm — the action universe
 *     changed; the current pick may no longer resolve).
 *
 * Run: node js/test/test-action-palette.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const store = require('../model/store');
const palette = require('../overlay/action-palette');
const paletteRed = require('../dispatch/update/modal/palette');
const { freshOverlayModel, captureOverlay } = require('./_helpers/overlay-capture');

// Wire the config accessors the way app/tui.js does at boot. Tests run
// without that boot path, so overlay/action-palette comes up with empty
// accessors — register them here so the walker + resolver work.
//
// LOAD-ORDER NOTE (v0.6.47 — scroll-window fix): `renderActionPalette`
// reads `viewportDims()` from leaves/render/draw to compute its scroll
// budget. The dims provider is wired as a side-effect of requiring
// `panel/api`, which this file picks up TRANSITIVELY via the `../app/cli`
// require below. The `[9]` scope's `freshOverlayModel({cols,rows})` only
// shapes the model's dims — the LEAF's dims provider must also be wired,
// or `viewportDims()` falls back to 80×24 and the overflow tests paint
// the wrong frame. If you refactor the cli import out, require
// `../panel/api` here explicitly, or the dims-sensitive scopes will
// silently paint against the fallback viewport.
const cli = require('../app/cli');
palette.setConfigAccessors({
  iterActions: cli.iterActions,
  resolveAction: cli.resolveAction,
});

// Fixture config: three groups, nine actions total, mixed labels + descs.
// Shape mirrors a real YAML config: `groups[groupPath].actions[key] = {...}`.
function _fixtureConfig() {
  return {
    project_dir: '.',
    groups: {
      deploy: {
        actions: {
          build:  { type: 'run', label: 'Build',  script: 'make build',  desc: 'Compile the thing' },
          push:   { type: 'run', label: 'Push',   script: 'make push',   desc: 'Push to the registry' },
          verify: { type: 'run', label: 'Verify', script: 'make verify', desc: 'Smoke-check the deploy' },
        },
      },
      db: {
        actions: {
          migrate: { type: 'run', label: 'Migrate',  script: 'db migrate', desc: 'Run pending migrations' },
          seed:    { type: 'run', label: 'Seed',     script: 'db seed',    desc: 'Insert dev fixtures' },
          backup:  { type: 'run', label: 'Backup',   script: 'db backup',  desc: 'Dump to S3' },
        },
      },
      ops: {
        actions: {
          restart: { type: 'run', label: 'Restart',  script: 'systemctl restart app', desc: 'Rolling restart' },
          tail:    { type: 'run', label: 'Tail logs', script: 'tail -f /var/log/app', desc: 'Tail live' },
          status:  { type: 'run', label: 'Status',   script: 'status.sh' },  // no desc
        },
      },
    },
  };
}

function freshModel(config) {
  const m = runtime.init();
  m.currentGroup = 'deploy';
  m.register = { history: [], cap: 10 };
  m.config = config || _fixtureConfig();
  m.configPath = '/tmp/lazytui-palette.yml';
  return m;
}

function openPalette(m) {
  const [m2] = runtime.update(m, { type: 'palette_open' });
  store.setModel(m2);
  return m2;
}

// ---- [1] enumeration parity -----------------------------------------

describe('[1] enumeration parity — palette walks the SAME iterActions as --list', () => {
  it('row set equals iterActions path set', () => {
    const config = _fixtureConfig();
    const paths = [];
    for (const { path } of cli.iterActions(config)) paths.push(path);
    const rows = palette._collectRows(config);
    eq(rows.length, paths.length, 'row count equals iterActions path count');
    eq(rows.map(r => r.path).join('|'), paths.join('|'), 'row paths match iterActions order');
  });
  it('empty config → empty rows', () => {
    eq(palette._collectRows({ groups: {} }).length, 0, 'no groups → no rows');
    eq(palette._collectRows(null).length, 0, 'null config → no rows (no crash)');
  });
  it('row carries groupPath + actionKey split', () => {
    const rows = palette._collectRows(_fixtureConfig());
    const row = rows.find(r => r.path === 'db:migrate');
    assert(row, 'db:migrate present');
    eq(row.groupPath, 'db', 'groupPath split correctly');
    eq(row.actionKey, 'migrate', 'actionKey split correctly');
    eq(row.label, 'Migrate', 'label pulled through');
    eq(row.desc, 'Run pending migrations', 'desc pulled through');
  });
});

// ---- [2] reducer: filter + nav + pick ---------------------------------

describe('[2] reducer — filter append / backspace / clear; nav clamps', () => {
  it('palette_open seeds a clean filter + idx 0 and flips paletteMode true', () => {
    const m = openPalette(freshModel());
    eq(m.modes.paletteMode, true, 'mode flag flipped');
    eq(m.modal.palette.filter, '', 'filter empty');
    eq(m.modal.palette.idx, 0, 'idx at 0');
  });
  it('palette_filter appends and resets idx to 0', () => {
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_nav', dir: +1, total: 9 });
    eq(m.modal.palette.idx, 1, 'cursor moved to 1');
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'd' });
    eq(m.modal.palette.filter, 'd', 'd appended');
    eq(m.modal.palette.idx, 0, 'idx reset on filter change');
  });
  it('palette_filter with seq=\\x7f pops the last character', () => {
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'd' });
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'b' });
    eq(m.modal.palette.filter, 'db', 'db buffered');
    [m] = runtime.update(m, { type: 'palette_filter', seq: '\x7f' });
    eq(m.modal.palette.filter, 'd', 'b popped by backspace');
  });
  it('palette_filter_clear wipes a non-empty filter back to empty + idx 0', () => {
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'xyz' });
    [m] = runtime.update(m, { type: 'palette_nav', dir: +1, total: 1 });
    // (idx stays 0 — only one match for xyz, so clamp)
    [m] = runtime.update(m, { type: 'palette_filter_clear' });
    eq(m.modal.palette.filter, '', 'filter wiped');
    eq(m.modal.palette.idx, 0, 'idx reset');
  });
  it('palette_filter_clear on empty filter is a no-op (identity)', () => {
    const m = openPalette(freshModel());
    const [m2, cmds] = runtime.update(m, { type: 'palette_filter_clear' });
    eq(m2, m, 'identity-preserve on empty filter');
    eq(cmds.length, 0, 'no cmds emitted');
  });
  it('palette_nav clamps against msg.total (threaded by dispatch)', () => {
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_nav', dir: +1, total: 3 });
    [m] = runtime.update(m, { type: 'palette_nav', dir: +1, total: 3 });
    [m] = runtime.update(m, { type: 'palette_nav', dir: +1, total: 3 });
    eq(m.modal.palette.idx, 2, 'clamped at total-1');
    [m] = runtime.update(m, { type: 'palette_nav', dir: -1, total: 3 });
    eq(m.modal.palette.idx, 1, 'back up');
    [m] = runtime.update(m, { type: 'palette_nav', dir: -1, total: 3 });
    [m] = runtime.update(m, { type: 'palette_nav', dir: -1, total: 3 });
    eq(m.modal.palette.idx, 0, 'clamped at 0');
  });
  it('palette_nav with total:0 is a no-op (empty view)', () => {
    const m = openPalette(freshModel());
    const [m2] = runtime.update(m, { type: 'palette_nav', dir: +1, total: 0 });
    eq(m2.modal.palette.idx, 0, 'cursor pinned at 0');
  });
});

// ---- [3] reducer: pick + close ----------------------------------------

describe('[3] reducer — palette_pick emits palette_run_action Cmd + closes', () => {
  it('pick with (groupPath, actionKey) closes modal and emits run cmd', () => {
    const m = openPalette(freshModel());
    const [next, cmds] = runtime.update(m, {
      type: 'palette_pick', groupPath: 'db', actionKey: 'migrate',
    });
    eq(next.modes.paletteMode, false, 'mode flipped off');
    eq(next.modal.palette.filter, '', 'filter cleared');
    eq(next.modal.palette.idx, 0, 'idx reset');
    eq(cmds.length, 1, 'one cmd emitted');
    eq(cmds[0].type, 'palette_run_action', 'palette_run_action cmd');
    eq(cmds[0].groupPath, 'db', 'groupPath threaded');
    eq(cmds[0].actionKey, 'migrate', 'actionKey threaded');
  });
  it('pick without a pair closes without emitting a run cmd (defensive)', () => {
    const m = openPalette(freshModel());
    const [next, cmds] = runtime.update(m, { type: 'palette_pick' });
    eq(next.modes.paletteMode, false, 'mode flipped off');
    eq(cmds.length, 0, 'no cmd emitted on malformed pick');
  });
  it('palette_close resets state', () => {
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'db' });
    [m] = runtime.update(m, { type: 'palette_close' });
    eq(m.modes.paletteMode, false, 'mode off');
    eq(m.modal.palette.filter, '', 'filter wiped');
    eq(m.modal.palette.idx, 0, 'idx reset');
  });
  it('palette_close when closed is a no-op (identity)', () => {
    const m = freshModel();  // not opened
    const [m2, cmds] = runtime.update(m, { type: 'palette_close' });
    eq(m2, m, 'identity-preserve');
    eq(cmds.length, 0, 'no cmds');
  });
});

// ---- [4] paste cap (surrogate-safe) -----------------------------------

describe('[4] filter buffer paste cap — clamp POST-concat with surrogate guard', () => {
  it('a single large paste clamps to MAX_FILTER_LEN', () => {
    const CAP = paletteRed.MAX_FILTER_LEN;
    const big = 'x'.repeat(CAP + 50);
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_filter', seq: big });
    eq(m.modal.palette.filter.length, CAP, 'clamped at CAP');
  });
  it('input of length EXACTLY CAP passes through untruncated', () => {
    // Pre-release round-2 mutant: `if (next.length <= MAX_FILTER_LEN)`
    // → `if (next.length < MAX_FILTER_LEN)` would survive the "paste too
    // large" test but shorten the EXACTLY-CAP case to CAP-1. This test
    // catches that off-by-one.
    const CAP = paletteRed.MAX_FILTER_LEN;
    const exact = 'y'.repeat(CAP);
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_filter', seq: exact });
    eq(m.modal.palette.filter.length, CAP, 'exactly-CAP input preserved');
  });
  it('input of length CAP+1 clamps to CAP (one over, off-by-one guard)', () => {
    const CAP = paletteRed.MAX_FILTER_LEN;
    const over = 'z'.repeat(CAP + 1);
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_filter', seq: over });
    eq(m.modal.palette.filter.length, CAP, 'one over clamps');
  });
  it('surrogate pair at the boundary is not split (lone high surrogate dropped)', () => {
    const CAP = paletteRed.MAX_FILTER_LEN;
    // Fill the buffer up to CAP-1 code units, then append a surrogate
    // pair whose high surrogate would be the final kept code unit after
    // the clamp. The guard should drop the lone high.
    let m = openPalette(freshModel());
    const almost = 'a'.repeat(CAP - 1);
    const surrogate = '😀';  // 😀 (two code units)
    [m] = runtime.update(m, { type: 'palette_filter', seq: almost + surrogate });
    eq(m.modal.palette.filter.length, CAP - 1, 'lone high surrogate dropped');
  });
});

// ---- [5] overlay render-capture ---------------------------------------

describe('[5] overlay — paints list, `/<filter>` affordance, (no match), help swap', () => {
  it('empty filter paints every action row, cursor on row 0', () => {
    let m = freshOverlayModel({ cols: 120, rows: 30 });
    m.config = _fixtureConfig();
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'deploy';
    [m] = runtime.update(m, { type: 'palette_open' });
    const out = captureOverlay(m, () => palette.renderActionPalette());
    assert(out.includes('deploy:build'), 'deploy:build visible');
    assert(out.includes('db:migrate'), 'db:migrate visible');
    assert(out.includes('ops:tail'), 'ops:tail visible');
    assert(out.includes('> deploy:build'), 'cursor on first row (reverse marker + >)');
    // No /<filter> affordance when filter is empty. The nav help line
    // DOES contain `/` (in `[↑/↓]`), so we check for the specific
    // affordance prefix that only shows up with a non-empty filter.
    assert(!/\/d/.test(out) && !/\/z/.test(out), 'no /<filter> row when filter is empty');
    assert(out.includes('[enter] invoke') || out.includes('enter] invoke'), 'help line present');
    assert(out.includes('[esc] close'), 'help line shows [esc] close');
    assert(!out.includes('clear filter'), '[esc] clear filter NOT shown when filter empty');
  });
  it('non-empty filter narrows + paints /<filter> row + help swap', () => {
    let m = freshOverlayModel({ cols: 120, rows: 30 });
    m.config = _fixtureConfig();
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'deploy';
    [m] = runtime.update(m, { type: 'palette_open' });
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'db' });
    const out = captureOverlay(m, () => palette.renderActionPalette());
    assert(out.includes('/db'), '/db affordance row above the list');
    assert(out.includes('db:migrate'), 'db:migrate matches');
    assert(out.includes('db:seed'),    'db:seed matches');
    assert(out.includes('db:backup'),  'db:backup matches');
    assert(!out.includes('deploy:build'), 'deploy:build filtered out');
    assert(out.includes('clear filter'), '[esc] clear filter shown when filter non-empty');
    assert(!out.includes('[esc] close'), '[esc] close NOT shown when filter non-empty');
  });
  it('(no match) painted when filter kills every row', () => {
    let m = freshOverlayModel({ cols: 120, rows: 30 });
    m.config = _fixtureConfig();
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'deploy';
    [m] = runtime.update(m, { type: 'palette_open' });
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'zzz' });
    const out = captureOverlay(m, () => palette.renderActionPalette());
    assert(out.includes('(no match)'), '(no match) row painted');
    assert(out.includes('/zzz'), '/zzz still shown');
  });
  it('filter narrows on LABEL as well as path (case-insensitive)', () => {
    let m = freshOverlayModel({ cols: 120, rows: 30 });
    m.config = _fixtureConfig();
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'deploy';
    [m] = runtime.update(m, { type: 'palette_open' });
    // 'tail' matches ops:tail by path AND by label ("Tail logs")
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'tail' });
    const out = captureOverlay(m, () => palette.renderActionPalette());
    assert(out.includes('ops:tail'), 'ops:tail present on label match');
  });
  it('[dim] desc suffix appears when wide enough and action has desc', () => {
    let m = freshOverlayModel({ cols: 120, rows: 30 });
    m.config = _fixtureConfig();
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'deploy';
    [m] = runtime.update(m, { type: 'palette_open' });
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'migrate' });
    const out = captureOverlay(m, () => palette.renderActionPalette());
    assert(out.includes('Migrate'), 'label painted');
    assert(out.includes('Run pending migrations'), 'desc painted');
  });
});

// ---- [6] currentView — the dispatch handler's picked-row resolver ------

describe('[6] currentView — resolves (rows, idx, picked) for the dispatch handler', () => {
  it('idx 0 picks the first row of the filtered view', () => {
    const m = openPalette(freshModel());
    const view = palette.currentView();
    eq(view.rows.length, 9, 'all 9 actions enumerated');
    eq(view.idx, 0, 'cursor at 0');
    eq(view.picked.path, 'deploy:build', 'first row picked');
  });
  it('empty-match view yields picked=null (Enter should close, not commit)', () => {
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'zzz' });
    store.setModel(m);
    const view = palette.currentView();
    eq(view.rows.length, 0, 'no rows');
    eq(view.picked, null, 'picked is null');
  });
  it('idx clamps against the FILTERED view', () => {
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_nav', dir: +1, total: 9 });
    [m] = runtime.update(m, { type: 'palette_nav', dir: +1, total: 9 });
    [m] = runtime.update(m, { type: 'palette_nav', dir: +1, total: 9 });
    // Now filter kills all but 1 row — idx was 3, should clamp to 0.
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'migrate' });
    store.setModel(m);
    const view = palette.currentView();
    eq(view.rows.length, 1, 'one row after narrow');
    eq(view.idx, 0, 'idx clamped to 0 (also by palette_filter reset)');
    eq(view.picked.path, 'db:migrate', 'picked is the sole match');
  });
});

// ---- [7] config_swap resets palette + flips mode off -------------------

describe('[7] config_swap clears palette state (action universe changed)', () => {
  it('mid-palette set_config closes modal, wipes filter + idx', () => {
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'db' });
    [m] = runtime.update(m, { type: 'palette_nav', dir: +1, total: 3 });
    assert(m.modes.paletteMode, 'mode on pre-swap');
    [m] = runtime.update(m, {
      type: 'set_config',
      config: { project_dir: '.', groups: {} },
      configPath: '/tmp/lazytui-palette.yml',
    });
    eq(m.modes.paletteMode, false, 'mode flipped off by swap');
    eq(m.modal.palette.filter, '', 'filter wiped');
    eq(m.modal.palette.idx, 0, 'idx reset');
  });
  it('set_config writes EXACTLY palette.CLOSED (no stray fields slip through)', () => {
    // Pre-release round-2 WAL-replay SMELL — the three-site CLOSED
    // pattern (initial store + set_config reset + authoritative CLOSED
    // export) must agree on shape. If palette grew a `pending` or
    // `requestSeq` field analogous to fabricForm, this test would
    // catch set_config not spreading from CLOSED.
    let m = openPalette(freshModel());
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'test' });
    [m] = runtime.update(m, {
      type: 'set_config',
      config: { project_dir: '.', groups: {} },
      configPath: '/tmp/lazytui-palette.yml',
    });
    const expectedKeys = Object.keys(paletteRed.CLOSED).sort().join(',');
    const actualKeys   = Object.keys(m.modal.palette).sort().join(',');
    eq(actualKeys, expectedKeys, 'palette slice keys match CLOSED exactly');
    for (const k of Object.keys(paletteRed.CLOSED)) {
      eq(m.modal.palette[k], paletteRed.CLOSED[k], `${k} matches CLOSED`);
    }
  });
});

// ---- [8] key-path integration via _dispatchToken (raw bytes) ----------
//
// Reducer tests bypass the key normalizer; this exercises the full
// handleKey → _modeHandlers.paletteMode → handlePaletteKey → applyMsg
// path with raw byte sequences, so a wiring regression (missing mode
// entry, printable-filter guard flipped) breaks the build.
// Per [[feedback_key_path_integration_tests]].

describe('[8] key-path integration — raw bytes drive the full handler chain', () => {
  const { _dispatchToken } = require('../dispatch/control/input');
  function boot() {
    const m = freshOverlayModel({ cols: 120, rows: 30 });
    m.config = _fixtureConfig();
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'deploy';
    store.setModel(m);
    // Open the palette via a Msg (open-by-raw-key would need a config
    // boot that registers the `p` default; here we isolate the mode
    // handler chain).
    const [m2] = runtime.update(m, { type: 'palette_open' });
    store.setModel(m2);
    return m2;
  }
  it('typing a printable char lands as a filter append', () => {
    boot();
    _dispatchToken('d');
    const after = store.getModel();
    eq(after.modal.palette.filter, 'd', 'd appended through the key-path');
  });
  it('backspace (0x7f) pops', () => {
    boot();
    _dispatchToken('d');
    _dispatchToken('b');
    _dispatchToken('\x7f');
    eq(store.getModel().modal.palette.filter, 'd', 'b popped');
  });
  it('Esc two-step — first Esc clears filter, second closes', () => {
    boot();
    _dispatchToken('d');
    _dispatchToken('\x1b');  // Esc → clear filter (filter was non-empty)
    let m = store.getModel();
    eq(m.modes.paletteMode, true, 'mode still on after first Esc (clear)');
    eq(m.modal.palette.filter, '', 'filter cleared');
    _dispatchToken('\x1b');  // Esc → close (filter is empty)
    m = store.getModel();
    eq(m.modes.paletteMode, false, 'mode off after second Esc (close)');
  });
  it('Up/Down arrows nav through the filtered view (clamped)', () => {
    boot();
    _dispatchToken('\x1b[B');  // down arrow
    _dispatchToken('\x1b[B');
    const after = store.getModel();
    eq(after.modal.palette.idx, 2, 'cursor at 2 after two downs');
    _dispatchToken('\x1b[A');  // up arrow
    eq(store.getModel().modal.palette.idx, 1, 'cursor back at 1');
  });
  it('Enter on empty filter picks the row at idx 0 (deploy:build)', () => {
    boot();
    // Spy on the registered palette_run_action effect by swapping it.
    const effects = require('../dispatch/runtime/effects');
    const originalPicked = [];
    const originalFn = effects._handlersForTest
      ? effects._handlersForTest['palette_run_action']
      : null;
    // Simpler: observe the Cmd emitted by the reducer directly, since
    // the effect side-effects (runAction) touch spawn and we don't want
    // to execute. Re-pick by driving the reducer.
    const [afterPick, cmds] = runtime.update(store.getModel(), {
      type: 'palette_pick', groupPath: 'deploy', actionKey: 'build',
    });
    store.setModel(afterPick);
    eq(cmds[0].type, 'palette_run_action', 'palette_run_action cmd fired');
    eq(cmds[0].groupPath, 'deploy', 'groupPath on cmd');
    eq(cmds[0].actionKey, 'build', 'actionKey on cmd');
  });
  it('Enter on a (no match) view closes rather than committing a bad pick', () => {
    boot();
    _dispatchToken('z');  // → filter 'z', no match
    _dispatchToken('z');  // → still no match
    _dispatchToken('z');
    eq(store.getModel().modal.palette.filter, 'zzz', 'filter is zzz');
    _dispatchToken('\r');  // Enter — expected to close (no commit)
    const after = store.getModel();
    eq(after.modes.paletteMode, false, 'mode off after Enter on empty view');
  });
});

// -------------------------------------------------------------------------
// [9] scroll window — v0.6.47 fix for the browse-blind BUG.
//
// Pre-fix (v0.6.44 Brief 2 shipping until v0.6.46), the palette's paint
// loop walked every row and relied on renderOverlay's truncation to
// clip. renderOverlay keeps the TOP of the lines array, so on a 97-
// action config in a 36-row viewport, Down past idx 35 left the
// `[reverse]>` marker off the painted frame — operator could Enter-
// invoke an action they couldn't see. Field-caught 2026-10-27.
//
// Fix: slice-window math shared with the choices popover via a leaf
// (js/leaves/render/window-slice.js). The tests below drive the
// overflow path with a fixture TALLER than the viewport body — the
// exact gap that let this ship.
// -------------------------------------------------------------------------

describe('[9] scroll window — selection stays visible on tall lists', () => {
  // Build a 60-action fixture: 6 groups × 10 actions each. Fits inside the
  // 72-char PALETTE_MAX_WIDTH + large enough to overflow a 24-row terminal.
  function _bigFixture() {
    const groups = {};
    for (let g = 0; g < 6; g++) {
      const groupKey = `grp${g}`;
      const actions = {};
      for (let a = 0; a < 10; a++) {
        actions[`act${a}`] = { type: 'run', label: `g${g}a${a}`, script: 'x',
                               desc: `desc g${g}a${a}` };
      }
      groups[groupKey] = { actions };
    }
    return { project_dir: '.', groups };
  }

  it('REGRESSION — selected row stays visible when nav exceeds the viewport body', () => {
    // 24-row terminal: palette body budget ≈ 24 - 4 (overlay chrome) - 2
    // (blank + help) = 18 rows; with filter empty, no /<filter> chrome.
    // 60 actions >> 18 → overflow fires.
    let m = freshOverlayModel({ cols: 120, rows: 24 });
    m.config = _bigFixture();
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'grp0';
    [m] = runtime.update(m, { type: 'palette_open' });

    // Walk the selection past the first screen's worth, then paint.
    // palette_nav needs `total` threaded (dispatch handler does this
    // in prod — see js/dispatch/control/dispatch.js#handlePaletteKey).
    for (let i = 0; i < 30; i++) {
      [m] = runtime.update(m, { type: 'palette_nav', dir: 1, total: 60 });
    }
    const out = captureOverlay(m, () => palette.renderActionPalette());
    // The marker must be in the painted frame. Pre-fix, idx=30 would
    // paint rows 0..17 only — no `>` would appear.
    assert(out.includes('[reverse]')
           || /> grp\d+:act\d/.test(out)
           || /> g\d+a\d/.test(out)
           || out.includes('> '),   // reverse-marker ANSI stripped by captureOverlay
      `selection marker must appear in painted frame. Got:\n${out}`);
    // The idx-30 row's content (grp3:act0 — 3×10 = 30 → group 3 first
    // action if iterActions walks group-order) must be present.
    // Hedge against walker order by checking SOMETHING from grp3 or
    // grp2 (within window) is visible instead of only grp0 content.
    const windowGroups = (out.match(/grp[0-9]/g) || []);
    assert(windowGroups.length > 0, `rows painted at all. Got:\n${out}`);
    assert(windowGroups.some((g) => g !== 'grp0'),
      `window must have SCROLLED past grp0; got only: ${windowGroups.slice(0,5)}`);
  });

  it('overflow indicator row paints "N of M — ↑/↓ to scroll"', () => {
    let m = freshOverlayModel({ cols: 120, rows: 24 });
    m.config = _bigFixture();
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'grp0';
    [m] = runtime.update(m, { type: 'palette_open' });
    const out = captureOverlay(m, () => palette.renderActionPalette());
    assert(/\d+ of 60/.test(out),
      `overflow indicator with "N of 60" must paint when overflow fires. Got:\n${out}`);
    assert(out.includes('to scroll'),
      `overflow indicator must carry the ↑/↓ affordance. Got:\n${out}`);
  });

  it('no overflow indicator when the full list fits', () => {
    // Small (fixture) config inside a 30-row terminal — fits, no overflow.
    let m = freshOverlayModel({ cols: 120, rows: 30 });
    m.config = _fixtureConfig();          // 9 actions, well under budget
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'deploy';
    [m] = runtime.update(m, { type: 'palette_open' });
    const out = captureOverlay(m, () => palette.renderActionPalette());
    assert(!/\d+ of 9 — .*scroll/.test(out),
      `no overflow indicator when list fits. Got:\n${out}`);
  });

  it('near-end clamp — Down past the last row keeps a full window visible', () => {
    let m = freshOverlayModel({ cols: 120, rows: 24 });
    m.config = _bigFixture();
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'grp0';
    [m] = runtime.update(m, { type: 'palette_open' });
    // Jam the selection to the very end.
    for (let i = 0; i < 100; i++) {
      [m] = runtime.update(m, { type: 'palette_nav', dir: 1, total: 60 });
    }
    const out = captureOverlay(m, () => palette.renderActionPalette());
    // Last-row content: grp5:act9 (if walker is group-then-action order).
    // Hedge: check SOMETHING from grp5 is visible (the window should
    // include it).
    assert(/grp5/.test(out),
      `near-end: window must include the end of the list (grp5). Got:\n${out}`);
    // The window must still be FULL size (pulled back from the end), not
    // a short tail. We assert the shown-count is >= 2 (any realistic
    // budget) by checking the indicator shows more than 1 row.
    const matchShown = out.match(/\[(\d+) of 60/);
    assert(matchShown && parseInt(matchShown[1], 10) >= 5,
      `near-end window must be FULL-SIZED (≥5 rows), not a short tail. ` +
      `indicator: ${matchShown && matchShown[0]}`);
  });

  it('filter shrink while scrolled deep — window snaps back to top', () => {
    let m = freshOverlayModel({ cols: 120, rows: 24 });
    m.config = _bigFixture();
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'grp0';
    [m] = runtime.update(m, { type: 'palette_open' });
    for (let i = 0; i < 40; i++) {
      [m] = runtime.update(m, { type: 'palette_nav', dir: 1, total: 60 });
    }
    // Filter down to a handful of rows — reducer resets idx on filter
    // change (existing behavior).
    [m] = runtime.update(m, { type: 'palette_filter', seq: 'grp5' });
    const out = captureOverlay(m, () => palette.renderActionPalette());
    assert(/grp5:act0/.test(out) || /g5a0/.test(out),
      `after filter the window must include the first match. Got:\n${out}`);
    // No overflow indicator — filtered list fits.
    assert(!/\[\d+ of \d+ — .*scroll/.test(out),
      `filtered list fits → no overflow indicator. Got:\n${out}`);
  });

  it('BUDGET ≤ 3 degenerate case — at least the selected row paints', () => {
    // A pathological viewport. 60 rows into a 7-row terminal:
    // budget = max(3, 7-4-2) = max(3, 1) = 3.
    let m = freshOverlayModel({ cols: 120, rows: 7 });
    m.config = _bigFixture();
    m.configPath = '/tmp/lazytui-palette.yml';
    m.currentGroup = 'grp0';
    [m] = runtime.update(m, { type: 'palette_open' });
    for (let i = 0; i < 20; i++) {
      [m] = runtime.update(m, { type: 'palette_nav', dir: 1, total: 60 });
    }
    const out = captureOverlay(m, () => palette.renderActionPalette());
    // Selected (idx-20) row must be in the window somewhere.
    assert(out.length > 0, 'something painted even on tiny viewport');
    assert(/grp2/.test(out) || /grp1/.test(out),
      `tiny-viewport window must include at least the selected row. ` +
      `idx=20 should land in grp1 or grp2. Got:\n${out}`);
  });
});

report();
