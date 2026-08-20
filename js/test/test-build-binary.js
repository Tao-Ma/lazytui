/**
 * `lazytui build` codegen — the pure/deterministic logic (relative-specifier
 * generation, default output name, CLI arg parsing, config-not-found). The
 * actual `bun build --compile` invocation needs Bun installed and is verified
 * end-to-end by hand (docs/packaging.md); this suite stays fast + bun-free.
 *
 * Run: node js/test/test-build-binary.js
 */
'use strict';

const path = require('path');
const { describe, it, assert, eq, report } = require('./test-runner');
const { relSpec, _defaultOut, runCli, build } = require('../app/build-binary');

describe('[build] relSpec — bun-bundleable RELATIVE specifiers', () => {
  it('same-dir file → ./name (Bun would treat an absolute path as external)', () => {
    eq(relSpec('/tmp/work', '/tmp/work/config.json'), './config.json');
  });
  it('a file in another tree → a ../ relative path (still bundled)', () => {
    const r = relSpec('/tmp/work', '/root/x/js/app/tui.js');
    assert(r.startsWith('../'), `relative, not absolute: ${r}`);
    assert(r.endsWith('js/app/tui.js'), r);
  });
  it('never returns an absolute path', () => {
    assert(!path.isAbsolute(relSpec('/a/b', '/c/d/e.js')), 'must be relative');
  });
});

describe('[build] _defaultOut — output name from the config basename', () => {
  it('strips .yml / .yaml / .json', () => {
    eq(_defaultOut('/a/b/tui.yml'), 'tui');
    eq(_defaultOut('/a/service.yaml'), 'service');
    eq(_defaultOut('/a/c.json'), 'c');
  });
});

describe('[build] runCli — arg parsing + guards', () => {
  it('no config → usage, exit 2', () => { eq(runCli([]), 2); });
  it('--out with no value → exit 2', () => { eq(runCli(['--out']), 2); });
  it('--target with no value → exit 2', () => { eq(runCli(['--target']), 2); });
  it('unknown flag → exit 2', () => { eq(runCli(['--bogus', 'x.yml']), 2); });
  it('a missing config file → exit 1 (config not found)', () => {
    eq(build('/no/such/config-xyz.yml'), 1);
    eq(runCli(['/no/such/config-xyz.yml']), 1);
  });
});

report();
