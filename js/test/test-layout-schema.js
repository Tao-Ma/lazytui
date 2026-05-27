/**
 * §10 layout-constraint validation (parser/schema.js validateLayout).
 * Previously these invariants were documented only and violations
 * surfaced as render-time crashes; now they fail cleanly at parse.
 *
 * Run: node js/test/test-layout-schema.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const { validate } = require('../parser/schema');

// Minimal valid base; vary `layout`.
function withLayout(layout) {
  return {
    groups: { g: { label: 'G', actions: { x: { cmd: 'true', label: 'X' } } } },
    layout,
  };
}
function ok(layout) { validate(withLayout(layout), 'test'); }           // throws on failure
function bad(layout) {
  let threw = false;
  try { validate(withLayout(layout), 'test'); } catch { threw = true; }
  assert(threw, 'expected a SchemaError');
}

const goodLayout = {
  left:  { panels: [{ type: 'groups' }] },
  right: { panels: [{ type: 'actions' }, { type: 'detail' }] },
};

describe('[1] well-formed layout passes', () => {
  it('accepts one detail, one actions, counts in range', () => ok(goodLayout));
  it('accepts a layout with no left block (right-only detail)', () => {
    ok({ right: { panels: [{ type: 'detail' }] } });
  });
});

describe('[2] detail-panel cardinality', () => {
  it('rejects zero detail panels', () => {
    bad({ left: { panels: [{ type: 'groups' }] }, right: { panels: [{ type: 'actions' }] } });
  });
  it('rejects two detail panels', () => {
    bad({ left: { panels: [{ type: 'detail' }] }, right: { panels: [{ type: 'detail' }] } });
  });
});

describe('[3] actions-panel cardinality', () => {
  it('rejects two actions panels', () => {
    bad({ right: { panels: [{ type: 'actions' }, { type: 'actions' }, { type: 'detail' }] } });
  });
});

describe('[4] panel-count maxima', () => {
  it('rejects 7 left panels', () => {
    const panels = Array.from({ length: 7 }, () => ({ type: 'groups' }));
    bad({ left: { panels }, right: { panels: [{ type: 'detail' }] } });
  });
  it('rejects 4 right panels', () => {
    const panels = [{ type: 'detail' }, { type: 'a' }, { type: 'b' }, { type: 'c' }];
    bad({ right: { panels } });
  });
  it('accepts exactly 6 left + 3 right', () => {
    const left = Array.from({ length: 6 }, () => ({ type: 'groups' }));
    const right = [{ type: 'detail' }, { type: 'a' }, { type: 'b' }];
    ok({ left: { panels: left }, right: { panels: right } });
  });
});

describe('[5] panel shape', () => {
  it('rejects a panel missing type', () => {
    bad({ right: { panels: [{ title: 'no type' }, { type: 'detail' }] } });
  });
  it('rejects a non-string type', () => {
    bad({ right: { panels: [{ type: 5 }, { type: 'detail' }] } });
  });
  it('rejects a non-list panels block', () => {
    bad({ right: { panels: 'nope' } });
  });
  it('rejects a non-mapping layout', () => {
    bad(['nope']);
  });
});

report();
