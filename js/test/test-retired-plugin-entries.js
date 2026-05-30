'use strict';

// Pins the boot-warning predicate. The `plugins:` block carries two
// distinct features in v0.5: well-formed `{ path: '*.yml' }` entries
// are merged by the parser as config splits and stay supported;
// anything else would have been a runtime Plugin API entry under the
// retired API and gets surfaced by tui.js as a one-line warning.
// retiredPluginEntries returns the names of the latter set.

const { describe, it, eq, assert, report } = require('./test-runner');
const { retiredPluginEntries } = require('../parser/index');

describe('retiredPluginEntries — empty / non-object input', () => {
  it('returns [] for undefined / null / empty / non-mapping', () => {
    eq(retiredPluginEntries(undefined), []);
    eq(retiredPluginEntries(null), []);
    eq(retiredPluginEntries({}), []);
    eq(retiredPluginEntries([]), []);
    eq(retiredPluginEntries('plugins'), []);
  });
});

describe('retiredPluginEntries — config splits stay silent', () => {
  it('ignores entries whose path ends in .yml / .yaml', () => {
    const plugins = {
      image:  { path: 'plugins/image.yml' },
      secret: { path: 'plugins/secret.yaml' },
      nested: { path: '../shared/lib.yml' },
    };
    eq(retiredPluginEntries(plugins), []);
  });
});

describe('retiredPluginEntries — non-splits get reported', () => {
  it('reports entries whose path is not a YAML split', () => {
    const plugins = {
      legacy:  { path: 'plugins/legacy.js' },
      empty:   {},
      missing: { other: 'field' },
    };
    const out = retiredPluginEntries(plugins);
    assert(out.includes('legacy'),  'legacy reported');
    assert(out.includes('empty'),   'empty reported');
    assert(out.includes('missing'), 'missing reported');
    eq(out.length, 3);
  });
});

describe('retiredPluginEntries — mixed case', () => {
  it('only reports the non-split entries', () => {
    const plugins = {
      access:  { path: 'plugins/access.yml' },   // split — silent
      legacy:  { path: 'plugins/legacy.js' },    // retired — flagged
      service: { path: 'plugins/service.yaml' }, // split — silent
    };
    eq(retiredPluginEntries(plugins), ['legacy']);
  });
});

describe('retiredPluginEntries — malformed entries surface as the entry name', () => {
  it('reports null / string / array / non-string path', () => {
    eq(retiredPluginEntries({ broken: null }),        ['broken']);
    eq(retiredPluginEntries({ broken: 'string' }),    ['broken']);
    eq(retiredPluginEntries({ broken: [] }),          ['broken']);
    eq(retiredPluginEntries({ broken: { path: 7 } }), ['broken']);
  });
});

report();
