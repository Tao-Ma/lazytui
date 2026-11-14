/**
 * The terminal-pane field layout (pg_spectrum dev.sh, 2026-11-14) as a test
 * fixture: a `type: terminal` pane alone in a flex middle column, between a
 * fixed-width groups column and an actions/detail column. Built from YAML
 * through the REAL parser (bootFresh takes the parsed config), so the pane gets
 * the same paneId / pool entry / hotkey production gives it.
 *
 *   const tl = require('./_helpers/terminal-layout');
 *   const fx = tl.boot({ cmd: 'sleep 60' });   // boots + sizes 160×40
 *   fx.pane()   → the terminal's column pane (re-read: the arrange is immutable)
 *   fx.id       → its PTY session id (== the tab-instance id)
 *   fx.cleanup()
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sm = require('../smoke/_helpers/smoke');
const route = require('../../panel/route');
const mpane = require('../../leaves/wm/pane');
const mpool = require('../../leaves/wm/pool');
const { parse } = require('../../parser');

if (!sm.api.getComponent('terminal')) sm.api.registerComponent(require('../../panel/terminal/terminal'));

function terminalPane() {
  const arr = route.getInstanceSlice('layout').arrange;
  return mpool.allPanesInColumns(arr).find(p => {
    const e = arr.pool && arr.pool[p.activeTabId];
    return e && e.type === 'terminal';
  });
}

function boot({ cmd = 'sleep 60', cols = 160, rows = 40 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-term-layout-'));
  const yml = path.join(dir, 'tui.yml');
  fs.writeFileSync(yml, [
    'project_dir: .',
    'groups:',
    '  g1:',
    '    label: Group 1',
    '    actions:',
    '      hello: { label: Hello, script: echo hello }',
    'panels:',
    '  groups: { type: groups, title: Groups }',
    `  dev: { type: terminal, title: Dev, cmd: ${JSON.stringify(cmd)} }`,
    '  actions: { type: actions, title: Actions }',
    '  detail: { type: detail, title: Detail }',
    'layout:',
    '  columns:',
    '    - width: 34',
    '      panels: [groups]',
    '    - width: flex',
    '      panels:',
    '        - { tabs: [dev], hotkey: 4 }',
    '    - panels:',
    '        - actions',
    '        - { tabs: [detail], height: 60% }',
    '',
  ].join('\n'));
  sm.bootFresh(parse(yml));
  sm.resize(cols, rows);
  const pane = terminalPane();
  return {
    pane: terminalPane,
    id: mpane.newPaneId(pane.activeTabId),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

module.exports = { boot, terminalPane };
