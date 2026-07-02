/**
 * Port values & discovery — the derived/memoized selectors over a component's
 * output, exercised against an injected fake host (production wiring lands with
 * the action-runner hook). See docs/ports-and-wires.md.
 * Run: node js/test/test-fabric-ports.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { setFabricHost, parsed, portValue, listPorts, listWires } = require('../fabric/ports');

// --- a fake host over fixtures ---------------------------------------------
const CONTROLDATA_LINES = [
  "pg_control version number:            1300",
  "Latest checkpoint's REDO location:    0/1A2B3C0",
  "Latest checkpoint's TimeLineID:       1",
];
const SPECS = {
  controldata: {
    parse: { kv: { sep: ':' } },
    ports: {
      out: {
        redo_lsn: { type: 'pg.lsn', from: "Latest checkpoint's REDO location" },
        // `from` omitted → defaults to the port name (which isn't a kv key here,
        // so it reads undefined — proves the default path).
        timeline: { type: 'pg.tli', from: "Latest checkpoint's TimeLineID" },
        // per-port extract escape hatch (bypasses parse, runs on raw)
        version:  { type: 'pg.ver', extract: { regex: 'version number:\\s*(\\d+)' } },
      },
    },
  },
  xlogminer: {
    ports: {
      in: {
        start_lsn: { type: 'pg.lsn', required: true },
        end_lsn:   { type: 'pg.lsn', required: true },
        timeline:  { type: 'pg.tli', required: false, default: 1 },
      },
      out: { records: { type: 'pg.wal_records' } },
    },
  },
};
const WIRES = [{ from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn' }];

function makeHost(linesByName) {
  return {
    componentLines: (n) => linesByName[n] || null,
    componentSpec: (n) => SPECS[n] || null,
    listComponents: () => Object.keys(SPECS),
    wires: () => WIRES,
  };
}

describe('[fabric] portValue — project via parse+from', () => {
  setFabricHost(makeHost({ controldata: CONTROLDATA_LINES }));
  it('projects a kv field through `from`', () => {
    eq(portValue('controldata', 'redo_lsn'), '0/1A2B3C0');
    eq(portValue('controldata', 'timeline'), '1');
  });
  it('runs the per-port extract escape hatch on raw output', () => {
    eq(portValue('controldata', 'version'), '1300');
  });
  it('unknown component / port → undefined', () => {
    eq(portValue('nope', 'x'), undefined);
    eq(portValue('controldata', 'nope'), undefined);
  });
  it('no output yet → undefined (not a crash)', () => {
    setFabricHost(makeHost({}));            // controldata has no lines
    eq(portValue('controldata', 'redo_lsn'), undefined);
    setFabricHost(makeHost({ controldata: CONTROLDATA_LINES }));
  });
});

describe('[fabric] parsed — memoized on output identity', () => {
  it('returns the same record ref while the lines array is unchanged', () => {
    setFabricHost(makeHost({ controldata: CONTROLDATA_LINES }));
    const a = parsed('controldata');
    const b = parsed('controldata');
    assert(a === b, 'memo hit should return the same record ref');
    eq(a["Latest checkpoint's REDO location"], '0/1A2B3C0');
  });
  it('re-parses when the lines array identity changes (new output)', () => {
    setFabricHost(makeHost({ controldata: CONTROLDATA_LINES }));
    const a = parsed('controldata');
    setFabricHost(makeHost({ controldata: [...CONTROLDATA_LINES, "extra: y"] }));
    const b = parsed('controldata');
    assert(a !== b, 'new lines array → fresh parse');
    eq(b.extra, 'y');
  });
});

describe('[fabric] listPorts / listWires', () => {
  setFabricHost(makeHost({ controldata: CONTROLDATA_LINES }));
  it('enumerates out + in ports with dir/type', () => {
    const ports = listPorts();
    const redo = ports.find(p => p.component === 'controldata' && p.port === 'redo_lsn');
    eq(redo.dir, 'out'); eq(redo.type, 'pg.lsn');
    const start = ports.find(p => p.component === 'xlogminer' && p.port === 'start_lsn');
    eq(start.dir, 'in'); eq(start.required, true);
    const tl = ports.find(p => p.component === 'xlogminer' && p.port === 'timeline');
    eq(tl.required, false, 'required:false honored');
  });
  it('returns the wire list', () => {
    eq(listWires().length, 1);
    eq(listWires()[0].from, 'controldata.redo_lsn');
  });
});

describe('[fabric] host guard', () => {
  it('throws a clear error when the host is not wired', () => {
    setFabricHost(null);
    let msg = '';
    try { portValue('controldata', 'redo_lsn'); } catch (e) { msg = e.message; }
    assert(/host not wired/.test(msg), `expected wiring hint, got: ${msg}`);
  });
});

report();
