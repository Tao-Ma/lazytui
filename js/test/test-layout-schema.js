/**
 * §10 layout-constraint validation (parser/schema.js validateLayout).
 * Previously these invariants were documented only and violations
 * surfaced as render-time crashes; now they fail cleanly at parse.
 *
 * Run: node js/test/test-layout-schema.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { describe, it, assert, report } = require('./test-runner');
const { validate } = require('../parser/schema');
const { parse } = require('../parser');

// Minimal valid base; vary `layout`. v0.6.1 — cells reference pool ids
// declared in the top-level `panels:` block; the helpers below seed a
// pool that covers every id any case might reference.
function withLayout(layout, extraPool = {}) {
  return {
    groups: { g: { label: 'G', actions: { x: { cmd: 'true', label: 'X' } } } },
    panels: {
      groups:  { type: 'groups' },
      actions: { type: 'actions' },
      detail:  { type: 'detail' },
      a:       { type: 'a' },
      b:       { type: 'b' },
      c:       { type: 'c' },
      ...extraPool,
    },
    layout,
  };
}
function ok(layout) { validate(withLayout(layout), 'test'); }           // throws on failure
function bad(layout) {
  let threw = false;
  try { validate(withLayout(layout), 'test'); } catch { threw = true; }
  assert(threw, 'expected a SchemaError');
}
// Soft warning collected, no throw. Returns the warnings array.
function warns(layout, codeMatch) {
  const warnings = [];
  validate(withLayout(layout), 'test', warnings);
  const hit = warnings.find(w => w.code === codeMatch);
  assert(hit, `expected a warning with code '${codeMatch}', got ${JSON.stringify(warnings)}`);
  return warnings;
}

// Cardinality checks (exactly-one-detail, at-most-one-actions) live in
// parseLayout post-resolution — string-id cells need the pool to know
// their type. badParse() runs the full pipeline so the resolver-level
// check fires.
let _tmpDir = null;
function badParse(layout) {
  if (!_tmpDir) _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-layout-'));
  const p = path.join(_tmpDir, `case-${Math.floor(Math.random() * 1e9)}.yml`);
  fs.writeFileSync(p, yaml.dump(withLayout(layout)));
  let threw = false;
  try { parse(p); } catch { threw = true; }
  assert(threw, 'expected parse to throw');
}

const goodLayout = {
  columns: [
    { panels: ['groups'] },
    { panels: ['actions', 'detail'] },
  ],
};

describe('[1] well-formed layout passes', () => {
  it('accepts one detail, one actions, counts in range', () => ok(goodLayout));
  it('accepts a single-column layout (last-column-only detail)', () => {
    ok({ columns: [{ panels: ['detail'] }] });
  });
});

describe('[2] detail-panel cardinality', () => {
  it('rejects zero detail panels', () => {
    badParse({ columns: [{ panels: ['groups'] }, { panels: ['actions'] }] });
  });
  it('rejects two detail panels', () => {
    badParse({ columns: [{ panels: ['detail'] }, { panels: ['detail'] }] });
  });
});

describe('[3] actions-panel cardinality', () => {
  it('rejects two actions panels', () => {
    badParse({ columns: [{ panels: ['actions', 'actions', 'detail'] }] });
  });
});

describe('[4] panel-count soft caps', () => {
  it('warns on 7 first-column panels (soft cap 6) but accepts', () => {
    const panels = Array.from({ length: 7 }, () => 'groups');
    warns({ columns: [{ panels }, { panels: ['detail'] }] }, 'layout.column_over_soft_cap');
  });
  it('warns on 4 last-column panels (soft cap 3) but accepts', () => {
    warns({ columns: [{ panels: ['groups'] }, { panels: ['detail', 'a', 'b', 'c'] }] }, 'layout.column_over_soft_cap');
  });
  it('accepts exactly 6 first + 3 last with no warning', () => {
    const left = Array.from({ length: 6 }, () => 'groups');
    const warnings = [];
    validate(withLayout({ columns: [{ panels: left }, { panels: ['detail', 'a', 'b'] }] }), 'test', warnings);
    assert(warnings.length === 0, `expected no warnings, got ${JSON.stringify(warnings)}`);
  });
});

describe('[5] cell shape', () => {
  it('rejects a v0.6 inline cell (type at cell level)', () => {
    bad({ columns: [{ panels: [{ type: 'detail' }] }] });
  });
  it("rejects a `tabs:` cell that's not a list", () => {
    bad({ columns: [{ panels: [{ tabs: 'detail' }] }] });
  });
  it("rejects a `tabs:` cell with empty list", () => {
    bad({ columns: [{ panels: [{ tabs: [] }, 'detail'] }] });
  });
  it('rejects a non-list panels block', () => {
    bad({ columns: [{ panels: 'nope' }] });
  });
  it('rejects a non-mapping layout', () => {
    bad(['nope']);
  });
});

describe('[6] width — positive integer or omitted (T3.6)', () => {
  it('rejects width: null (use omission for implicit instead)', () => {
    let err = null;
    try { validate(withLayout({ columns: [{ width: null, panels: ['groups'] }, { panels: ['detail'] }] }), 'test'); }
    catch (e) { err = e; }
    assert(err !== null, 'expected SchemaError');
    assert(/'width' must be a positive integer/.test(err.message),
      `error says width must be positive integer: ${err.message}`);
  });
  it('rejects width: 0', () => {
    bad({ columns: [{ width: 0, panels: ['groups'] }, { panels: ['detail'] }] });
  });
  it('rejects width: -5', () => {
    bad({ columns: [{ width: -5, panels: ['groups'] }, { panels: ['detail'] }] });
  });
  it('rejects width: 3.5', () => {
    bad({ columns: [{ width: 3.5, panels: ['groups'] }, { panels: ['detail'] }] });
  });
  it('accepts width omitted (implicit)', () => {
    ok({ columns: [{ panels: ['groups'] }, { panels: ['detail'] }] });
  });
});

describe('[7] empty-layout error message (T3.7)', () => {
  it('clear error when every column has no panes', () => {
    let err = null;
    try { validate(withLayout({ columns: [{ panels: [] }] }), 'test'); }
    catch (e) { err = e; }
    assert(err !== null, 'expected SchemaError');
    assert(/has no panes/.test(err.message),
      `error names the structural problem: ${err.message}`);
  });
  it('also fires for multiple empty columns', () => {
    let err = null;
    try { validate(withLayout({ columns: [{ panels: [] }, { panels: [] }, { panels: [] }] }), 'test'); }
    catch (e) { err = e; }
    assert(err !== null && /has no panes/.test(err.message));
  });
});

report();
