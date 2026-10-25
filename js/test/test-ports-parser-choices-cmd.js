/**
 * Parser: `choices_cmd:` / `choices_labeled:` / `choices_timeout:` on an
 * input port (args→ports slice 3).
 *
 * Covers (brief §3.5):
 *   - choices_cmd (good) parses with no warning
 *   - choices_cmd (non-string / empty / whitespace-only) → warn + drop
 *   - choices_labeled (non-bool) → warn + drop
 *   - choices_timeout (non-number / ≤0 / float / > MAX_CHOICES_TIMEOUT) → warn + drop
 *   - dangling choices_labeled / choices_timeout (no choices_cmd) → warn + drop
 *   - choices_cmd + choices_fn on same port → HARD parse error (not warn-drop)
 *   - env-shadow port name with choices_cmd → warns (unchanged — shared leaf)
 *
 * Run: node js/test/test-ports-parser-choices-cmd.js
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
function hasWarn(w, code, re) {
  return w.some((x) => x.code === code && (!re || re.test(x.message)));
}

describe('[parser.choices_cmd] good values', () => {
  it('accepts a plain shell one-liner', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_cmd = "docker ps --format '{{.Names}}'"; });
    let threw = null;
    try { validate(cfg, undefined, w); } catch (e) { threw = e; }
    assert(threw == null, `expected no throw, got: ${threw && threw.message}`);
    assert(!w.some((x) => /choices_cmd/.test(x.code || '')), `no choices_cmd warn, got: ${JSON.stringify(w)}`);
    eq(cfg.groups.g.actions.act.ports.in.p.choices_cmd, "docker ps --format '{{.Names}}'");
  });

  it('accepts choices_labeled: true alongside choices_cmd', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_cmd = 'ls'; p.choices_labeled = true; });
    validate(cfg, undefined, w);
    assert(!w.length, `no warnings, got: ${JSON.stringify(w)}`);
    eq(cfg.groups.g.actions.act.ports.in.p.choices_labeled, true);
  });

  it('accepts choices_timeout: integer ms alongside choices_cmd', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_cmd = 'ls'; p.choices_timeout = 2500; });
    validate(cfg, undefined, w);
    assert(!w.length, `no warnings, got: ${JSON.stringify(w)}`);
    eq(cfg.groups.g.actions.act.ports.in.p.choices_timeout, 2500);
  });

  it('accepts choices_cmd + depends_on + required=true (worktree branch shape)', () => {
    // Validates the brief's stretch recipe shape — a dep + an env-bound command.
    const w = [];
    const cfg = baseCfg((p, c) => {
      c.groups.g.actions.act.ports.in.repo = { type: 'string', required: true };
      p.choices_cmd = 'git -C "$repo" branch';
      p.depends_on = ['repo'];
    });
    validate(cfg, undefined, w);
    assert(!w.length, `no warnings, got: ${JSON.stringify(w)}`);
    eq(cfg.groups.g.actions.act.ports.in.p.depends_on, ['repo']);
  });
});

describe('[parser.choices_cmd] malformed values → warn + drop', () => {
  it('non-string choices_cmd → warn + drop', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_cmd = 123; });
    validate(cfg, undefined, w);
    assert(hasWarn(w, 'port.bad_choices_cmd', /non-empty string/),
      `expected port.bad_choices_cmd warning, got: ${JSON.stringify(w)}`);
    assert(!('choices_cmd' in cfg.groups.g.actions.act.ports.in.p), 'key dropped');
  });

  it('empty-string choices_cmd → warn + drop', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_cmd = ''; });
    validate(cfg, undefined, w);
    assert(hasWarn(w, 'port.bad_choices_cmd'), `warn expected, got: ${JSON.stringify(w)}`);
    assert(!('choices_cmd' in cfg.groups.g.actions.act.ports.in.p), 'key dropped');
  });

  it('whitespace-only choices_cmd → warn + drop', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_cmd = '   \n\t '; });
    validate(cfg, undefined, w);
    assert(hasWarn(w, 'port.bad_choices_cmd'), `warn expected, got: ${JSON.stringify(w)}`);
    assert(!('choices_cmd' in cfg.groups.g.actions.act.ports.in.p), 'key dropped');
  });

  it('non-bool choices_labeled → warn + drop (keeps choices_cmd)', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_cmd = 'ls'; p.choices_labeled = 'yes'; });
    validate(cfg, undefined, w);
    assert(hasWarn(w, 'port.bad_choices_labeled', /boolean/),
      `expected port.bad_choices_labeled warning, got: ${JSON.stringify(w)}`);
    assert(!('choices_labeled' in cfg.groups.g.actions.act.ports.in.p), 'labeled dropped');
    assert('choices_cmd' in cfg.groups.g.actions.act.ports.in.p, 'cmd kept');
  });
});

describe('[parser.choices_cmd] timeout bounds', () => {
  function run(t) {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_cmd = 'ls'; p.choices_timeout = t; });
    validate(cfg, undefined, w);
    return { w, p: cfg.groups.g.actions.act.ports.in.p };
  }
  it('zero → warn + drop', () => {
    const r = run(0);
    assert(hasWarn(r.w, 'port.bad_choices_timeout'), `warn expected, got: ${JSON.stringify(r.w)}`);
    assert(!('choices_timeout' in r.p), 'dropped');
  });
  it('negative → warn + drop', () => {
    const r = run(-1000);
    assert(hasWarn(r.w, 'port.bad_choices_timeout'), `warn expected, got: ${JSON.stringify(r.w)}`);
    assert(!('choices_timeout' in r.p), 'dropped');
  });
  it('non-integer (2500.5) → warn + drop', () => {
    const r = run(2500.5);
    assert(hasWarn(r.w, 'port.bad_choices_timeout'), `warn expected, got: ${JSON.stringify(r.w)}`);
    assert(!('choices_timeout' in r.p), 'dropped');
  });
  it('> MAX (60001 ms) → warn + drop', () => {
    const r = run(60001);
    assert(hasWarn(r.w, 'port.bad_choices_timeout'), `warn expected, got: ${JSON.stringify(r.w)}`);
    assert(!('choices_timeout' in r.p), 'dropped');
  });
  it('exactly MAX (60000 ms) → accepted', () => {
    const r = run(60000);
    assert(!r.w.length, `no warnings, got: ${JSON.stringify(r.w)}`);
    eq(r.p.choices_timeout, 60000);
  });
  it('non-number ("fast") → warn + drop', () => {
    const r = run('fast');
    assert(hasWarn(r.w, 'port.bad_choices_timeout'), `warn expected, got: ${JSON.stringify(r.w)}`);
    assert(!('choices_timeout' in r.p), 'dropped');
  });
});

describe('[parser.choices_cmd] dangling modifier keys', () => {
  it('choices_labeled WITHOUT choices_cmd → warn + drop labeled', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_labeled = true; });
    validate(cfg, undefined, w);
    assert(hasWarn(w, 'port.dangling_choices_labeled'),
      `expected port.dangling_choices_labeled, got: ${JSON.stringify(w)}`);
    assert(!('choices_labeled' in cfg.groups.g.actions.act.ports.in.p), 'labeled dropped');
  });

  it('choices_timeout WITHOUT choices_cmd → warn + drop timeout', () => {
    const w = [];
    const cfg = baseCfg((p) => { p.choices_timeout = 5000; });
    validate(cfg, undefined, w);
    assert(hasWarn(w, 'port.dangling_choices_timeout'),
      `expected port.dangling_choices_timeout, got: ${JSON.stringify(w)}`);
    assert(!('choices_timeout' in cfg.groups.g.actions.act.ports.in.p), 'timeout dropped');
  });

  it('choices_labeled WITH choices_fn (no choices_cmd) → warn + drop labeled', () => {
    // choices_labeled / choices_timeout only ever modify choices_cmd. With
    // choices_fn and no choices_cmd they're author-noise.
    const w = [];
    const cfg = baseCfg((p) => { p.choices_fn = 'x.y'; p.choices_labeled = true; });
    validate(cfg, undefined, w);
    assert(hasWarn(w, 'port.dangling_choices_labeled'),
      `expected port.dangling_choices_labeled, got: ${JSON.stringify(w)}`);
    assert(!('choices_labeled' in cfg.groups.g.actions.act.ports.in.p), 'labeled dropped');
    assert('choices_fn' in cfg.groups.g.actions.act.ports.in.p, 'fn kept');
  });
});

describe('[parser.choices_cmd] collision — hard parse error', () => {
  it('choices_cmd + choices_fn on same port → throws (not warn)', () => {
    const w = [];
    const msg = errOf(() => validate(
      baseCfg((p) => { p.choices_cmd = 'ls'; p.choices_fn = 'ns.fn'; }),
      undefined, w,
    ));
    assert(msg !== '', 'expected to throw');
    assert(/choices_cmd.*choices_fn.*pick one/i.test(msg) || /choices_fn.*choices_cmd.*pick one/i.test(msg),
      `error should name both and ask to pick one, got: ${msg}`);
  });
});

describe('[parser.choices_cmd] env-shadow composition (unchanged — shared leaf)', () => {
  it('uppercase port with choices_cmd warns via the SAME env-shadow leaf as choices_fn / script', () => {
    const w = [];
    const cfg = baseCfg((p, c) => {
      // Replace p with a new PATH-named port; the warn should fire on PATH.
      c.groups.g.actions.act.ports.in = {
        PATH: { type: 'string', required: true, choices_cmd: 'echo /usr/bin' },
      };
    });
    validate(cfg, undefined, w);
    assert(hasWarn(w, 'port.env_shadow', /PATH/),
      `expected port.env_shadow for PATH, got: ${JSON.stringify(w)}`);
  });

  it('lowercase port name with choices_cmd does NOT warn (composition is free)', () => {
    const w = [];
    const cfg = baseCfg((p, c) => {
      c.groups.g.actions.act.ports.in = {
        path: { type: 'string', required: true, choices_cmd: 'echo /usr/bin' },
      };
    });
    validate(cfg, undefined, w);
    assert(!w.some((x) => x.code === 'port.env_shadow'),
      `expected NO env_shadow warn for lowercase port, got: ${JSON.stringify(w)}`);
  });
});

report();
