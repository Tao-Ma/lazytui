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

  // S1 / S2 from slice-1 pre-release review round 4 Fork 1 — fail-fast at load.
  it('S1 — rejects an input port name that would shadow a security-sensitive env var', () => {
    const msg = errOf(() => validate(baseCfg(pg => {
      pg.actions.xlogminer.ports.in.PATH = { type: 'string', required: true };
    })));
    assert(/PATH.*shadow/i.test(msg) || /rename/.test(msg), msg);
  });
  it('S1 — rejects a BASH_FUNC_<x> port name (shellshock-class export)', () => {
    const msg = errOf(() => validate(baseCfg(pg => {
      pg.actions.xlogminer.ports.in.BASH_FUNC_x = { type: 'string', required: true };
    })));
    assert(/BASH_FUNC_x.*shadow/i.test(msg), msg);
  });
  it('S1 — permits a lowercase port name that happens to spell `path`', () => {
    let threw = null;
    try {
      validate(baseCfg(pg => {
        pg.actions.xlogminer.ports.in.path = { type: 'string', required: true };
      }));
    } catch (e) { threw = e; }
    assert(threw == null, `lowercase "path" is NOT in the denylist — should load, got: ${threw && threw.message}`);
  });
  it('S2 — rejects a non-primitive `default` (array / object)', () => {
    const msgArr = errOf(() => validate(baseCfg(pg => {
      pg.actions.xlogminer.ports.in.start_lsn.default = [1, 2, 3];
    })));
    assert(/default.*(string|number|boolean|array)/i.test(msgArr), msgArr);
    const msgObj = errOf(() => validate(baseCfg(pg => {
      pg.actions.xlogminer.ports.in.start_lsn.default = { k: 'v' };
    })));
    assert(/default.*(string|number|boolean|object)/i.test(msgObj), msgObj);
  });
  it('S2 — accepts a numeric OR boolean `default`', () => {
    let threw = null;
    try {
      validate(baseCfg(pg => {
        pg.actions.xlogminer.ports.in.start_lsn.default = 22;        // number OK
      }));
    } catch (e) { threw = e; }
    assert(threw == null, `numeric default should load, got: ${threw && threw.message}`);
    threw = null;
    try {
      validate(baseCfg(pg => {
        pg.actions.xlogminer.ports.in.verbose = { type: 'string', required: false, default: false };
      }));
    } catch (e) { threw = e; }
    assert(threw == null, `boolean default should load, got: ${threw && threw.message}`);
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

report();
