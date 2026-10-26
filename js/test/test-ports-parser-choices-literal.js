/**
 * Parser: literal `choices:` port key (args→ports slice 3+1, Brief 2).
 *
 * Static sibling of choices_cmd/choices_fn. Normalized to
 * `{items:[], labels:[]|null, truncated:bool}` on the pdef so downstream
 * (action-runner, fabric-form reducer, completion.js, cli.js) reads a
 * single shape.
 *
 * Covers:
 *   - scalar items (string / number / boolean coerced to String())
 *   - {value, label} map items (both value-only and value+label)
 *   - mixed (scalars + maps in one list) — labels aligned, no-label slots null
 *   - bad items (null, arrays, non-value objects) → warn, drop just those
 *   - choices + choices_cmd / choices + choices_fn → HARD parse error
 *   - dangling choices_labeled with literal choices → warn + drop
 *     (choices_labeled is only meaningful for cmd-channel stdout parsing)
 *   - dangling depends_on with literal choices → warn + drop
 *     (literal has no fetch, so depends_on can't trigger a refetch)
 *   - non-array `choices` → warn + drop
 *   - cap at 1024 — warn + truncate
 *
 * Run: node js/test/test-ports-parser-choices-literal.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { validate } = require('../parser/schema');

function baseCfg(mut) {
  const c = {
    groups: {
      g: {
        label: 'g',
        actions: {
          act: {
            label: 'A', cmd: 'echo hi',
            ports: { in: { p: { type: 'string', required: true } } },
          },
        },
      },
    },
  };
  if (mut) mut(c.groups.g.actions.act.ports.in.p, c);
  return c;
}

function throws(fn) { try { fn(); return false; } catch { return true; } }
function errOf(fn) { try { fn(); return ''; } catch (e) { return e.message; } }
function hasWarn(w, code) { return w.some((x) => x.code === code); }

describe('[parser.choices] scalar items', () => {
  it('string scalars → items only, labels null', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices = ['nginx', 'sshd', 'postgres']; });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    eq(p.choices.items, ['nginx', 'sshd', 'postgres']);
    eq(p.choices.labels, null, 'all scalars → labels field is null');
    eq(p.choices.truncated, false);
    eq(w.length, 0, 'no warnings on clean scalar list');
  });

  it('number / boolean scalars coerce to strings', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices = [1, 2.5, true, 'kept']; });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    eq(p.choices.items, ['1', '2.5', 'true', 'kept']);
    eq(p.choices.labels, null);
  });
});

describe('[parser.choices] {value, label} map items', () => {
  it('all maps → labels array aligned, every slot a string', () => {
    const w = [];
    const cfg = baseCfg((p) => {
      p.choices = [
        { value: '--full-tunnel',    label: 'all traffic via VPN' },
        { value: '--no-full-tunnel', label: 'split tunnel' },
      ];
    });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    eq(p.choices.items, ['--full-tunnel', '--no-full-tunnel']);
    eq(p.choices.labels, ['all traffic via VPN', 'split tunnel']);
  });

  it('map with value but no label → label slot null, labels array still exists for the LABELED siblings', () => {
    const w = [];
    const cfg = baseCfg((p) => {
      p.choices = [
        { value: 'nginx' },                              // no label
        { value: 'sshd', label: 'SSH daemon' },         // labeled
      ];
    });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    eq(p.choices.items, ['nginx', 'sshd']);
    eq(p.choices.labels, [null, 'SSH daemon'],
      'labels array keeps per-slot nulls where no label was given');
  });

  it('map value coerces number/boolean to String()', () => {
    const w = [];
    const cfg = baseCfg((p) => {
      p.choices = [{ value: 42, label: 'the answer' }, { value: false }];
    });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    eq(p.choices.items, ['42', 'false']);
    eq(p.choices.labels[0], 'the answer');
    eq(p.choices.labels[1], null);
  });
});

describe('[parser.choices] mixed items', () => {
  it('scalars + maps in one list → labels aligned, scalar slots null', () => {
    const w = [];
    const cfg = baseCfg((p) => {
      p.choices = ['bare-scalar', { value: 'mapped', label: 'Mapped Entry' }];
    });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    eq(p.choices.items, ['bare-scalar', 'mapped']);
    eq(p.choices.labels, [null, 'Mapped Entry']);
  });
});

describe('[parser.choices] bad items drop, keep good', () => {
  it('null / array / non-value object → warn + drop just those slots', () => {
    const w = [];
    const cfg = baseCfg((p) => {
      p.choices = [
        'ok1',
        null,                                            // dropped
        { label: 'no-value' },                           // dropped (missing value)
        ['nested', 'array'],                             // dropped
        { value: 'ok2' },
      ];
    });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    eq(p.choices.items, ['ok1', 'ok2']);
    assert(hasWarn(w, 'port.bad_choices_item'),
      `expected port.bad_choices_item warning, got codes: ${JSON.stringify(w.map((x) => x.code))}`);
  });
});

describe('[parser.choices] HARD-error collisions', () => {
  it('choices + choices_cmd → throw', () => {
    const cfg = baseCfg((p) => { p.choices = ['a']; p.choices_cmd = "echo b"; });
    assert(throws(() => validate(cfg, undefined, [])), 'should throw on cmd collision');
    assert(/mutually exclusive/i.test(errOf(() => validate(cfg, undefined, []))),
      `error should name the mutex, got: ${errOf(() => validate(cfg, undefined, []))}`);
  });

  it('choices + choices_fn → throw', () => {
    const cfg = baseCfg((p) => { p.choices = ['a']; p.choices_fn = 'comp.fn'; });
    assert(throws(() => validate(cfg, undefined, [])), 'should throw on fn collision');
    assert(/mutually exclusive/i.test(errOf(() => validate(cfg, undefined, []))),
      `error should name the mutex, got: ${errOf(() => validate(cfg, undefined, []))}`);
  });
});

describe('[parser.choices] dangling modifiers → warn + drop', () => {
  it('choices_labeled alongside literal choices → dangling (labels come from inline maps)', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices = ['a', 'b']; p.choices_labeled = true; });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    assert(hasWarn(w, 'port.dangling_choices_labeled'),
      `expected dangling_choices_labeled, got codes: ${JSON.stringify(w.map((x) => x.code))}`);
    assert(!('choices_labeled' in p), 'choices_labeled should be dropped');
  });

  it('choices_timeout alongside literal choices → dangling', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices = ['a']; p.choices_timeout = 1000; });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    assert(hasWarn(w, 'port.dangling_choices_timeout'),
      `expected dangling_choices_timeout, got codes: ${JSON.stringify(w.map((x) => x.code))}`);
    assert(!('choices_timeout' in p), 'choices_timeout should be dropped');
  });

  it('depends_on alongside literal choices → dangling (literal has no fetch)', () => {
    const w = [];
    const cfg = baseCfg((p, c) => {
      p.choices = ['a'];
      p.depends_on = ['sibling'];
      c.groups.g.actions.act.ports.in.sibling = { type: 'string' };
    });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    assert(hasWarn(w, 'port.dangling_depends_on'),
      `expected dangling_depends_on, got codes: ${JSON.stringify(w.map((x) => x.code))}`);
    assert(!('depends_on' in p), 'depends_on should be dropped');
  });
});

describe('[parser.choices] malformed shape', () => {
  it('non-array choices → warn + drop the whole key', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices = 'not-a-list'; });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    assert(hasWarn(w, 'port.bad_choices'), 'expected port.bad_choices warning');
    assert(!('choices' in p), 'bad choices should be fully dropped');
  });
});

describe('[parser.choices] cap at 1024', () => {
  it('>1024 items → warn + truncate', () => {
    const w = [];
    const big = [];
    for (let i = 0; i < 1500; i++) big.push(`item-${i}`);
    const cfg = baseCfg((p) => { p.choices = big; });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    eq(p.choices.items.length, 1024, 'truncated to 1024');
    eq(p.choices.items[0], 'item-0');
    eq(p.choices.items[1023], 'item-1023');
    eq(p.choices.truncated, true);
    assert(hasWarn(w, 'port.choices_truncated'),
      `expected choices_truncated warning, got codes: ${JSON.stringify(w.map((x) => x.code))}`);
  });
});

describe('[parser.choices] regression — pre-existing channels unaffected', () => {
  it('choices_cmd without `choices:` still parses clean', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_cmd = "printf 'a\\nb\\n'"; });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    eq(p.choices_cmd, "printf 'a\\nb\\n'", 'choices_cmd survived');
    assert(!('choices' in p), 'no literal choices seeded');
    eq(w.length, 0, 'no new warnings on existing cmd-channel configs');
  });

  it('choices_fn without `choices:` still parses clean', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_fn = 'myComp.fn'; });
    validate(cfg, undefined, w);
    const p = cfg.groups.g.actions.act.ports.in.p;
    eq(p.choices_fn, 'myComp.fn', 'choices_fn survived');
    assert(!('choices' in p), 'no literal choices seeded');
  });
});

report();
