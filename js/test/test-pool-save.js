/**
 * v0.6.1 — `:save-layout` round-trip regression.
 *
 * Three contracts pinned here:
 *
 *   1. Serializer always emits both `panels:` and `layout:` blocks.
 *      v0.6's "legacy inline form" is gone; cells are pool-ref strings
 *      or `{tabs: [...]}` mappings.
 *   2. Hidden pool entries (declared but not placed) survive the save
 *      and reappear on the next reload.
 *   3. Idempotency: parse → save → parse → save produces identical
 *      bytes. Save is not allowed to drift.
 *
 *   node js/test/test-pool-save.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { describe, it, eq, assert, report } = require('./test-runner');
const { parse } = require('../parser');
const { rebuildLayoutFromConfig } = require('../leaves/arrange');
const {
  serializeLayout,
  serializePanelsBlock,
  writeLayoutToFile,
} = require('../feature/yaml-layout');

let _tmpDir = null;
function tmpYaml(content, name) {
  if (!_tmpDir) _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-pool-save-'));
  const p = path.join(_tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

const GROUPS = `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
`;

const BASE_CONFIG = GROUPS + `
panels:
  g:     { type: groups,  title: Groups }
  a:     { type: actions, title: Actions }
  d:     { type: detail,  title: Detail }
layout:
  columns:
    - { panels: [g] }
    - { panels: [a, d] }
`;

const HIDDEN_CONFIG = GROUPS + `
panels:
  g:     { type: groups,  title: Groups }
  notes: { type: viewer,  title: Notes }
  a:     { type: actions, title: Actions }
  d:     { type: detail,  title: Detail }
layout:
  columns:
    - { panels: [g] }
    - { panels: [a, d] }
`;

describe('[serialize] always emits both panels: and layout: blocks', () => {
  it('placed-only config emits a complete pool block + pool-ref cells', () => {
    const cfg = parse(tmpYaml(BASE_CONFIG, 'placed-only.yml'));
    const arrange = rebuildLayoutFromConfig(cfg);
    const layoutYaml = serializeLayout(arrange);
    const poolYaml = serializePanelsBlock(arrange);
    assert(poolYaml.startsWith('panels:'),     'pool block header');
    assert(poolYaml.includes('g:'),             'g entry in pool block');
    assert(poolYaml.includes('a:'),             'a entry in pool block');
    assert(poolYaml.includes('d:'),             'd entry in pool block');
    assert(layoutYaml.includes('- g'),          'left cell is bare pool-ref');
    assert(layoutYaml.includes('- a'),          'right cell is bare pool-ref');
    assert(!layoutYaml.includes('type:'),        'no legacy inline `type:` in cells');
  });

  it('hidden pool entries serialize into the pool block', () => {
    const cfg = parse(tmpYaml(HIDDEN_CONFIG, 'hidden.yml'));
    const arrange = rebuildLayoutFromConfig(cfg);
    const poolYaml = serializePanelsBlock(arrange);
    assert(poolYaml.includes('notes:'),         'hidden entry in pool block');
    assert(poolYaml.includes('type: viewer'),    'pool entry carries type');
    assert(poolYaml.includes('title: Notes'),    'pool entry carries title');
  });

  it('detail height lifts onto the cell (mapping form with height: N%)', () => {
    const cfg = parse(tmpYaml(GROUPS + `
panels:
  g: { type: groups, title: Groups }
  a: { type: actions, title: Actions }
  d: { type: detail, title: Detail }
  x: { type: viewer, title: X }
layout:
  columns:
    - { panels: [g] }
    - panels:
        - a
        - { tabs: [d], height: 70% }
`, 'detail-height.yml'));
    const arrange = rebuildLayoutFromConfig(cfg);
    eq(arrange.detailHeightPct, 70, 'parser captured height as detailHeightPct');
    const layoutYaml = serializeLayout(arrange);
    assert(layoutYaml.includes('tabs: [d]'),   'detail cell uses mapping form (pool id is d)');
    assert(layoutYaml.includes('height: 70%'), 'height re-emitted on detail cell');
  });
});

describe('[idempotency] save → parse → save lands the same bytes', () => {
  function roundTrip(input, name) {
    const p = tmpYaml(input, name);
    const cfg1 = parse(p);
    const arrange1 = rebuildLayoutFromConfig(cfg1);
    const r1 = writeLayoutToFile(arrange1, p);
    eq(r1.error, null);
    const after1 = fs.readFileSync(p, 'utf8');
    const cfg2 = parse(p);
    const arrange2 = rebuildLayoutFromConfig(cfg2);
    const r2 = writeLayoutToFile(arrange2, p);
    eq(r2.error, null);
    const after2 = fs.readFileSync(p, 'utf8');
    eq(after1, after2, 'second save produces identical bytes');
  }
  it('placed-only config: stable across two saves', () => {
    roundTrip(BASE_CONFIG, 'placed-rt.yml');
  });
  it('config with hidden entries: stable across two saves', () => {
    roundTrip(HIDDEN_CONFIG, 'hidden-rt.yml');
  });
  it('config with detail height override: stable across two saves', () => {
    roundTrip(GROUPS + `
panels:
  g: { type: groups, title: Groups }
  a: { type: actions, title: Actions }
  d: { type: detail, title: Detail }
layout:
  columns:
    - { panels: [g] }
    - panels:
        - a
        - { tabs: [d], height: 65% }
`, 'height-rt.yml');
  });
});

describe('[hide] hiding a placed panel keeps its entry in the pool', () => {
  it('hide groups → save → reload retains pool entry, drops placement', () => {
    const p = tmpYaml(GROUPS + `
panels:
  g:     { type: groups,  title: Groups }
  files: { type: files,   title: Files, source: declared }
  a:     { type: actions, title: Actions }
  d:     { type: detail,  title: Detail }
layout:
  columns:
    - { panels: [g, files] }
    - { panels: [a, d] }
`, 'hide.yml');
    const cfg = parse(p);
    const arrange = rebuildLayoutFromConfig(cfg);
    // Simulate :hide files — remove placement, keep pool entry.
    arrange.columns[0] = {
      ...arrange.columns[0],
      panels: arrange.columns[0].panels.filter(x => x.id !== 'files'),
    };
    const r = writeLayoutToFile(arrange, p);
    eq(r.error, null);
    const after = fs.readFileSync(p, 'utf8');
    assert(after.includes('files:'),            'files pool entry preserved');
    assert(!/-\s+files\s*$/m.test(after),        'files no longer placed in layout');

    // Reload and verify the pool entry round-trips as hidden.
    const cfg2 = parse(p);
    const arrange2 = rebuildLayoutFromConfig(cfg2);
    assert('files' in arrange2.pool,             'files survives reload via pool');
    eq(arrange2.columns[0].panels.find(x => x.id === 'files'), undefined,
       'files stays hidden after reload');
  });
});

describe('[show] re-placing a hidden entry uses pool-ref cell on save', () => {
  it('hidden notes → place it → save → cell is bare pool-ref', () => {
    const p = tmpYaml(HIDDEN_CONFIG, 'show.yml');
    const cfg = parse(p);
    const arrange = rebuildLayoutFromConfig(cfg);
    eq(arrange.columns[0].panels.find(x => x.id === 'notes'), undefined,
       'notes starts hidden');
    // Place notes — synthesize a pane from the pool entry.
    const mpane = require('../leaves/pane');
    const entry = arrange.pool.notes;
    arrange.columns[0].panels.push(mpane.wrapAsPane({
      id: entry.id, type: entry.type, title: entry.title,
      hotkey: '', columnIndex: 0, config: entry.config,
    }, mpane.newPaneId(entry.id)));
    const r = writeLayoutToFile(arrange, p);
    eq(r.error, null);
    const after = fs.readFileSync(p, 'utf8');
    assert(/-\s+notes\s*$/m.test(after),         'notes placed as bare pool-ref cell');
    // Reload: notes is now in first column, still in pool.
    const cfg2 = parse(p);
    assert(cfg2.layout.columns[0].panels.some(x => x.id === 'notes'),
       'notes placed after reload');
    assert('notes' in cfg2.layout.pool,           'notes still in pool');
  });
});

report();
