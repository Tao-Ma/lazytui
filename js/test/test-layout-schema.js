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
  left:  { panels: ['groups'] },
  right: { panels: ['actions', 'detail'] },
};

describe('[1] well-formed layout passes', () => {
  it('accepts one detail, one actions, counts in range', () => ok(goodLayout));
  it('accepts a layout with no left block (right-only detail)', () => {
    ok({ right: { panels: ['detail'] } });
  });
});

describe('[2] detail-panel cardinality', () => {
  it('rejects zero detail panels', () => {
    badParse({ left: { panels: ['groups'] }, right: { panels: ['actions'] } });
  });
  it('rejects two detail panels', () => {
    badParse({ left: { panels: ['detail'] }, right: { panels: ['detail'] } });
  });
});

describe('[3] actions-panel cardinality', () => {
  it('rejects two actions panels', () => {
    badParse({ right: { panels: ['actions', 'actions', 'detail'] } });
  });
});

describe('[4] panel-count maxima', () => {
  it('rejects 7 left panels', () => {
    const panels = Array.from({ length: 7 }, () => 'groups');
    bad({ left: { panels }, right: { panels: ['detail'] } });
  });
  it('rejects 4 right panels', () => {
    bad({ right: { panels: ['detail', 'a', 'b', 'c'] } });
  });
  it('accepts exactly 6 left + 3 right', () => {
    const left = Array.from({ length: 6 }, () => 'groups');
    ok({ left: { panels: left }, right: { panels: ['detail', 'a', 'b'] } });
  });
});

describe('[5] cell shape', () => {
  it('rejects a v0.6 inline cell (type at cell level)', () => {
    bad({ right: { panels: [{ type: 'detail' }] } });
  });
  it("rejects a `tabs:` cell that's not a list", () => {
    bad({ right: { panels: [{ tabs: 'detail' }] } });
  });
  it("rejects a `tabs:` cell with empty list", () => {
    bad({ right: { panels: [{ tabs: [] }, 'detail'] } });
  });
  it('rejects a non-list panels block', () => {
    bad({ right: { panels: 'nope' } });
  });
  it('rejects a non-mapping layout', () => {
    bad(['nope']);
  });
});

report();
