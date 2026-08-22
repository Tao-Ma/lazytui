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
const { relSpec, componentSpec, _defaultOut, runCli, build } = require('../app/build-binary');

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

describe('[build] componentSpec — absolute → relative, BARE name resolved via project node_modules', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  it('an absolute component path → a relative spec (bundled)', () => {
    const s = componentSpec('/tmp/work', '/root/proj/components/my-panel.js');
    assert(s.startsWith('.') && !path.isAbsolute(s), `relative: ${s}`);
    assert(s.endsWith('components/my-panel.js'), s);
  });
  it('a BARE package name INSTALLED in projectDir → a relative spec into node_modules (bundled)', () => {
    // A bare name can't be left verbatim: Bun resolves it from the temp entry's
    // dir (no node_modules there). componentSpec resolves it against the PROJECT
    // and returns a bundle-able relative path. `js-yaml` is a real dependency.
    const s = componentSpec('/tmp/work', 'js-yaml', repoRoot);
    assert(s.startsWith('..') && !path.isAbsolute(s), `relative: ${s}`);
    assert(s.includes('node_modules/js-yaml'), s);
  });
  it('a BARE name that is NOT installed → verbatim (Bun surfaces the error)', () => {
    eq(componentSpec('/tmp/work', 'not-a-real-pkg-xyz', repoRoot), 'not-a-real-pkg-xyz');
  });
  it('a BARE name with no projectDir → verbatim (nothing to resolve against)', () => {
    eq(componentSpec('/tmp/work', '@scope/panel'), '@scope/panel');
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
  it('a second positional (extra config) → exit 2, not silently dropped', () => { eq(runCli(['a.yml', 'b.yml']), 2); });
  it('a missing config file → exit 1 (config not found)', () => {
    eq(build('/no/such/config-xyz.yml'), 1);
    eq(runCli(['/no/such/config-xyz.yml']), 1);
  });
});

report();
