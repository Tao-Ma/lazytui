/**
 * One pane-def builder — mpane.paneDef. Every place that turns a pool entry
 * into a pane def produces its shape, and each tab's init is seeded with the
 * def of its OWN entry.
 *
 * Field report 2026-11-14 (nvim in a `type: terminal` pane): terminal mode's
 * footer read `[terminal: terminal]`, not the pane's `title: Dev`. Root: the
 * pane def was built by hand in five places that disagreed. Boot dropped the
 * nested `config` (a tab switch kept it), so the inits that read `config`
 * (terminal, agent, text-view, info) got nothing for a pane declared under
 * `panels:` — an agent declared `backend: pi` started as `mock`. And every
 * tab's init got the SLOT, which mirrors only its active tab, so the other tabs
 * of a multi-tab slot started with the active tab's settings (two tables on
 * topics alpha + beta both read alpha). The hidden-panel preview built its def
 * from a list item, so it never had the panel's settings at all.
 *
 *   [1] paneDef: settings at the top level AND under `config`; framework keys
 *       win; title falls back to the type; the entry is not mutated
 *   [2] every builder site produces paneDef's output: boot, the no-layout
 *       fallback, a tab switch / add / remove, `:show` placement, the
 *       hidden-panel preview
 *   [3] each tab's init is seeded with its own entry's def (multi-tab slot)
 *   [4] declared panes of real kinds start with their own settings: agent
 *       backend/model, text-view lines/cap, a table per tab
 *
 * Run: node js/test/test-pane-def.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { section, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const mpane = require('../leaves/wm/pane');
const mpool = require('../leaves/wm/pool');
const { rebuildLayoutFromConfig } = require('../leaves/wm/arrange');
const { parse } = require('../parser');

for (const m of ['agent/agent', 'text-view/text-view', 'monitor/table']) {
  const c = require('../panel/' + m);
  if (!sm.api.getComponent(c.name)) sm.api.registerComponent(c);
}
// A probe kind: its init keeps the seed's pane def, its renderer records the
// `panel` it was handed.
const rendered = [];
sm.api.registerComponent({
  name: 'pdprobe',
  init: (paneId, seed) => ({ paneId: paneId || null, seen: (seed && seed.paneDef) || null }),
  update: (_msg, slice) => slice,
  panelTypes: {
    pdprobe: {
      render: (panel, w, h) => {
        rendered.push(panel);
        return sm.api.renderPanel({ width: w, height: h, lines: [], title: panel.title, panelType: 'pdprobe' });
      },
    },
  },
});

// Order-insensitive compare (eq is JSON.stringify).
const canon = (v) => Array.isArray(v) ? v.map(canon)
  : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])]))
    : v;
// A pane's def = the pane minus its slot-only fields.
const SLOT_KEYS = ['paneId', 'tabs', 'activeTabId', 'heightPct', 'collapsed', 'role'];
function defPart(pane) {
  const d = { ...pane };
  for (const k of SLOT_KEYS) delete d[k];
  return d;
}
function sameDef(pane, entry, what) {
  eq(canon(defPart(pane)), canon(mpane.paneDef(entry, pane)), what);
}

const dirs = [];
function writeConfig(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-pane-def-'));
  dirs.push(dir);
  const yml = path.join(dir, 'tui.yml');
  fs.writeFileSync(yml, body);
  return parse(yml);
}

const YAML = `project_dir: .
groups:
  g1:
    label: G
    actions:
      hello: { label: Hello, script: echo hello }
panels:
  groups: { type: groups, title: Groups }
  pa: { type: pdprobe, title: A, color: red, size: 1 }
  pb: { type: pdprobe, title: B, color: blue }
  hid: { type: pdprobe, title: Hidden, color: green }
  bot: { type: agent, title: Bot, backend: pi, model: foo/bar }
  notes: { type: text-view, title: Notes, lines: [one, two], cap: 7 }
  ta: { type: table, title: TA, topic: alpha, columns: [{ key: x }] }
  tb: { type: table, title: TB, topic: beta, columns: [{ key: y }] }
  detail: { type: detail, title: Detail }
layout:
  columns:
    - width: 30
      panels: [groups]
    - width: flex
      panels:
        - { tabs: [pa, pb], hotkey: 4 }
        - bot
    - panels:
        - { tabs: [ta, tb] }
        - notes
        - detail
`;

section('[1] paneDef: the shape');
{
  const entry = { id: 'x', type: 'my_kind', title: 'X', config: { topic: 't', title: 'shadowed', id: 'nope' } };
  const frozen = JSON.stringify(entry);
  const d = mpane.paneDef(entry, { hotkey: '5', columnIndex: 2 });
  eq(d.topic, 't', 'a setting is on the top level');
  eq(d.config, entry.config, '… and under `config`');
  eq([d.id, d.type, d.title, d.hotkey, d.columnIndex], ['x', 'my_kind', 'X', '5', 2], 'framework keys win over same-named settings');
  eq(mpane.paneDef({ id: 'y', type: 'my_kind' }).title, 'my kind', 'no title → the type, underscores spaced');
  eq(mpane.paneDef({ id: 'y', type: 'my_kind' }).config, {}, 'no config → an empty `config`');
  eq(JSON.stringify(entry), frozen, 'the entry is not mutated');
  eq(mpane.titleOf(entry), 'X', 'titleOf names the entry as paneDef does');
  eq(mpane.titleOf(null), undefined, 'titleOf(no entry) → undefined');
}

section('[2] every builder site produces paneDef\'s output');
{
  const config = writeConfig(YAML);
  const arr = rebuildLayoutFromConfig(config);
  for (const p of mpool.allPanesInColumns(arr)) {
    // A content slot keeps its own identity (the slot's entry), every other
    // pane mirrors its active tab.
    const src = p.role === 'content' ? arr.pool[p.id] : arr.pool[p.activeTabId];
    sameDef(p, src, `boot: ${p.paneId} is paneDef(${src.id})`);
  }
  const slot = mpool.allPanesInColumns(arr).find(p => p.activeTabId === 'pa');
  eq(slot.config, { color: 'red', size: 1 }, 'boot: the pane carries its settings under `config` (it did not)');

  const fb = rebuildLayoutFromConfig({ groups: {}, files: [{ path: 'a' }] });
  for (const p of mpool.allPanesInColumns(fb)) {
    const src = p.role === 'content' ? fb.pool[p.id] : fb.pool[p.activeTabId];
    sameDef(p, src, `no-layout fallback: ${p.paneId}`);
  }
  eq(fb.pool.files.config, { source: 'declared' }, 'no-layout fallback: the files entry holds its setting (only the pane did)');

  const switched = mpane.setActiveTab(slot, 'pb', arr.pool.pb);
  sameDef(switched, arr.pool.pb, 'tab switch: paneDef(pb), nothing of pa left');
  eq(switched.size, undefined, 'tab switch: pa\'s `size` does not leak');
  const added = mpane.addTab(slot, { id: 'hid', poolId: 'hid' }, arr.pool.hid, { activate: true });
  sameDef(added, arr.pool.hid, 'tab add (activate): paneDef(hid)');
  const removed = mpane.removeTab(added, 'hid', arr.pool);
  sameDef(removed.pane, arr.pool[removed.activeId], 'tab remove: paneDef(the new active tab)');

  const shown = mpool.placementFromPoolEntry(arr.pool.hid, 1);
  sameDef(shown, arr.pool.hid, ':show placement: paneDef(hid)');
  eq([shown.hotkey, shown.columnIndex], ['', 1], ':show placement: no hotkey, the target column');

  const { _buildPreviewLines } = require('../overlay/panel-list');
  const item = mpool.panelListItems(arr).find(i => i.id === 'hid');
  eq(item.status, 'hidden', 'precondition: hid is a hidden panel');
  rendered.length = 0;
  _buildPreviewLines(item, 40, 10, arr);
  eq(rendered.length, 1, 'hidden preview: the renderer ran');
  const prev = rendered[0];
  sameDef(prev, arr.pool.hid, 'hidden preview: paneDef(hid) (the list item has no settings)');
  eq(prev.color, 'green', 'hidden preview: the renderer sees the panel\'s settings');
}

section('[3] each tab\'s init is seeded with its own entry\'s def');
{
  sm.bootFresh(writeConfig(YAML));
  sm.resize(160, 40);
  const arr = route.getInstanceSlice('layout').arrange;
  const slot = mpool.allPanesInColumns(arr).find(p => (p.tabs || []).some(t => t.poolId === 'pa'));
  eq(slot.activeTabId, 'pa', 'precondition: pa is the active tab, pb the other');
  const seenA = route.getInstanceSlice('pane-pa').seen;
  const seenB = route.getInstanceSlice('pane-pb').seen;
  eq(canon(seenA), canon(mpane.paneDef(arr.pool.pa, slot)), 'pa: paneDef(pa) on its slot');
  eq(canon(seenB), canon(mpane.paneDef(arr.pool.pb, slot)), 'pb: paneDef(pb) on its slot — not the slot\'s (pa\'s)');
  eq([seenB.color, seenB.config.color, seenB.title, seenB.size], ['blue', 'blue', 'B', undefined], 'pb sees its own settings and title');
  eq([seenA.hotkey, seenA.columnIndex], ['4', 1], 'the slot\'s hotkey and column ride along');
}

section('[4] declared panes of real kinds start with their own settings');
{
  const s = (id) => route.getInstanceSlice(id);
  eq([s('pane-bot').descriptor.backend, s('pane-bot').descriptor.model], ['pi', 'foo/bar'], 'agent: backend + model (it started as mock)');
  eq([s('pane-notes').lines, s('pane-notes').cap], [['one', 'two'], 7], 'text-view: lines + cap');
  eq(s('pane-ta').topic, 'alpha', 'table, active tab: its topic');
  eq(s('pane-tb').topic, 'beta', 'table, other tab: its OWN topic (it read alpha)');
}

section('[5] a nested `config:` is flagged, not silently dropped');
{
  // The settings go on the entry; a nested `config:` block is not read (an agent
  // written that way ran `mock`, a terminal ran $SHELL) — the parser says so.
  // Pre-release review 2026-11-14: docs/live-agent.md's recipe used that form.
  const head = 'project_dir: .\ngroups:\n  g1:\n    label: G\n    actions:\n      hello: { label: Hello, script: echo hello }\npanels:\n';
  const lint = (panels) => writeConfig(head + panels).warnings.filter(w => w.code === 'panels.nested_config');
  const w = lint('  chat: { type: agent, config: { backend: pi, model: m/x } }\n  dev: { type: terminal, config: { cmd: htop } }\n');
  eq(w.length, 2, 'one warning per entry with a nested config');
  assert(/panels\.chat/.test(w[0].message) && /`backend: …`, `model: …`/.test(w[0].message), `names the pane and the settings to move: ${w[0].message}`);
  assert(/panels\.dev/.test(w[1].message) && /`cmd: …`/.test(w[1].message), w[1].message);
  eq(lint('  chat: { type: agent, backend: pi, model: m/x }\n'), [], 'the flat form is fine');
  // The recipe as docs/live-agent.md writes it: no warning, and the pane runs pi.
  const doc = fs.readFileSync(path.join(__dirname, '../../docs/live-agent.md'), 'utf8');
  const m = /`(chat: \{ type: agent[^`]*\})`/.exec(doc);
  assert(m, 'docs/live-agent.md gives the agent pane entry');
  const recipe = m[1].replace('<name>', 'local').replace('<id>', 'm1');
  const cfg = writeConfig(head + '  ' + recipe + '\n  detail: { type: detail }\nlayout:\n  columns:\n    - panels: [chat, detail]\n');
  eq(cfg.warnings.filter(x => x.code === 'panels.nested_config'), [], 'the documented recipe draws no warning');
  sm.bootFresh(cfg);
  const d = route.getInstanceSlice('pane-chat').descriptor;
  eq([d.backend, d.provider, d.model], ['pi', 'local', 'm1'], 'and its pane runs pi with the provider and model');
}

section('[6] a setting named like a slot field stays a setting');
{
  // `role`, `tabs`, `paneId`, … are the SLOT's (mpane.SLOT_KEYS). As settings
  // they stay under `config`: a `role: content` setting made its pane a second
  // content slot — its own tabs replaced by Info / Transcript, the viewer moved
  // to it (pre-release review 2026-11-14, inherited).
  const d = mpane.paneDef({ id: 'x', type: 't', config: { role: 'content', tabs: ['y'], paneId: 'p', topic: 'k' } });
  eq([d.role, d.tabs, d.paneId, d.topic], [undefined, undefined, undefined, 'k'], 'not at the top level');
  eq([d.config.role, d.config.tabs], ['content', ['y']], 'still readable under config');
  const head = 'project_dir: .\ngroups:\n  g1:\n    label: G\n    actions:\n      hello: { label: Hello, script: echo hello }\n';
  sm.bootFresh(writeConfig(head + `panels:
  groups: { type: groups, title: Groups }
  tv: { type: text-view, title: TV, role: content, lines: [x] }
  notes: { type: text-view, title: Notes, lines: [n] }
  detail: { type: detail, title: Detail }
layout:
  columns:
    - width: 30
      panels: [groups]
    - panels: [{ tabs: [tv, notes] }, detail]
`));
  const arr = route.getInstanceSlice('layout').arrange;
  const tv = mpool.allPanesInColumns(arr).find(p => p.paneId === 'pane-tv');
  eq([tv.role, tv.tabs.map(t => t.id)], [undefined, ['tv', 'notes']], 'the pane keeps its own tabs');
  eq(route.resolveViewerPaneId(), 'pane-detail', 'the viewer is the detail slot');
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
report();
