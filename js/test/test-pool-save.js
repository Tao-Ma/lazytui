/**
 * Phase 6 — extending :save-layout to write the v0.6 `panels:` block.
 *
 * Three contracts pinned here:
 *
 *   1. Legacy configs (no `panels:`, every pool entry synthesized AND
 *      placed) round-trip in inline form — file shape preserved.
 *   2. Configs with HIDDEN entries OR a user-declared `panels:` block
 *      write both blocks; layout cells become id-refs.
 *   3. Idempotency: parse → save → parse → save produces the same
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
const { rebuildLayoutFromConfig } = require('../app/state');
const {
  serializeLayout,
  serializePanelsBlock,
  shouldWritePool,
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

describe('[shouldWritePool] gate that decides whether panels: lands in the file', () => {
  it('legacy config: every entry synthesized AND placed → no pool block', () => {
    const cfg = parse(tmpYaml(GROUPS + `
layout:
  left:  { panels: [{ type: groups }] }
  right: { panels: [{ type: actions }, { type: detail }] }
`, 'legacy.yml'));
    const arrange = rebuildLayoutFromConfig(cfg);
    eq(shouldWritePool(arrange), false);
  });
  it('hidden pool entry → pool block needed', () => {
    const cfg = parse(tmpYaml(GROUPS + `
panels:
  g:     { type: groups }
  notes: { type: viewer, title: Notes }
  a:     { type: actions }
  d:     { type: detail }
layout:
  left:  { panels: [g] }
  right: { panels: [a, d] }
`, 'hidden.yml'));
    const arrange = rebuildLayoutFromConfig(cfg);
    assert(shouldWritePool(arrange));
  });
  it('user-declared pool entry (non-synthesized) → pool block needed', () => {
    // Every entry placed but `notes` is user-declared (no inline cell
    // declares it, but the explicit panels: makes it non-synthesized).
    const cfg = parse(tmpYaml(GROUPS + `
panels:
  g: { type: groups }
  a: { type: actions }
  d: { type: detail }
layout:
  left:  { panels: [g] }
  right: { panels: [a, d] }
`, 'declared.yml'));
    const arrange = rebuildLayoutFromConfig(cfg);
    assert(shouldWritePool(arrange));
  });
});

describe('[serializeLayout] picks form based on shouldWritePool', () => {
  it('legacy arrange → inline form (type: ...), no panels: block', () => {
    const cfg = parse(tmpYaml(GROUPS + `
layout:
  right: { panels: [{ type: actions }, { type: detail }] }
`, 'legacy2.yml'));
    const arrange = rebuildLayoutFromConfig(cfg);
    const yaml = serializeLayout(arrange);
    assert(yaml.includes('type: actions'), 'inline type field emitted');
    eq(serializePanelsBlock(arrange), null, 'no pool block when not needed');
  });
  it('arrange with hidden pool → id-ref cells + panels: block emitted', () => {
    const cfg = parse(tmpYaml(GROUPS + `
panels:
  g:     { type: groups }
  notes: { type: viewer, title: Notes }
  a:     { type: actions }
  d:     { type: detail }
layout:
  left:  { panels: [g] }
  right: { panels: [a, d] }
`, 'hidden2.yml'));
    const arrange = rebuildLayoutFromConfig(cfg);
    const layoutYaml = serializeLayout(arrange);
    const poolYaml = serializePanelsBlock(arrange);
    assert(layoutYaml.includes('- g'), 'left cell is id-ref string');
    assert(layoutYaml.includes('- a'), 'right cell is id-ref string');
    assert(!layoutYaml.includes('type: groups'), 'no inline type when pool form');
    assert(poolYaml.includes('panels:'), 'pool block header');
    assert(poolYaml.includes('notes:'), 'hidden entry serialized');
    assert(poolYaml.includes('type: viewer'), 'pool entry carries type');
    assert(poolYaml.includes('title: Notes'), 'pool entry carries title');
  });
  it('detail height survives the id-ref form via { id: detail, height: N% }', () => {
    const cfg = parse(tmpYaml(GROUPS + `
panels:
  g: { type: groups }
  a: { type: actions }
  d: { type: detail }
  x: { type: viewer, title: X }
layout:
  left:  { panels: [g] }
  right:
    panels:
      - a
      - { id: d, height: 70% }
`, 'detail-height.yml'));
    const arrange = rebuildLayoutFromConfig(cfg);
    eq(arrange.detailHeightPct, 70, 'parser captured height as detailHeightPct');
    const layoutYaml = serializeLayout(arrange);
    assert(layoutYaml.includes('height: 70%'), 'height re-emitted on detail cell');
    assert(/-\s+id: d\b/.test(layoutYaml), 'detail cell uses mapping form (id ref + override)');
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
  it('legacy config: stable across two saves', () => {
    roundTrip(GROUPS + `
layout:
  left:  { panels: [{ type: groups }] }
  right: { panels: [{ type: actions }, { type: detail }] }
`, 'legacy-rt.yml');
  });
  it('pool config with hidden entries: stable across two saves', () => {
    roundTrip(GROUPS + `
panels:
  g:     { type: groups }
  notes: { type: viewer, title: Notes }
  a:     { type: actions }
  d:     { type: detail }
layout:
  left:  { panels: [g] }
  right: { panels: [a, d] }
`, 'pool-rt.yml');
  });
});

describe('[upgrade] hide on a legacy file writes panels: block', () => {
  it('legacy → hide pool entry → save adds panels: block + uses id-refs', () => {
    const original = GROUPS + `
layout:
  left:  { panels: [{ type: groups }, { type: files, source: declared }] }
  right: { panels: [{ type: actions }, { type: detail, height: 60% }] }
`;
    const p = tmpYaml(original, 'upgrade.yml');
    const cfg = parse(p);
    const arrange = rebuildLayoutFromConfig(cfg);
    // Simulate :hide files
    arrange.leftPanels = arrange.leftPanels.filter(x => x.id !== 'files');
    // pool still has files entry (synthesized + now-unplaced)
    assert(shouldWritePool(arrange), 'hidden synth entry triggers pool emission');
    const r = writeLayoutToFile(arrange, p);
    eq(r.error, null);
    const after = fs.readFileSync(p, 'utf8');
    assert(after.includes('panels:\n'),    'pool block written');
    assert(after.includes('files:\n'),     'hidden entry in pool block');
    // Reload and verify the pool round-trips
    const cfg2 = parse(p);
    const arrange2 = rebuildLayoutFromConfig(cfg2);
    assert('files' in arrange2.pool, 'files survives reload via pool');
    eq(arrange2.leftPanels.find(x => x.id === 'files'), undefined,
       'files stays hidden after reload');
  });
});

describe('[downgrade] removing the last pool requirement drops the panels: block', () => {
  it('config with hidden entry: re-show it, save → panels: block is removed', () => {
    const original = GROUPS + `
panels:
  g:     { type: groups }
  notes: { type: viewer, title: Notes }
  a:     { type: actions }
  d:     { type: detail }
layout:
  left:  { panels: [g] }
  right: { panels: [a, d] }
`;
    const p = tmpYaml(original, 'downgrade.yml');
    const cfg = parse(p);
    const arrange = rebuildLayoutFromConfig(cfg);
    // Convert all pool entries to _synthesized=true so the "non-synth
    // present" trigger is gone; place notes so the "hidden present"
    // trigger is also gone. This simulates a "save after every entry
    // was placed and the file's now legacy-compatible" scenario —
    // arguably exotic in practice (the user-declared origin survives
    // pool round-trip), but the downgrade path should still work.
    for (const id of Object.keys(arrange.pool)) arrange.pool[id]._synthesized = true;
    arrange.rightPanels.unshift({
      id: 'notes', type: 'viewer', title: 'Notes', hotkey: '', column: 'right',
    });
    const r = writeLayoutToFile(arrange, p);
    eq(r.error, null);
    const after = fs.readFileSync(p, 'utf8');
    assert(!/^panels:/m.test(after), 'panels: block removed when no longer needed');
    assert(/^layout:/m.test(after),  'layout: block still present');
  });
});

report();
