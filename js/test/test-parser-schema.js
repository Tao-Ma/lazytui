/**
 * Schema validation. JS port of tests/test_schema.py.
 *
 *   node js/test/test-parser-schema.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { validate } = require('../parser/schema');
const { SchemaError } = require('../parser/errors');
const { describe, it, assert, eq, report } = require('./test-runner');

const FIXTURES = path.resolve(__dirname, 'fixtures');
function loadFixture(name) {
  return yaml.load(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function expectThrow(re, fn, kind = SchemaError) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  assert(threw !== null, 'expected throw');
  if (threw) {
    assert(threw instanceof kind, `is ${kind.name} (got ${threw && threw.constructor && threw.constructor.name})`);
    assert(re.test(threw.message), `error message matches ${re}: ${threw.message}`);
  }
  return threw;
}

describe('valid fixtures pass', () => {
  it('minimal_cmd',  () => { validate(loadFixture('minimal_cmd.yml'),  'minimal_cmd.yml'); assert(true); });
  it('full_cmd',     () => { validate(loadFixture('full_cmd.yml'),     'full_cmd.yml');    assert(true); });
  it('with_vars',    () => { validate(loadFixture('with_vars.yml'),    'with_vars.yml');   assert(true); });
  it('with_helpers', () => { validate(loadFixture('with_helpers.yml'), 'with_helpers.yml');assert(true); });
});

describe('optional fields', () => {
  it('compose is optional', () => {
    const data = loadFixture('full_cmd.yml');
    assert(!('compose' in data.groups.config), 'fixture sanity: config group lacks compose');
    validate(data, 'full_cmd.yml');
    assert(true);
  });
  it('type is optional (defaults handled by parser)', () => {
    validate({ groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } } }, 'test');
    assert(true);
  });
  it('empty containers is OK', () => {
    validate({ groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } } }, 'test');
    assert(true);
  });
  it('containers omitted entirely is OK', () => {
    validate({ groups: { g: { label: 'G', actions: { a: { cmd: 'echo', label: 'A' } } } } }, 'test');
    assert(true);
  });
});

describe('invalid structures rejected', () => {
  it('missing groups',                 () => expectThrow(/'groups' is required/, () => validate(loadFixture('invalid_no_groups.yml'), 'test')));
  it('both cmd and script',            () => expectThrow(/exactly one of 'cmd' or 'script'/, () => validate(loadFixture('invalid_both_cmd_script.yml'), 'test')));
  it('neither cmd nor script',         () => expectThrow(/exactly one of 'cmd' or 'script'/, () => validate(loadFixture('invalid_neither_cmd_script.yml'), 'test')));
  it('bad action type',                () => expectThrow(/'type' must be one of/, () => validate(loadFixture('invalid_bad_type.yml'), 'test')));
  it('missing action label',           () => expectThrow(/'label' is required/, () => validate(loadFixture('invalid_missing_label.yml'), 'test')));
  it('unknown action key',             () => expectThrow(/unknown key.*comand/, () => validate(loadFixture('invalid_unknown_key.yml'), 'test')));
  it('empty groups dict',              () => expectThrow(/non-empty mapping/, () => validate({ groups: {} }, 'test')));
  it('groups not a dict',              () => expectThrow(/non-empty mapping/, () => validate({ groups: 'nope' }, 'test')));
  it('top-level not a mapping',        () => expectThrow(/must be a YAML mapping/, () => validate('not a dict', 'test')));
  it('unknown top key',                () => expectThrow(/unknown key.*bogus/, () => validate({
    groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
    bogus: true,
  }, 'test')));
});

describe('actions/children invariant', () => {
  it('node with neither actions nor children rejected', () => {
    expectThrow(/must have 'actions', 'children', or both/, () =>
      validate({ groups: { g: { label: 'G', containers: [] } } }, 'test'));
  });
  it('actions + children together is allowed (aggregate branch)', () => {
    validate({
      groups: {
        g: {
          label: 'G',
          actions: { up: { cmd: 'echo aggregate', label: 'Up all' } },
          children: { sub: { label: 'Sub', actions: { up: { cmd: 'echo sub', label: 'Up' } } } },
        },
      },
    }, 'test');
    assert(true);
  });
});

describe('context surfaces in errors', () => {
  it('group context', () => {
    expectThrow(/group 'mygrp'/, () => validate({ groups: { mygrp: { label: 'L' } } }, 'test'));
  });
  it('action context', () => {
    expectThrow(/action 'myact'/, () => validate({
      groups: { g: { label: 'L', containers: [], actions: { myact: { cmd: 'echo' } } } },
    }, 'test'));
  });
});

describe('vars / helpers shapes', () => {
  it('vars must be mapping', () => {
    expectThrow(/'vars' must be a mapping/, () => validate({
      vars: 'nope',
      groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
    }, 'test'));
  });
  it('helpers must be mapping', () => {
    expectThrow(/'helpers' must be a mapping/, () => validate({
      helpers: ['bad'],
      groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
    }, 'test'));
  });
});

describe('args / default_cmd', () => {
  it('args string accepted', () => {
    validate({ groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo $1', label: 'A', args: 'name' } } } } }, 'test');
    assert(true);
  });
  it('args optional', () => {
    validate({ groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } } }, 'test');
    assert(true);
  });
  it('args non-string rejected', () => {
    expectThrow(/'args' must be a string/, () => validate({
      groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A', args: 123 } } } },
    }, 'test'));
  });
  it('default_cmd accepted alongside args', () => {
    validate({ groups: { g: { label: 'G', containers: [], actions: { a: {
      cmd: 'echo $1', label: 'A', args: '[host]', default_cmd: 'echo example.com',
    } } } } }, 'test');
    assert(true);
  });
  it('default_cmd non-string rejected', () => {
    expectThrow(/'default_cmd' must be a string/, () => validate({
      groups: { g: { label: 'G', containers: [], actions: { a: {
        cmd: 'echo', label: 'A', args: '[h]', default_cmd: 42,
      } } } },
    }, 'test'));
  });
  it("default_cmd without args rejected", () => {
    expectThrow(/'default_cmd' requires 'args'/, () => validate({
      groups: { g: { label: 'G', containers: [], actions: { a: {
        cmd: 'echo', label: 'A', default_cmd: 'echo x',
      } } } },
    }, 'test'));
  });
});

describe('files.category', () => {
  function withFiles(entries) {
    return {
      groups: { g: { label: 'G', actions: { a: { cmd: 'echo', label: 'A' } } } },
      files: entries,
    };
  }
  it('category accepted (and absent / bare-string entries OK)', () => {
    validate(withFiles([
      { path: 'client/', category: 'secret' },
      { path: 'data/dev9/bashrc', category: 'config' },
      { path: 'data/no-category' },
      'client/bare-string',
    ]), 'test');
    assert(true);
  });
  it('category non-string rejected', () => {
    expectThrow(/'category' must be a string/, () => validate(withFiles([
      { path: 'client/', category: ['secret'] },
    ]), 'test'));
  });
});

report();
