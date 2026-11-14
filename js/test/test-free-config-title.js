/**
 * Free-config `t` renames THE selected pane — its pool entry, so every place
 * that shows the name agrees and `:save-layout` keeps it.
 *
 * Pre-release review 2026-11-14: setSelectedTitle renamed every pane of the
 * selected pane's TYPE (two tables both became "Renamed"), and only on the pane
 * objects: the pool entry — what the tab strip, the footer (titleOf) and
 * `:save-layout` read — kept the old title, so the border disagreed with them
 * and the rename was lost on save.
 *
 *   [1] only the selected pane is renamed
 *   [2] its pool entry carries the name (titleOf, :save-layout)
 *   [3] undo restores both
 *
 * Run: node js/test/test-free-config-title.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { section, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const mpane = require('../leaves/wm/pane');
const mpool = require('../leaves/wm/pool');
const yl = require('../feature/yaml-layout');
const { parse } = require('../parser');

for (const m of ['monitor/table']) {
  const c = require('../panel/' + m);
  if (!sm.api.getComponent(c.name)) sm.api.registerComponent(c);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-fc-title-'));
const yml = path.join(dir, 'tui.yml');
fs.writeFileSync(yml, `project_dir: .
groups:
  g1:
    label: G
    actions:
      hello: { label: Hello, script: echo hello }
panels:
  groups: { type: groups, title: Groups }
  ta: { type: table, title: TA, topic: alpha, columns: [{ key: x }] }
  tb: { type: table, title: TB, topic: beta, columns: [{ key: y }] }
  detail: { type: detail, title: Detail }
layout:
  columns:
    - width: 30
      panels: [groups]
    - panels: [ta, tb, detail]
`);
sm.bootFresh(parse(yml));
sm.resize(140, 40);
const L = () => route.getInstanceSlice('layout');
const layout = (m) => sm.api.dispatchMsg(sm.api.wrap('layout', m));
const pane = (id) => mpool.allPanesInColumns(L().arrange).find(p => p.id === id);

layout({ type: 'focus_set', focus: pane('ta').paneId });
layout({ type: 'free_config_enter' });
layout({ type: 'free_config_title_enter' });
L().freeConfig.titleEdit.text = 'Renamed';
layout({ type: 'free_config_title_submit', freeConfigTitleEditMode: true });

section('[1] only the selected pane is renamed');
eq([pane('ta').title, pane('tb').title], ['Renamed', 'TB'], 'ta renamed, tb (same type) untouched');

section('[2] its pool entry carries the name');
eq([L().arrange.pool.ta.title, L().arrange.pool.tb.title], ['Renamed', 'TB']);
eq(mpane.titleOf(L().arrange.pool.ta), pane('ta').title, 'the tab strip / footer name = the border\'s');
const saved = yl.serializePanelsBlock(L().arrange);
eq([/title: Renamed/.test(saved), /title: TB/.test(saved)], [true, true], ':save-layout writes the new name');

section('[3] undo restores both');
layout({ type: 'free_config_undo' });
eq([pane('ta').title, L().arrange.pool.ta.title], ['TA', 'TA']);

layout({ type: 'free_config_exit' });
fs.rmSync(dir, { recursive: true, force: true });
report();
