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
  it('rejects a non-identifier action name that declares ports', () => {
    const msg = errOf(() => validate(baseCfg(pg => {
      pg.actions['bad-name'] = { label: 'b', cmd: 'x', ports: { out: { p: { type: 't' } } } };
    })));
    assert(/identifier/.test(msg), msg);
  });
  it('rejects a bad parse kind', () => {
    const msg = errOf(() => validate(baseCfg(pg => { pg.actions.controldata.parse = { toml: true }; })));
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
});

report();
