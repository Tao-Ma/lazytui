/**
 * Layout YAML serializer — round-trip regression for plugin panel
 * key preservation.
 *
 * Pins the fix for: Design Mode used to drop every panel key on save
 * except `type` / `title` (and `height` for detail). On a config
 * like:
 *
 *   layout:
 *     right:
 *       panels:
 *         - type: stats
 *           title: Stats
 *           topic: docker.stats          # ← lost on save
 *           select_from: containers      # ← lost on save
 *           refresh_interval_ms: 2000    # ← lost on save
 *
 * Enter in design mode would silently strip those three keys, killing
 * the stats panel's hub subscription, cross-panel data wiring, and
 * per-plugin refresh cadence. This test pins that:
 *
 *   1. The serializer emits every key on the runtime panel object,
 *      except runtime-only keys (`hotkey`, `column`, `config`).
 *   2. Detail panel synthesizes `height: N%` from `detailHeightPct`.
 *   3. The full emit→write→reparse round-trip through the Python
 *      parser produces a structurally identical PanelConfig — every
 *      `config` key survives.
 *
 * Run: node js/test/test-yaml-layout.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { serializeLayout, serializePanelYaml, yamlValue, writeLayoutToFile } = require('../yaml-layout');
const { describe, it, assert, eq, report } = require('./test-runner');

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
});

describe('[2] serializePanelYaml — preserves every key except runtime-derived', () => {
  it('basic panel emits type + title only', () => {
    const lines = serializePanelYaml(
      { type: 'containers', title: 'Containers', hotkey: '1', column: 'left' },
      8, {}
    );
    eq(lines.join('\n'),
       '      - type: containers\n        title: Containers');
  });

  it('plugin keys (topic, select_from, refresh_interval_ms) survive', () => {
    const lines = serializePanelYaml(
      {
        type: 'stats', title: 'Stats', hotkey: '7', column: 'right',
        topic: 'docker.stats', select_from: 'containers', refresh_interval_ms: 2000,
      },
      8, {}
    );
    const out = lines.join('\n');
    assert(out.includes('topic: docker.stats'), 'topic preserved');
    assert(out.includes('select_from: containers'), 'select_from preserved');
    assert(out.includes('refresh_interval_ms: 2000'), 'refresh_interval_ms preserved');
    assert(!out.includes('hotkey:'), 'hotkey NOT written (derived on load)');
    assert(!out.includes('column:'), 'column NOT written (derived on load)');
  });

  it('decorators list survives as flow-style YAML', () => {
    const lines = serializePanelYaml(
      { type: 'containers', title: 'Containers', decorators: ['status', 'image'] },
      8, {}
    );
    assert(lines.join('\n').includes('decorators: [status, image]'),
      `decorators emitted (got ${JSON.stringify(lines)})`);
  });

  it('detail panel synthesizes height from detailHeightPct', () => {
    const lines = serializePanelYaml(
      { type: 'detail', title: 'Detail', hotkey: 'o', column: 'right' },
      8, { detailHeightPct: 75 }
    );
    assert(lines.join('\n').includes('height: 75%'),
      `detail height emitted as "75%" (got ${JSON.stringify(lines)})`);
  });

  it('config key (already-spread plugin config) is NOT re-emitted', () => {
    // state.js spreads p.config onto the panel, so re-emitting `config:`
    // here would double-nest. Must be filtered.
    const lines = serializePanelYaml(
      { type: 'stats', title: 'Stats', config: { topic: 'x' } },
      8, {}
    );
    assert(!lines.join('\n').includes('config:'),
      'config: key filtered out (already spread at load time)');
  });
});

describe('[3] serializeLayout — full layout block', () => {
  it('emits a well-formed layout block with all panel extras', () => {
    const out = serializeLayout({
      leftWidth: 32, detailHeightPct: 60,
      leftPanels: [
        { type: 'containers', title: 'Containers', hotkey: '1', column: 'left',
          decorators: ['status', 'image'] },
      ],
      rightPanels: [
        { type: 'stats', title: 'Stats', hotkey: '7', column: 'right',
          topic: 'docker.stats', select_from: 'containers', refresh_interval_ms: 2000 },
        { type: 'detail', title: 'Detail', hotkey: 'o', column: 'right' },
      ],
    });
    assert(out.startsWith('layout:\n  left:\n    width: 32\n'),
      `starts with layout/left/width (got start: ${JSON.stringify(out.slice(0, 60))})`);
    assert(out.includes('decorators: [status, image]'), 'left panel decorators');
    assert(out.includes('topic: docker.stats'), 'right panel topic');
    assert(out.includes('select_from: containers'), 'right panel select_from');
    assert(out.includes('refresh_interval_ms: 2000'), 'right panel refresh_interval_ms');
    assert(out.includes('height: 60%'), 'detail height synthesized');
  });

  it('round-trips through the Python parser — every config key survives', () => {
    // End-to-end: write what we emit to a file, run the parser,
    // assert PanelConfig.config has every extra key back.
    const tmp = path.join(os.tmpdir(), `lazytui-yaml-rt-${process.pid}.yml`);
    const layoutYaml = serializeLayout({
      leftWidth: 28, detailHeightPct: 70,
      leftPanels: [{ type: 'containers', title: 'Containers', decorators: ['status'] }],
      rightPanels: [
        { type: 'stats', title: 'Stats',
          topic: 'docker.stats', select_from: 'containers', refresh_interval_ms: 1500 },
        { type: 'detail', title: 'Detail' },
      ],
    });
    const fullYaml = `groups:\n  g1:\n    label: g1\n    actions:\n      noop:\n        label: noop\n        cmd: "true"\n\n${layoutYaml}\n`;
    fs.writeFileSync(tmp, fullYaml);

    const { spawnSync } = require('child_process');
    const pyScript = `
import sys, json
sys.path.insert(0, '${path.resolve(__dirname, '../../parser')}')
from parser import parse
cfg = parse('${tmp}')
print(json.dumps({
  'left_width': cfg.layout.left_width,
  'detail_height_pct': cfg.layout.detail_height_pct,
  'left_panels': [{'type': p.type, 'title': p.title, 'config': p.config} for p in cfg.layout.left_panels],
  'right_panels': [{'type': p.type, 'title': p.title, 'config': p.config} for p in cfg.layout.right_panels],
}))
`;
    const venvPy = path.resolve(__dirname, '../../.venv/bin/python3');
    const py = fs.existsSync(venvPy) ? venvPy : 'python3';
    const res = spawnSync(py, ['-c', pyScript], { encoding: 'utf8' });
    fs.unlinkSync(tmp);

    if (res.status !== 0) {
      assert(false, `parser invocation failed: ${res.stderr || res.stdout}`);
      return;
    }
    const parsed = JSON.parse(res.stdout.trim());

    eq(parsed.left_width, 28, 'left width round-trips');
    eq(parsed.detail_height_pct, 70, 'detail height round-trips');
    eq(parsed.left_panels[0].config.decorators.join(','), 'status', 'decorators survive YAML round-trip');

    const stats = parsed.right_panels.find(p => p.type === 'stats');
    eq(stats.config.topic, 'docker.stats', 'topic survives YAML round-trip');
    eq(stats.config.select_from, 'containers', 'select_from survives YAML round-trip');
    eq(stats.config.refresh_interval_ms, 1500, 'refresh_interval_ms survives YAML round-trip');
  });
});

describe('[4] writeLayoutToFile — splices the layout block into an existing config', () => {
  it('replaces existing layout block, preserves the rest of the file', () => {
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
      'layout:',
      '  left:',
      '    width: 20',
      '    panels:',
      '      - type: containers',
      '        title: Old Title',
      '  right:',
      '    panels:',
      '      - type: detail',
      '        title: Detail',
      '        height: 50%',
      '',
      '# trailing comment',
    ].join('\n'));

    const layout = {
      leftWidth: 35, detailHeightPct: 65,
      leftPanels: [{ type: 'containers', title: 'New Title', decorators: ['status'] }],
      rightPanels: [{ type: 'detail', title: 'Detail' }],
    };
    const result = writeLayoutToFile(layout, tmp);
    eq(result.error, null, 'no error');

    const after = fs.readFileSync(tmp, 'utf8');
    fs.unlinkSync(tmp);

    assert(after.includes('# top comment'), 'top comment preserved');
    assert(after.includes('# trailing comment'), 'trailing comment preserved');
    assert(after.includes('groups:'), 'groups block preserved');
    assert(after.includes('width: 35'), 'new width written');
    // Title contains a space → quoted by yamlValue. That's the right
    // shape — the parser strips the quotes on the way back in.
    assert(after.includes('title: "New Title"'), 'new title written (quoted because of space)');
    assert(after.includes('decorators: [status]'), 'new decorators written');
    assert(after.includes('height: 65%'), 'new detail height written');
    assert(!after.includes('width: 20'), 'old width gone');
    assert(!after.includes('Old Title'), 'old title gone');
  });

  it('returns error for unwritable path', () => {
    const result = writeLayoutToFile(
      { leftWidth: 30, detailHeightPct: 60, leftPanels: [], rightPanels: [] },
      '/nonexistent-dir/cannot-write.yml'
    );
    assert(result.error !== null, 'error surfaced');
    assert(result.error.code === 'ENOENT', `ENOENT error (got ${result.error.code})`);
  });
});

report();
