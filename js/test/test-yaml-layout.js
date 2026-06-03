/**
 * Layout YAML serializer — v0.6.1 cell-schema regression.
 *
 * The contracts pinned here:
 *
 *   1. `yamlValue` emits identifier-shaped scalars bare, quotes
 *      everything else, keeps `60%`/`32%` percentage strings plain.
 *   2. `serializePoolEntryYaml` flattens an entry to `type/title +
 *      spread config`, dropping bookkeeping (`id`, `_synthesized`).
 *      Plugin keys (topic, select_from, source, container, root,
 *      decorators) all survive.
 *   3. `serializeLayoutCell` emits bare-string single-tab panes when
 *      no overrides apply, else a `{tabs: [...]}` mapping with the
 *      placement overrides on subsequent lines.
 *   4. `serializeLayout` produces a well-formed `layout:` block;
 *      detail-pane height is sourced from `arrange.detailHeightPct`
 *      and lands on the cell whose active tab is kind 'detail'.
 *   5. The full emit→write→reparse round-trip through the parser
 *      produces a structurally identical layout — every `config`
 *      key on the pool entry survives.
 *
 * Run: node js/test/test-yaml-layout.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  serializeLayout,
  serializeLayoutCell,
  serializePoolEntryYaml,
  serializePanelsBlock,
  yamlValue,
  writeLayoutToFile,
} = require('../feature/yaml-layout');
const { describe, it, assert, eq, report } = require('./test-runner');

// Minimal pane builder for cell-level unit tests. Wide-intermediate
// shape: legacy Panel fields + tabs[] + activeTabId. Caller fills only
// what each test exercises.
function pane({ id, type, title, tabs, activeTabId, heightPct, collapsed }) {
  const tabList = tabs || [{ id, poolId: id }];
  return {
    id, type, title: title || (type && type[0].toUpperCase() + type.slice(1)),
    hotkey: '', columnIndex: 0,
    paneId: `pane-${id}`,
    tabs: tabList,
    activeTabId: activeTabId || (tabList[0] && tabList[0].poolId),
    heightPct, collapsed,
  };
}

describe('[1] yamlValue scalar emission', () => {
  it('bare identifiers stay bare', () => {
    eq(yamlValue('containers'), 'containers');
    eq(yamlValue('docker.stats'), 'docker.stats');
    eq(yamlValue('my-thing_v2'), 'my-thing_v2');
  });
  it('strings with whitespace or punctuation get quoted', () => {
    eq(yamlValue('hello world'), '"hello world"');
    eq(yamlValue('foo: bar'), '"foo: bar"');
  });
  it('YAML reserved words get quoted to prevent boolean coercion', () => {
    eq(yamlValue('yes'), '"yes"');
    eq(yamlValue('true'), '"true"');
    eq(yamlValue('null'), '"null"');
  });
  it('numbers and booleans render bare', () => {
    eq(yamlValue(42), '42');
    eq(yamlValue(true), 'true');
    eq(yamlValue(false), 'false');
  });
  it('arrays render as YAML flow-style', () => {
    eq(yamlValue(['status', 'image']), '[status, image]');
    eq(yamlValue([1, 2, 3]), '[1, 2, 3]');
  });
  it('null / undefined render as null', () => {
    eq(yamlValue(null), 'null');
    eq(yamlValue(undefined), 'null');
  });
  it('percentage scalars (60%, 7%) emit bare', () => {
    eq(yamlValue('60%'), '60%');
    eq(yamlValue('7%'),  '7%');
  });
});

describe('[2] serializePoolEntryYaml — preserves every config key', () => {
  it('basic entry emits type + title only', () => {
    const lines = serializePoolEntryYaml(
      { id: 'containers', type: 'containers', title: 'Containers', config: {} },
      4);
    eq(lines.join('\n'), '    type: containers\n    title: Containers');
  });

  it('plugin keys (topic, select_from, refresh_interval_ms) survive', () => {
    const lines = serializePoolEntryYaml(
      {
        id: 'stats', type: 'stats', title: 'Stats',
        config: { topic: 'docker.stats', select_from: 'containers', refresh_interval_ms: 2000 },
      },
      4);
    const out = lines.join('\n');
    assert(out.includes('topic: docker.stats'),         'topic preserved');
    assert(out.includes('select_from: containers'),     'select_from preserved');
    assert(out.includes('refresh_interval_ms: 2000'),   'refresh_interval_ms preserved');
  });

  it('decorators list survives as flow-style YAML', () => {
    const lines = serializePoolEntryYaml(
      { id: 'c', type: 'containers', title: 'Containers',
        config: { decorators: ['status', 'image'] } },
      4);
    assert(lines.join('\n').includes('decorators: [status, image]'),
      `decorators emitted (got ${JSON.stringify(lines)})`);
  });

  it('bookkeeping fields (id, _synthesized) are NOT emitted', () => {
    const lines = serializePoolEntryYaml(
      { id: 'groups', type: 'groups', title: 'Groups', config: {}, _synthesized: true },
      4);
    const joined = lines.join('\n');
    assert(!joined.includes('id:'),            'id key not emitted (mapping key, not body)');
    assert(!joined.includes('_synthesized'),    'parser bookkeeping not leaked');
  });
});

describe('[3] serializeLayoutCell — bare-string vs mapping', () => {
  it('single-tab pane with no overrides → bare pool-id string', () => {
    const lines = serializeLayoutCell(pane({ id: 'groups', type: 'groups' }), 8, {});
    eq(lines, ['      - groups']);
  });

  it('multi-tab pane → mapping with tabs list', () => {
    const lines = serializeLayoutCell(pane({
      id: 'docker', type: 'docker',
      tabs: [{ id: 'docker', poolId: 'docker' }, { id: 'logs', poolId: 'logs' }],
      activeTabId: 'docker',
    }), 8, {});
    const out = lines.join('\n');
    assert(out.includes('tabs: [docker, logs]'),  'tabs list emitted');
    assert(!out.includes('activeTab:'),            'activeTab suppressed when equal to tabs[0]');
  });

  it('multi-tab pane with non-default activeTab → emits activeTab', () => {
    const lines = serializeLayoutCell(pane({
      id: 'logs', type: 'logs',
      tabs: [{ id: 'docker', poolId: 'docker' }, { id: 'logs', poolId: 'logs' }],
      activeTabId: 'logs',
    }), 8, {});
    const out = lines.join('\n');
    assert(out.includes('tabs: [docker, logs]'), 'tabs preserved');
    assert(out.includes('activeTab: logs'),       'activeTab written when non-default');
  });

  it('heightPct override → mapping form, heightPct emitted', () => {
    const lines = serializeLayoutCell(
      pane({ id: 'groups', type: 'groups', heightPct: 40 }), 8, {});
    const out = lines.join('\n');
    assert(out.includes('tabs: [groups]'), 'single-tab pane lifts to mapping when override present');
    assert(out.includes('heightPct: 40'),  'heightPct preserved');
  });

  it('collapsed: true → emitted; collapsed: false → omitted', () => {
    const onLines = serializeLayoutCell(
      pane({ id: 'files', type: 'files', collapsed: true }), 8, {});
    const offLines = serializeLayoutCell(
      pane({ id: 'files', type: 'files', collapsed: false }), 8, {});
    assert(onLines.join('\n').includes('collapsed: true'),  'true emitted');
    assert(!offLines.join('\n').includes('collapsed'),       'false suppressed');
    // collapsed: false → no overrides → bare-string form
    eq(offLines, ['      - files']);
  });

  it('detail pane → height synthesized from arrange.detailHeightPct', () => {
    const lines = serializeLayoutCell(
      pane({ id: 'detail', type: 'detail' }), 8, { detailHeightPct: 75 });
    const out = lines.join('\n');
    assert(out.includes('tabs: [detail]'), 'detail forced into mapping form by height override');
    assert(out.includes('height: 75%'),     'height N% written');
  });

  it('non-detail pane → detailHeightPct option is ignored', () => {
    const lines = serializeLayoutCell(
      pane({ id: 'groups', type: 'groups' }), 8, { detailHeightPct: 75 });
    eq(lines, ['      - groups'], 'no height leaks onto non-detail panes');
  });
});

describe('[4] serializeLayout — full layout block', () => {
  it('emits a well-formed layout: block with pool-ref cells', () => {
    const out = serializeLayout({
      detailHeightPct: 60,
      columns: [
        { width: 32, panels: [
          pane({ id: 'containers', type: 'containers' }),
          pane({ id: 'groups',     type: 'groups' }),
        ] },
        { panels: [
          pane({ id: 'actions', type: 'actions' }),
          pane({ id: 'stats',   type: 'stats' }),
          pane({ id: 'detail',  type: 'detail' }),
        ] },
      ],
      pool: {
        containers: { id: 'containers', type: 'containers', title: 'Containers', config: {} },
        groups:     { id: 'groups',     type: 'groups',     title: 'Groups',     config: {} },
        actions:    { id: 'actions',    type: 'actions',    title: 'Actions',    config: {} },
        stats:      { id: 'stats',      type: 'stats',      title: 'Stats',      config: {} },
        detail:     { id: 'detail',     type: 'detail',     title: 'Detail',     config: {} },
      },
    });
    assert(out.startsWith('layout:\n  columns:\n'),
      `starts with layout/columns (got start: ${JSON.stringify(out.slice(0, 60))})`);
    assert(out.includes('width: 32'),        'first column width emitted');
    assert(out.includes('- containers'),     'first col pool-ref cell for containers');
    assert(out.includes('- groups'),         'first col pool-ref cell for groups');
    assert(out.includes('- actions'),        'last col pool-ref cell for actions');
    assert(out.includes('- stats'),          'last col pool-ref cell for stats');
    assert(out.includes('tabs: [detail]'),   'detail lifts to mapping form for height');
    assert(out.includes('height: 60%'),      'detail height synthesized');
  });

  it('round-trips through the parser — every pool-entry config key survives', () => {
    // End-to-end: write a v0.6.1-shaped YAML, run parse(), assert
    // pool entries carry every extra key back.
    const tmp = path.join(os.tmpdir(), `lazytui-yaml-rt-${process.pid}.yml`);
    const layoutYaml = serializeLayout({
      detailHeightPct: 70,
      columns: [
        { width: 28, panels: [pane({ id: 'containers', type: 'containers' })] },
        { panels: [
          pane({ id: 'stats',  type: 'stats' }),
          pane({ id: 'detail', type: 'detail' }),
        ] },
      ],
      pool: {
        containers: { id: 'containers', type: 'containers', title: 'Containers',
                      config: { decorators: ['status'] } },
        stats: { id: 'stats', type: 'stats', title: 'Stats',
                 config: { topic: 'docker.stats', select_from: 'containers', refresh_interval_ms: 1500 } },
        detail: { id: 'detail', type: 'detail', title: 'Detail', config: {} },
      },
    });
    const poolYaml = serializePanelsBlock({
      pool: {
        containers: { id: 'containers', type: 'containers', title: 'Containers',
                      config: { decorators: ['status'] } },
        stats: { id: 'stats', type: 'stats', title: 'Stats',
                 config: { topic: 'docker.stats', select_from: 'containers', refresh_interval_ms: 1500 } },
        detail: { id: 'detail', type: 'detail', title: 'Detail', config: {} },
      },
    });
    const fullYaml = `groups:\n  g1:\n    label: g1\n    actions:\n      noop:\n        label: noop\n        cmd: "true"\n\n${poolYaml}\n\n${layoutYaml}\n`;
    fs.writeFileSync(tmp, fullYaml);

    const { parse } = require('../parser');
    let cfg;
    try { cfg = parse(tmp); } finally { fs.unlinkSync(tmp); }

    eq(cfg.layout.columns[0].width, 28, 'first column width round-trips');
    eq(cfg.layout.detail_height_pct, 70, 'detail height round-trips');
    eq(cfg.layout.pool.containers.config.decorators.join(','), 'status',
       'decorators survive YAML round-trip');
    eq(cfg.layout.pool.stats.config.topic, 'docker.stats',
       'topic survives YAML round-trip');
    eq(cfg.layout.pool.stats.config.select_from, 'containers',
       'select_from survives YAML round-trip');
    eq(cfg.layout.pool.stats.config.refresh_interval_ms, 1500,
       'refresh_interval_ms survives YAML round-trip');
  });

  it('round-trips a plugin files panel\'s string extras (source/container/root)', () => {
    // Regression for design-mode save → reload dropping plugin panel
    // options. The pool-entry form carries the string extras; a save
    // (serialize) followed by reload (parse) must preserve them.
    const tmp = path.join(os.tmpdir(), `lazytui-yaml-rt2-${process.pid}.yml`);
    const arrange = {
      detailHeightPct: 60,
      columns: [
        { width: 32, panels: [
          pane({ id: 'groups', type: 'groups' }),
          pane({ id: 'files',  type: 'files' }),
        ] },
        { panels: [pane({ id: 'detail', type: 'detail' })] },
      ],
      pool: {
        groups: { id: 'groups', type: 'groups', title: 'Groups', config: {} },
        files: { id: 'files', type: 'files', title: 'PGDATA',
                 config: { source: 'docker', container: 'pg', root: '/var/lib/postgresql/data' } },
        detail: { id: 'detail', type: 'detail', title: 'Detail', config: {} },
      },
    };
    const fullYaml = `groups:\n  g1:\n    label: g1\n    actions:\n      noop:\n        label: noop\n        cmd: "true"\n\n${serializePanelsBlock(arrange)}\n\n${serializeLayout(arrange)}\n`;
    fs.writeFileSync(tmp, fullYaml);
    const { parse } = require('../parser');
    let cfg;
    try { cfg = parse(tmp); } finally { fs.unlinkSync(tmp); }

    const files = cfg.layout.pool.files;
    assert(files, 'files pool entry survives round-trip');
    eq(files.title, 'PGDATA', 'title preserved');
    eq(files.config.source, 'docker', 'source extra round-trips');
    eq(files.config.container, 'pg', 'container extra round-trips');
    eq(files.config.root, '/var/lib/postgresql/data', 'root extra round-trips');
  });
});

describe('[5] writeLayoutToFile — splices both panels: and layout: blocks', () => {
  it('replaces existing blocks, preserves the rest of the file', () => {
    const tmp = path.join(os.tmpdir(), `lazytui-write-rt-${process.pid}.yml`);
    fs.writeFileSync(tmp, [
      '# top comment',
      'groups:',
      '  g1:',
      '    label: g1',
      '    actions:',
      '      noop:',
      '        label: noop',
      '        cmd: "true"',
      '',
      'panels:',
      '  containers:',
      '    type: containers',
      '    title: Old Title',
      '  detail:',
      '    type: detail',
      '    title: Detail',
      '',
      'layout:',
      '  columns:',
      '    -',
      '      width: 20',
      '      panels:',
      '        - containers',
      '    -',
      '      panels:',
      '        - tabs: [detail]',
      '          height: 50%',
      '',
      '# trailing comment',
    ].join('\n'));

    const arrange = {
      detailHeightPct: 65,
      columns: [
        { width: 35, panels: [pane({ id: 'containers', type: 'containers' })] },
        { panels: [pane({ id: 'detail', type: 'detail' })] },
      ],
      pool: {
        containers: { id: 'containers', type: 'containers', title: 'New Title',
                      config: { decorators: ['status'] } },
        detail: { id: 'detail', type: 'detail', title: 'Detail', config: {} },
      },
    };
    const result = writeLayoutToFile(arrange, tmp);
    eq(result.error, null, 'no error');

    const after = fs.readFileSync(tmp, 'utf8');
    fs.unlinkSync(tmp);

    assert(after.includes('# top comment'),     'top comment preserved');
    assert(after.includes('# trailing comment'), 'trailing comment preserved');
    assert(after.includes('groups:'),            'groups block preserved');
    assert(after.includes('width: 35'),          'new width written');
    // Title contains a space → quoted by yamlValue. That's the right
    // shape — the parser strips the quotes on the way back in.
    assert(after.includes('title: "New Title"'), 'new title written (quoted because of space)');
    assert(after.includes('decorators: [status]'), 'new decorators written on pool entry');
    assert(after.includes('height: 65%'),        'new detail height written on cell');
    assert(!after.includes('width: 20'),         'old width gone');
    assert(!after.includes('Old Title'),          'old title gone');
  });

  it('inserts both blocks when neither was present', () => {
    const tmp = path.join(os.tmpdir(), `lazytui-write-fresh-${process.pid}.yml`);
    fs.writeFileSync(tmp, [
      'groups:',
      '  g1:',
      '    label: g1',
      '    actions:',
      '      noop:',
      '        label: noop',
      '        cmd: "true"',
      '',
    ].join('\n'));
    const arrange = {
      detailHeightPct: 60,
      columns: [
        { width: 30, panels: [pane({ id: 'groups', type: 'groups' })] },
        { panels: [pane({ id: 'detail', type: 'detail' })] },
      ],
      pool: {
        groups: { id: 'groups', type: 'groups', title: 'Groups', config: {} },
        detail: { id: 'detail', type: 'detail', title: 'Detail', config: {} },
      },
    };
    const result = writeLayoutToFile(arrange, tmp);
    eq(result.error, null, 'no error');
    const after = fs.readFileSync(tmp, 'utf8');
    fs.unlinkSync(tmp);
    assert(/^panels:/m.test(after),  'panels: block inserted');
    assert(/^layout:/m.test(after),  'layout: block inserted');
    assert(after.indexOf('panels:') < after.indexOf('layout:'),
      'panels: precedes layout: (file ordering)');
  });

  it('returns error for unwritable path', () => {
    const result = writeLayoutToFile(
      { detailHeightPct: 60, columns: [{ panels: [] }], pool: {} },
      '/nonexistent-dir/cannot-write.yml'
    );
    assert(result.error !== null, 'error surfaced');
    assert(result.error.code === 'ENOENT', `ENOENT error (got ${result.error.code})`);
  });

  it('refuses to overwrite when file has duplicate top-level header (T1.3)', () => {
    const tmp = path.join(os.tmpdir(), `lazytui-yaml-dup-${Date.now()}.yml`);
    // Two `layout:` blocks in the same file (malformed). The old impl
    // picked the LAST `start` but kept `end` from the first range,
    // splicing a new block before the trailing duplicate without
    // removing it — file corruption. New impl refuses with a clear error.
    fs.writeFileSync(tmp, [
      'panels:',
      '  groups: { type: groups }',
      '  detail: { type: detail }',
      'layout:',
      '  columns:',
      '    - panels: [groups]',
      '    - panels: [detail]',
      'groups: {}',
      'layout:',
      '  columns:',
      '    - panels: [detail]',
      '',
    ].join('\n'));
    const arrange = {
      detailHeightPct: 60,
      columns: [
        { width: 30, panels: [pane({ id: 'groups', type: 'groups' })] },
        { panels: [pane({ id: 'detail', type: 'detail' })] },
      ],
      pool: {
        groups: { id: 'groups', type: 'groups', title: 'Groups', config: {} },
        detail: { id: 'detail', type: 'detail', title: 'Detail', config: {} },
      },
    };
    const result = writeLayoutToFile(arrange, tmp);
    fs.unlinkSync(tmp);
    assert(result.error !== null, 'error surfaced on duplicate header');
    eq(result.error.code, 'DUPLICATE_BLOCK', 'DUPLICATE_BLOCK code');
    assert(/duplicate `layout:`/.test(result.error.message),
      `error names the duplicated block: ${result.error.message}`);
  });
});

// T3.8 — pin the multi-column (N≥4) parse→serialize→parse round-trip.
// All prior round-trip tests use 2 cols, so middle-column handling
// (hotkey pool empty, no width-default, panes survive intact) was
// unpinned.
describe('[6] multi-column (N=4) parse → serialize → re-parse round-trip', () => {
  const { parse } = require('../parser');
  it('4-column layout round-trips structurally identical', () => {
    const tmp = path.join(os.tmpdir(), `lazytui-yaml-4col-${process.pid}-1.yml`);
    const yaml = `groups:
  g1:
    label: g1
    actions:
      noop: { label: noop, cmd: "true" }

panels:
  containers: { type: containers, title: Containers }
  groups:     { type: groups,     title: Groups }
  files:      { type: files,      title: Files }
  stats:      { type: stats,      title: Stats }
  actions:    { type: actions,    title: Actions }
  detail:     { type: detail,     title: Detail }

layout:
  columns:
    - width: 20
      panels:
        - containers
        - groups
    - width: 24
      panels:
        - files
    - width: 28
      panels:
        - stats
    - panels:
        - actions
        - detail
`;
    fs.writeFileSync(tmp, yaml);
    const cfg1 = parse(tmp);
    fs.unlinkSync(tmp);

    eq(cfg1.layout.columns.length, 4, 'N=4 cols');
    eq(cfg1.layout.columns[0].panels.length, 2);
    eq(cfg1.layout.columns[1].panels.length, 1);
    eq(cfg1.layout.columns[2].panels.length, 1);
    eq(cfg1.layout.columns[3].panels.length, 2);

    // Serialize the parsed layout back to YAML and write a fresh file.
    const arrange = {
      detailHeightPct: cfg1.layout.detail_height_pct,
      columns: cfg1.layout.columns,
      pool: cfg1.layout.pool,
    };
    const layoutYaml = serializeLayout(arrange);
    const poolYaml = serializePanelsBlock(arrange);
    const fullYaml = `groups:\n  g1:\n    label: g1\n    actions:\n      noop: { label: noop, cmd: "true" }\n\n${poolYaml}\n\n${layoutYaml}\n`;

    const tmp2 = path.join(os.tmpdir(), `lazytui-yaml-4col-${process.pid}-2.yml`);
    fs.writeFileSync(tmp2, fullYaml);
    const cfg2 = parse(tmp2);
    fs.unlinkSync(tmp2);

    eq(cfg2.layout.columns.length, 4, 're-parse keeps N=4');
    eq(cfg2.layout.columns[0].width, cfg1.layout.columns[0].width, 'col 0 width');
    eq(cfg2.layout.columns[1].width, cfg1.layout.columns[1].width, 'col 1 width (middle)');
    eq(cfg2.layout.columns[2].width, cfg1.layout.columns[2].width, 'col 2 width (middle)');
    // Pane membership per column survives.
    for (let ci = 0; ci < 4; ci++) {
      const before = cfg1.layout.columns[ci].panels.map(p => p.id).join(',');
      const after  = cfg2.layout.columns[ci].panels.map(p => p.id).join(',');
      eq(after, before, `col ${ci} pane ids preserved`);
    }
    // Middle columns get an EMPTY hotkey pool (only first/last cols
    // get auto-pools). Panes there should have empty hotkeys.
    for (const p of cfg2.layout.columns[1].panels) {
      eq(p.hotkey, '', 'col 1 (middle) pane hotkey is empty');
    }
    for (const p of cfg2.layout.columns[2].panels) {
      eq(p.hotkey, '', 'col 2 (middle) pane hotkey is empty');
    }
  });
});

report();
