/**
 * YAML `mouse:` block (v0.6.4 Theme F Phase 4) — schema validation, parser
 * threading, the mouse-bindings default-merge, and the SGR parser reading
 * the tunable double-click window.
 *
 * Mirrors test-keys-yaml.js's shape for the pointer side.
 *
 *   node js/test/test-mouse-yaml.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { describe, it, eq, assert, report } = require('./test-runner');
const { validate } = require('../parser/schema');
const { parse } = require('../parser');
const mb = require('../dispatch/mouse-bindings');
const input = require('../dispatch/input');

function base(extra) {
  return Object.assign({
    groups: { g: { label: 'G', actions: { build: { cmd: 'true', label: 'Build' } } } },
  }, extra);
}

// ---- [1] schema.validateMouse -------------------------------------

describe('[1] mouse schema', () => {
  it('accepts gesture→intent entries + double-click-ms', () => {
    validate(base({ mouse: {
      'double-click': 'activate',
      'right-click':  'context',
      'middle-click': 'noop',
      'double-click-ms': 400,
    }}), 'test');
  });
  it('rejects an unknown intent', () => {
    let t = false;
    try { validate(base({ mouse: { 'middle-click': 'paste' } }), 'test'); } catch { t = true; }
    assert(t, "intent 'paste' not in the vocabulary yet → throws");
  });
  it('rejects an unknown gesture key', () => {
    let t = false;
    try { validate(base({ mouse: { 'quadruple-click': 'activate' } }), 'test'); } catch { t = true; }
    assert(t, 'unknown gesture key throws');
  });
  it('rejects a non-integer / non-positive double-click-ms', () => {
    for (const bad of [0, -10, 1.5, '250']) {
      let t = false;
      try { validate(base({ mouse: { 'double-click-ms': bad } }), 'test'); } catch { t = true; }
      assert(t, `double-click-ms=${JSON.stringify(bad)} throws`);
    }
  });
  it('rejects a non-string intent value', () => {
    let t = false;
    try { validate(base({ mouse: { 'right-click': 5 } }), 'test'); } catch { t = true; }
    assert(t);
  });
  it('rejects a non-mapping mouse block', () => {
    let t = false;
    try { validate(base({ mouse: ['nope'] }), 'test'); } catch { t = true; }
    assert(t);
  });
  it('accepts an absent mouse block', () => {
    validate(base({}), 'test');  // no throw
  });
});

// ---- [2] parser threads mouse through -----------------------------

describe('[2] parser', () => {
  it('passes the mouse block onto the parsed config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-mouse-'));
    const file = path.join(dir, 'tui.yml');
    fs.writeFileSync(file, [
      'project_dir: .',
      'groups:',
      '  g:',
      '    label: G',
      '    actions:',
      '      build: { cmd: "true", label: Build }',
      'mouse:',
      '  double-click: activate',
      '  middle-click: context',
      '  double-click-ms: 300',
      '',
    ].join('\n'));
    try {
      const cfg = parse(file);
      assert(cfg.mouse, 'mouse present on config');
      eq(cfg.mouse['double-click'], 'activate');
      eq(cfg.mouse['middle-click'], 'context');
      eq(cfg.mouse['double-click-ms'], 300);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('defaults mouse to {} when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-mouse-'));
    const file = path.join(dir, 'tui.yml');
    fs.writeFileSync(file, 'groups:\n  g:\n    label: G\n    actions:\n      x: { cmd: "true", label: X }\n');
    try {
      const cfg = parse(file);
      eq(Object.keys(cfg.mouse).length, 0, 'empty mouse default');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- [3] mouse-bindings default-merge -----------------------------

describe('[3] mouse-bindings configure()', () => {
  it('pure defaults when no block', () => {
    mb.reset();
    eq(mb.intentFor('double-click'), 'activate');
    eq(mb.intentFor('right-click'),  'context');
    eq(mb.intentFor('middle-click'), 'noop');
    eq(mb.doubleClickMs(), 250);
  });
  it('an override merges over defaults, untouched keys keep defaults', () => {
    mb.configure({ 'right-click': 'noop', 'double-click-ms': 400 });
    eq(mb.intentFor('right-click'),  'noop',     'overridden');
    eq(mb.intentFor('double-click'), 'activate', 'default retained');
    eq(mb.intentFor('middle-click'), 'noop',     'default retained');
    eq(mb.doubleClickMs(), 400, 'window overridden');
  });
  it('configure() is idempotent — a second smaller block resets first', () => {
    mb.configure({ 'middle-click': 'context' });
    eq(mb.intentFor('middle-click'), 'context');
    eq(mb.intentFor('right-click'),  'context', 'back to default, not the prior noop');
    eq(mb.doubleClickMs(), 250, 'window back to default');
    mb.reset();
  });
  it('unknown gesture → noop, never undefined', () => {
    mb.reset();
    eq(mb.intentFor('quintuple-click'), 'noop');
  });
});

// ---- [4] SGR parser reads the tunable window ----------------------

describe('[4] _classifyPress honors double-click-ms', () => {
  it('a gap inside the configured window is a double; outside is a single', () => {
    mb.configure({ 'double-click-ms': 100 });
    input._classifyPress(0, 5, 5, 10000);                       // prime
    eq(input._classifyPress(0, 5, 5, 10090), 'double', '90ms ≤ 100ms window → double');
    input._classifyPress(0, 6, 6, 20000);                       // prime (new cell)
    eq(input._classifyPress(0, 6, 6, 20150), 'press', '150ms > 100ms window → single');
    mb.reset();
  });
});

report();
