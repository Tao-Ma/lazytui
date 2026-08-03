/**
 * Edit-in-editor (dispatch/runtime/edit.js, docs/global-config §editor) —
 * the resolution chain, the mint through the REAL spawn seam (terminal pane
 * + auto-zoom + terminalMode + the serializable onExit descriptor), the tmux
 * fork, :config global's first-run skeleton, and the exit CONTINUATION
 * end-to-end: editor `true` exits cleanly, the tab auto-closes, an open doc
 * tab showing the file refreshes, and a config edit prints the restart hint
 * on the Transcript.
 *
 * Run: node js/test/test-edit.js
 */
'use strict';

// Mock child_process.spawn BEFORE edit.js loads (it destructures spawn at
// module scope) — records the tmux new-window invocation without launching.
const child_process = require('child_process');
const spawnCalls = [];
const _realSpawn = child_process.spawn;
child_process.spawn = (...args) => { spawnCalls.push(args); return { on() {}, kill() {} }; };

// Drop rendered FRAMES only — the PTY exit fan-out schedules real repaints in
// this test env. Cursor-addressed paints carry CSI row;colH / 2J / ?25 codes;
// the harness's own ✓/✗ report lines don't, and must stay visible (a
// drop-everything stub silenced report() itself — v0.6.12 review LOW).
{
  const term = require('../io/term');
  const _w = term.stdout.write.bind(term.stdout);
  term.stdout.write = (chunk, ...rest) => {
    const s = typeof chunk === 'string' ? chunk : '';
    if (/\x1b\[\d+;\d+H|\x1b\[2J|\x1b\[\?25/.test(s)) return true;
    return _w(chunk, ...rest);
  };
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const mpane = require('../leaves/wm/pane');
const terminal = require('../io/terminal');
const { getModel } = require('../model/store');
const edit = require('../dispatch/runtime/edit');

const api = sm.api;
if (!api.getComponent('terminal')) api.registerComponent(require('../panel/terminal/terminal'));
// Boot wiring the real tui.js does: the PTY exit fan-out (auto-close +
// the onExit continuation under test) is injected, not required upward.
require('../panel/content/pty-lifecycle').install(require('../dispatch/runtime/effects').effectHost());

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-edit-'));

function layoutSlice() { return route.getInstanceSlice('layout'); }
function viewerPane() {
  const v = route.resolveViewerPaneId();
  for (const col of layoutSlice().arrange.columns) for (const p of col.panels) if (p.paneId === v) return p;
  return null;
}
function activeEntry() { return layoutSlice().arrange.pool[viewerPane().activeTabId]; }
function cleanupTerminals() {
  for (const col of layoutSlice().arrange.columns) for (const p of col.panels) {
    for (const t of (p.tabs || [])) {
      const e = layoutSlice().arrange.pool[t.poolId];
      if (e && e.type === 'terminal') { try { terminal.destroySession(mpane.newPaneId(t.poolId)); } catch (_) {} }
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, budgetMs = 5000) {
  const step = 25;
  for (let t = 0; t < budgetMs && !pred(); t += step) await sleep(step);
  return pred();
}

describe('[1] resolveEditor — config editor: → $VISUAL → $EDITOR → vi', () => {
  it('walks the chain', () => {
    eq(edit.resolveEditor({ editor: 'nvim' }, { VISUAL: 'v', EDITOR: 'e' }), 'nvim');
    eq(edit.resolveEditor({}, { VISUAL: 'v', EDITOR: 'e' }), 'v');
    eq(edit.resolveEditor({}, { EDITOR: 'e' }), 'e');
    eq(edit.resolveEditor({}, {}), 'vi');
    eq(edit.resolveEditor(null, {}), 'vi');
  });
});

(async () => {

describe('[2] editFile mints an editor terminal through the spawn seam', () => {
  sm.bootFresh();
  delete process.env.TMUX;
  getModel().config.editor = 'sleep 30';
  edit.editFile(path.join(TMP, 'some file.txt'));
  const entry = activeEntry();
  it('a terminal pane is the content slot\'s active tab', () => {
    eq(route.instanceKind(viewerPane().paneId), 'terminal');
  });
  it('cmd = resolved editor + shell-quoted path', () => {
    eq(entry.config.cmd, `sleep 30 '${path.join(TMP, 'some file.txt')}'`);
  });
  it('carries the serializable onExit descriptor (not a config edit)', () => {
    eq(entry.config.onExit, { kind: 'edit', path: path.join(TMP, 'some file.txt'), isConfig: false });
    assert(entry.hint && entry.hint.origin === 'edit', 'edit-origin hint stamped');
  });
  it('auto-zooms + enters terminalMode (the spawn-seam UX)', () => {
    eq(layoutSlice().viewMode, 'full');
    eq(getModel().modes.terminalMode, true);
  });
  it('editing the PROJECT config by path flags isConfig automatically', () => {
    getModel().configPath = path.join(TMP, 'proj.yml');
    edit.editFile(getModel().configPath);
    eq(activeEntry().config.onExit.isConfig, true);
  });
  cleanupTerminals();
});

describe('[3] under tmux → new-window, no pane, no continuation', () => {
  sm.bootFresh();
  layoutSlice().viewMode = 'normal';
  process.env.TMUX = '/tmp/mock-tmux';
  spawnCalls.length = 0;
  getModel().config.editor = 'nvim';
  edit.editFile('/tmp/x.txt');
  it('spawns tmux new-window with the editor command', () => {
    eq(spawnCalls.length, 1);
    eq(spawnCalls[0][0], 'tmux');
    eq(spawnCalls[0][1][0], 'new-window');
    assert(spawnCalls[0][1][3].includes(`nvim '/tmp/x.txt'`), spawnCalls[0][1][3]);
  });
  it('mints no terminal pane', () => {
    assert(route.instanceKind(viewerPane().paneId) !== 'terminal');
  });
  delete process.env.TMUX;
});

describe('[4] :config global — skeleton on first run', () => {
  sm.bootFresh();
  const globPath = path.join(TMP, 'globals', 'config.yml');
  const prev = process.env.LAZYTUI_GLOBAL_CONFIG;
  process.env.LAZYTUI_GLOBAL_CONFIG = globPath;
  getModel().config.editor = 'sleep 30';
  edit.editConfig('global');
  it('created the file (dir included) with the commented skeleton', () => {
    assert(fs.existsSync(globPath), 'file created');
    const body = fs.readFileSync(globPath, 'utf8');
    assert(/lazytui global config/.test(body) && /# editor:/.test(body), 'skeleton content');
  });
  it('opened it flagged as a config edit', () => {
    eq(activeEntry().config.onExit, { kind: 'edit', path: globPath, isConfig: true });
  });
  it('a second :config global does NOT overwrite the file', () => {
    fs.writeFileSync(globPath, 'theme: nord\n');
    edit.editConfig('global');
    eq(fs.readFileSync(globPath, 'utf8'), 'theme: nord\n');
  });
  process.env.LAZYTUI_GLOBAL_CONFIG = prev;
  cleanupTerminals();
});

describe('[4b] :edit works through the REAL cmdline (completion + fallback)', () => {
  // v0.6.12 review HIGH: the completion entries carried :open's display/run
  // (Tab rewrote the buffer to `open …`, Enter opened a read-only tab) and an
  // empty dropdown made submit a dead key — so `:edit` never reached the
  // editor, including the create-a-new-file case.
  sm.bootFresh();
  layoutSlice().viewMode = 'normal';
  delete process.env.TMUX;
  require('../panel/commands').setCommandsDispatch(
    require('../dispatch/runtime/effects').effectHost());
  const cmdline = require('../dispatch/control/cmdline');
  getModel().config.editor = 'sleep 30';
  getModel().projectDir = TMP;
  fs.writeFileSync(path.join(TMP, 'target2.txt'), 'x\n');

  it('completion rows carry the edit verb, not open', () => {
    const rows = cmdline.rebuild('edit target');
    assert(rows.length >= 1, 'a completion matched');
    assert(rows[0].display.startsWith('edit '), `display: ${rows[0].display}`);
  });
  it('Enter on a completion row launches the editor', () => {
    const rows = cmdline.rebuild('edit target');
    const idx = rows.findIndex((r) => r.display === 'edit target2.txt');
    assert(idx >= 0, `row present: ${JSON.stringify(rows.map((r) => r.display))}`);
    cmdline.runAt(idx, [], rows[idx].display);
    eq(activeEntry().config.cmd, `sleep 30 '${path.join(TMP, 'target2.txt')}'`,
      'the editor terminal minted from the completion row');
  });
  it('a nonexistent path falls back to the verb row; Enter creates-and-edits', () => {
    const rows = cmdline.rebuild('edit brand-new.txt');
    eq(rows.length, 1, 'exactly the fallback row');
    eq(rows[0].display, 'edit', 'the verb itself');
    cmdline.runAt(0, ['brand-new.txt'], rows[0].display);
    eq(activeEntry().config.cmd, `sleep 30 '${path.join(TMP, 'brand-new.txt')}'`,
      'the editor launched on the not-yet-existing path');
  });
  it(':edit rejects scheme URIs (host-only)', () => {
    const before = viewerPane().activeTabId;
    require('../dispatch/control/cmdline').runCommandString('edit docker://c/etc/hosts');
    eq(viewerPane().activeTabId, before, 'no editor minted for a docker:// URI');
  });
  cleanupTerminals();
});

// [5] continuation end-to-end — needs REAL PTY spawn/exit: restore spawn (the
// PTY path uses node-pty, unaffected by the child_process mock anyway).
child_process.spawn = _realSpawn;
sm.bootFresh();
layoutSlice().viewMode = 'normal';
delete process.env.TMUX;
const target = path.join(TMP, 'doc.txt');
fs.writeFileSync(target, 'fresh content after edit\n');
// An open doc tab showing the file (keyed file:<abs> — the refresh gate).
require('../panel/content-tab').addContentTab(getModel().currentGroup, `file:${target}`, 'doc.txt', ['old content']);
const docInstId = mpane.newPaneId(require('../panel/content-tab')._poolId(`file:${target}`));
getModel().config.editor = 'true';        // exits 0 immediately
edit.editFile(target, { isConfig: true }); // force the hint too
const tabClosed = await until(() => route.instanceKind(viewerPane().paneId) !== 'terminal');
const refreshed = await until(() => {
  const s = route.getInstanceSlice(docInstId);
  return s && (s.lines || []).some((l) => l.includes('fresh content after edit'));
});
const transcript = route.getInstanceSlice(route.resolveTarget('viewer_transcript'));

describe('[5] exit continuation — clean editor exit refreshes + hints', () => {
  it('the editor tab auto-closed on exit 0', () => assert(tabClosed, 'tab removed'));
  it('the open doc tab refreshed to the edited content', () => assert(refreshed,
    `doc tab lines: ${JSON.stringify((route.getInstanceSlice(docInstId) || {}).lines)}`));
  it('the restart hint landed on the Transcript', () => {
    assert((transcript.lines || []).some((l) => l.includes('Config edited')),
      `transcript: ${JSON.stringify(transcript.lines)}`);
  });
  it('viewMode dropped out of the auto-zoom', () => {
    assert(layoutSlice().viewMode !== 'full');
  });
});

cleanupTerminals();
report();

})();
