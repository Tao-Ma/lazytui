/**
 * Fabric schema — action `parse`/`ports` + group `wires` validation and
 * parser passthrough. See docs/ports-and-wires.md, decisions 1/3/4.
 * Run: node js/test/test-fabric-schema.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const { validate } = require('../parser/schema');
const { parse } = require('../parser');

// A minimal valid config with a producer (controldata) + consumer (xlogminer).
function baseCfg(mut) {
  const c = {
    groups: {
      pg: {
        label: 'pg',
        actions: {
          controldata: {
            label: 'cd', cmd: 'pg_controldata',
            parse: { kv: { sep: ':' } },
            ports: { out: { redo_lsn: { type: 'pg.lsn', from: "REDO" } } },
          },
          xlogminer: {
            label: 'xm', cmd: 'xlogminer',
            ports: { in: { start_lsn: { type: 'pg.lsn', required: true } },
                     out: { records: { type: 'pg.wal' } } },
          },
        },
      },
    },
  };
  if (mut) mut(c.groups.pg);
  return c;
}
const A = (c) => c.groups.pg.actions;
function throws(fn) { try { fn(); return false; } catch { return true; } }
function errOf(fn) { try { fn(); return ''; } catch (e) { return e.message; } }

describe('[fabric-schema] valid declarations pass', () => {
  it('accepts parse + ports', () => { validate(baseCfg()); });
  it('accepts a well-typed wire', () => {
    validate(baseCfg(pg => { pg.wires = [{ from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn' }]; }));
  });
  it('accepts a per-port extract (no parse needed)', () => {
    validate(baseCfg(pg => {
      A({ groups: { pg } }).controldata.ports.out.redo_lsn = { type: 'pg.lsn', extract: { regex: '(\\S+)' } };
    }));
  });
  it('accepts a fields regex-table parse (P1.5)', () => {
    validate(baseCfg(pg => {
      pg.actions.controldata.parse = { fields: { redo_lsn: { regex: 'REDO:\\s*(\\S+)' } } };
    }));
  });
});

describe('[fabric-schema] ports validation', () => {
  it('rejects a port without a type', () => {
    assert(throws(() => validate(baseCfg(pg => { delete pg.actions.controldata.ports.out.redo_lsn.type; }))));
  });
  it('rejects from + extract together', () => {
    const msg = errOf(() => validate(baseCfg(pg => {
      pg.actions.controldata.ports.out.redo_lsn.extract = { regex: '(x)' };
    })));
    assert(/from.*OR.*extract/i.test(msg), msg);
  });
  it('rejects an unknown ports direction', () => {
    assert(throws(() => validate(baseCfg(pg => { pg.actions.controldata.ports.sideways = {}; }))));
  });
  it('rejects from/extract on an input port', () => {
    assert(throws(() => validate(baseCfg(pg => { pg.actions.xlogminer.ports.in.start_lsn.from = 'x'; }))));
  });

  // S1 / S2 from slice-1 pre-release review round 4 Fork 1 — WARN at load,
  // runtime guard provides the actual defense. Downgraded from throw-at-load
  // to warn-and-keep per round 5 backward-compat review: a pre-existing YAML
  // that quietly declared a shadow-prone port name must not have its whole
  // load fail on upgrade.
  it('S1 — WARNS (not throws) when a port name would shadow a security-sensitive env var', () => {
    const w = [];
    let threw = null;
    try {
      validate(baseCfg(pg => {
        pg.actions.xlogminer.ports.in.PATH = { type: 'string', required: true };
      }), undefined, w);
    } catch (e) { threw = e; }
    assert(threw == null, `S1 must not throw on upgrade, got: ${threw && threw.message}`);
    assert(w.some((x) => x.code === 'port.env_shadow' && /PATH/.test(x.message)),
      `expected a port.env_shadow warning naming PATH, got: ${JSON.stringify(w)}`);
  });
  it('S1 — WARNS on a BASH_FUNC_<x> port name (shellshock-class export)', () => {
    const w = [];
    validate(baseCfg(pg => {
      pg.actions.xlogminer.ports.in.BASH_FUNC_x = { type: 'string', required: true };
    }), undefined, w);
    assert(w.some((x) => x.code === 'port.env_shadow' && /BASH_FUNC_x/.test(x.message)),
      `expected a port.env_shadow warning naming BASH_FUNC_x, got: ${JSON.stringify(w)}`);
  });
  it('S1 — permits a lowercase port name that happens to spell `path` (NO warning)', () => {
    const w = [];
    let threw = null;
    try {
      validate(baseCfg(pg => {
        pg.actions.xlogminer.ports.in.path = { type: 'string', required: true };
      }), undefined, w);
    } catch (e) { threw = e; }
    assert(threw == null, `lowercase "path" is NOT in the denylist — should load, got: ${threw && threw.message}`);
    assert(!w.some((x) => x.code === 'port.env_shadow'),
      `lowercase path should NOT produce a shadow warning, got: ${JSON.stringify(w)}`);
  });
  it('S2 — WARNS (not throws) and DROPS a non-primitive `default` (array)', () => {
    const w = [];
    const cfg = baseCfg(pg => {
      pg.actions.xlogminer.ports.in.start_lsn.default = [1, 2, 3];
    });
    validate(cfg, undefined, w);
    assert(w.some((x) => x.code === 'port.bad_default_type' && /array/.test(x.message)),
      `expected a port.bad_default_type warning naming "array", got: ${JSON.stringify(w)}`);
    // The bad default must be stripped so action-runner never String()s it.
    assert(!('default' in cfg.groups.pg.actions.xlogminer.ports.in.start_lsn),
      'bad default dropped from the schema in-place');
  });
  it('S2 — WARNS and DROPS a non-primitive `default` (object)', () => {
    const w = [];
    const cfg = baseCfg(pg => {
      pg.actions.xlogminer.ports.in.start_lsn.default = { k: 'v' };
    });
    validate(cfg, undefined, w);
    assert(w.some((x) => x.code === 'port.bad_default_type' && /object/.test(x.message)),
      `expected a port.bad_default_type warning naming "object", got: ${JSON.stringify(w)}`);
    assert(!('default' in cfg.groups.pg.actions.xlogminer.ports.in.start_lsn),
      'bad object default dropped from the schema in-place');
  });
  it('S2 — accepts a numeric OR boolean `default` (no warning)', () => {
    const w = [];
    let threw = null;
    try {
      validate(baseCfg(pg => {
        pg.actions.xlogminer.ports.in.start_lsn.default = 22;        // number OK
      }), undefined, w);
    } catch (e) { threw = e; }
    assert(threw == null, `numeric default should load, got: ${threw && threw.message}`);
    threw = null;
    try {
      validate(baseCfg(pg => {
        pg.actions.xlogminer.ports.in.verbose = { type: 'string', required: false, default: false };
      }), undefined, w);
    } catch (e) { threw = e; }
    assert(threw == null, `boolean default should load, got: ${threw && threw.message}`);
    assert(!w.some((x) => x.code === 'port.bad_default_type'),
      'no bad-default warning for primitives');
  });
  it('rejects an action name that would collide with the `.` address separator', () => {
    // Post-v0.6.31: hyphens in action names are OK (component-name rule relaxed
    // for configs like `ddns-ping` + ports.in; see test-hyphenated-action-ports.js).
    // Dots still break `parseFabricAddr`'s `component.port` split, so names with
    // dots must still be rejected when the action declares ports.
    const msg = errOf(() => validate(baseCfg(pg => {
      pg.actions['bad.name'] = { label: 'b', cmd: 'x', ports: { out: { p: { type: 't' } } } };
    })));
    assert(/\[A-Za-z_\]\[A-Za-z0-9_-\]\*/.test(msg) || /identifier/.test(msg), msg);
  });

  it('accepts a HYPHENATED action name that declares ports (post-v0.6.31)', () => {
    // Was a regression after v0.6.30 retired `args:` — hyphenated action names
    // couldn't easily get an interactive popup without renaming. Component-name
    // rule was relaxed to [A-Za-z_][A-Za-z0-9_-]*; port names stay strict.
    let threw = null;
    try {
      validate(baseCfg(pg => {
        pg.actions['rotate-host-keys'] = { label: 'r', cmd: 'echo', ports: {
          in: { host: { type: 'string', required: true } },
        } };
      }));
    } catch (e) { threw = e; }
    assert(threw == null, `hyphenated action with ports should parse, got: ${threw && threw.message}`);
  });
  it('rejects a bad parse kind', () => {
    const msg = errOf(() => validate(baseCfg(pg => { pg.actions.controldata.parse = { toml: true }; })));
    assert(/invalid 'parse'/.test(msg), msg);
  });
  it('rejects a fields table with a bad regex (load-time)', () => {
    const msg = errOf(() => validate(baseCfg(pg => { pg.actions.controldata.parse = { fields: { x: { regex: '(' } } }; })));
    assert(/invalid 'parse'/.test(msg), msg);
  });
});

describe('[fabric-schema] wires validation', () => {
  it('rejects a type mismatch', () => {
    const msg = errOf(() => validate(baseCfg(pg => {
      pg.actions.xlogminer.ports.in.start_lsn.type = 'pg.other';
      pg.wires = [{ from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn' }];
    })));
    assert(/type mismatch/.test(msg), msg);
  });
  it('rejects an unknown output endpoint', () => {
    const msg = errOf(() => validate(baseCfg(pg => {
      pg.wires = [{ from: 'controldata.nope', to: 'xlogminer.start_lsn' }];
    })));
    assert(/no such output port/.test(msg), msg);
  });
  it('rejects a wrong-direction endpoint (to an output)', () => {
    const msg = errOf(() => validate(baseCfg(pg => {
      pg.wires = [{ from: 'controldata.redo_lsn', to: 'xlogminer.records' }];
    })));
    assert(/no such input port/.test(msg), msg);
  });
  it('rejects cross-group addressing (deferred)', () => {
    assert(throws(() => validate(baseCfg(pg => {
      pg.wires = [{ from: 'pg.controldata.redo_lsn', to: 'xlogminer.start_lsn' }];
    }))));
  });
});

describe('[fabric-schema] run: (decision A)', () => {
  it('accepts a list-form run with holes matching input ports', () => {
    validate(baseCfg(pg => {
      pg.actions.xlogminer.run = ['xlogminer', '--start', '{{start_lsn}}'];
      delete pg.actions.xlogminer.cmd;
    }));
  });
  it('accepts a producer run with no holes', () => {
    validate(baseCfg(pg => { pg.actions.controldata.run = ['pg_controldata']; delete pg.actions.controldata.cmd; }));
  });
  it('rejects run combined with cmd', () => {
    const msg = errOf(() => validate(baseCfg(pg => { pg.actions.xlogminer.run = ['x']; })));
    assert(/cannot combine with 'cmd'/.test(msg), msg);
  });
  it('rejects a hole with no matching input port', () => {
    const msg = errOf(() => validate(baseCfg(pg => {
      pg.actions.xlogminer.run = ['xlogminer', '{{nope}}'];
      delete pg.actions.xlogminer.cmd;
    })));
    assert(/no input port 'nope' is declared/.test(msg), msg);
  });
  it('rejects an empty run list', () => {
    assert(throws(() => validate(baseCfg(pg => { pg.actions.xlogminer.run = []; delete pg.actions.xlogminer.cmd; }))));
  });
});

describe('[fabric-schema] parser passthrough', () => {
  it('preserves action ports/parse + group wires through parse()', () => {
    const yaml = [
      'groups:',
      '  pg:',
      '    label: pg',
      '    actions:',
      '      controldata:',
      '        label: cd',
      '        cmd: pg_controldata',
      '        parse: { kv: { sep: ":" } }',
      '        ports:',
      '          out:',
      '            redo_lsn: { type: pg.lsn, from: "REDO" }',
      '      xlogminer:',
      '        label: xm',
      '        cmd: xlogminer',
      '        ports:',
      '          in:',
      '            start_lsn: { type: pg.lsn, required: true }',
      '    wires:',
      '      - { from: controldata.redo_lsn, to: xlogminer.start_lsn }',
      '',
    ].join('\n');
    const tmp = path.join(os.tmpdir(), `lazytui-fabric-${process.pid}.yml`);
    fs.writeFileSync(tmp, yaml);
    let cfg;
    try { cfg = parse(tmp); } finally { fs.unlinkSync(tmp); }
    const cd = cfg.groups['pg'].actions.controldata;
    eq(cd.ports.out.redo_lsn.type, 'pg.lsn', 'ports survive parse');
    eq(cd.parse.kv.sep, ':', 'parse spec survives');
    eq(cfg.groups['pg'].wires.length, 1, 'wires pass through the group');
    eq(cfg.groups['pg'].wires[0].to, 'xlogminer.start_lsn');
  });

  it('run: elements resolve $VAR but are NOT subject to @use helper expansion (#6)', () => {
    // A `run:` element is a verbatim argv literal: `$VAR` resolves statically,
    // but an element that reads `@use helper` must pass through unchanged — the
    // pre-fix code ran it through the shell-script helper pass, which threw
    // "undefined helper 'helper'" at parse time.
    const yaml = [
      'vars: { REGION: us-1 }',
      'groups:',
      '  g:',
      '    label: g',
      '    actions:',
      '      tool:',
      '        label: t',
      '        run: [ mytool, "--region=$REGION", "@use helper" ]',
      '',
    ].join('\n');
    const tmp = path.join(os.tmpdir(), `lazytui-fabric-run-${process.pid}.yml`);
    fs.writeFileSync(tmp, yaml);
    let cfg;
    try { cfg = parse(tmp); } finally { fs.unlinkSync(tmp); }
    const run = cfg.groups['g'].actions.tool.run;
    eq(run[0], 'mytool');
    eq(run[1], '--region=us-1', '$VAR resolves per element');
    eq(run[2], '@use helper', 'an @use-looking argv literal is preserved verbatim (no helper expansion)');
  });
});

// args→ports slice 2 — `choices_fn:` + `depends_on:` validation. Both are
// warn-drop (not throw) per [[feedback_backcompat_on_new_validations]].

describe('[fabric-schema] slice-2 choices_fn + depends_on', () => {
  function cfgWith(section) {
    return baseCfg(pg => {
      pg.actions['edit-section'] = {
        label: 'edit', cmd: 'edit', ports: { in: {
          file:    { type: 'path',   required: true },
          section: Object.assign({ type: 'string', required: true }, section),
        } },
      };
    });
  }

  it('accepts a well-formed `choices_fn: component.fnName` + `depends_on: [file]`', () => {
    const w = [];
    const cfg = cfgWith({ choices_fn: 'edit.sections_of', depends_on: ['file'] });
    let threw = null;
    try { validate(cfg, undefined, w); } catch (e) { threw = e; }
    assert(threw == null, `well-formed slice-2 keys should pass, got: ${threw && threw.message}`);
    eq(cfg.groups.pg.actions['edit-section'].ports.in.section.choices_fn, 'edit.sections_of');
    eq(cfg.groups.pg.actions['edit-section'].ports.in.section.depends_on, ['file']);
    assert(!w.some((x) => x.code && x.code.startsWith('port.')),
      `no port.* warnings expected, got: ${JSON.stringify(w)}`);
  });

  it('WARNS + DROPS a malformed `choices_fn` (no dot)', () => {
    const w = [];
    const cfg = cfgWith({ choices_fn: 'nodot' });
    validate(cfg, undefined, w);
    assert(w.some((x) => x.code === 'port.bad_choices_fn' && /nodot/.test(x.message)),
      `expected a port.bad_choices_fn warning, got: ${JSON.stringify(w)}`);
    assert(!('choices_fn' in cfg.groups.pg.actions['edit-section'].ports.in.section),
      'bad choices_fn dropped from the schema');
  });

  it('WARNS + DROPS a non-string `choices_fn`', () => {
    const w = [];
    const cfg = cfgWith({ choices_fn: 42 });
    validate(cfg, undefined, w);
    assert(w.some((x) => x.code === 'port.bad_choices_fn'),
      `expected a port.bad_choices_fn warning, got: ${JSON.stringify(w)}`);
    assert(!('choices_fn' in cfg.groups.pg.actions['edit-section'].ports.in.section));
  });

  it('WARNS + DROPS a non-array `depends_on`', () => {
    const w = [];
    const cfg = cfgWith({ depends_on: 'file' });   // should be ['file']
    validate(cfg, undefined, w);
    assert(w.some((x) => x.code === 'port.bad_depends_on'),
      `expected a port.bad_depends_on warning, got: ${JSON.stringify(w)}`);
    assert(!('depends_on' in cfg.groups.pg.actions['edit-section'].ports.in.section));
  });

  it('WARNS + DROPS a `depends_on` entry that references an unknown port', () => {
    const w = [];
    const cfg = cfgWith({ depends_on: ['file', 'ghost'] });
    validate(cfg, undefined, w);
    assert(w.some((x) => x.code === 'port.unknown_depends_on' && /ghost/.test(x.message)),
      `expected a port.unknown_depends_on warning naming 'ghost', got: ${JSON.stringify(w)}`);
    eq(cfg.groups.pg.actions['edit-section'].ports.in.section.depends_on, ['file'],
      'kept entries survive; unknown entry dropped');
  });

  it('WARNS + DROPS a `depends_on` entry that references the port itself', () => {
    const w = [];
    const cfg = cfgWith({ depends_on: ['section'] });   // self-reference
    validate(cfg, undefined, w);
    assert(w.some((x) => x.code === 'port.self_depends'),
      `expected a port.self_depends warning, got: ${JSON.stringify(w)}`);
    eq(cfg.groups.pg.actions['edit-section'].ports.in.section.depends_on, [],
      'self-reference dropped');
  });

  it('WARNS + DROPS a non-string `depends_on` entry', () => {
    const w = [];
    const cfg = cfgWith({ depends_on: ['file', 42] });
    validate(cfg, undefined, w);
    assert(w.some((x) => x.code === 'port.bad_depends_on_entry'),
      `expected a port.bad_depends_on_entry warning, got: ${JSON.stringify(w)}`);
    eq(cfg.groups.pg.actions['edit-section'].ports.in.section.depends_on, ['file']);
  });

  it('R1B-SMELL2 — WARNS + DROPS a `choices_fn` naming a reserved identifier', () => {
    for (const ref of ['__proto__.foo', 'edit.constructor', 'prototype.list', 'constructor.x']) {
      const w = [];
      const cfg = cfgWith({ choices_fn: ref });
      validate(cfg, undefined, w);
      assert(w.some((x) => x.code === 'port.reserved_choices_fn'),
        `expected port.reserved_choices_fn for ${JSON.stringify(ref)}, got: ${JSON.stringify(w)}`);
      assert(!('choices_fn' in cfg.groups.pg.actions['edit-section'].ports.in.section),
        `reserved choices_fn dropped (${ref})`);
    }
  });

  it('upgrade-safe — a pre-existing config with legacy keys continues to load', () => {
    // No choices_fn, no depends_on, no new rules trigger. Mirrors the round-5
    // backward-compat posture: slice-2 validation must never make a load fail.
    let threw = null;
    try { validate(baseCfg()); } catch (e) { threw = e; }
    assert(threw == null, `legacy config must still load, got: ${threw && threw.message}`);
  });
});

report();
