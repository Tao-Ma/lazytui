/**
 * E9 (v0.6.7) — configurable normal-mode keymap: dispatch integration.
 * loadKeymap merge + handleNormalKey resolution + catalog↔thunk sync.
 * Run: node js/test/test-keymap-dispatch.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const dispatch = require('../dispatch/control/dispatch');
const km = require('../leaves/input/keymap');

const cap = (fn) => { const o = process.stdout.write; process.stdout.write = () => true; try { return fn(); } finally { process.stdout.write = o; } };
const capErr = (fn) => { const o = console.error; const c = []; console.error = (...a) => { c.push(a.join(' ')); }; try { fn(); } finally { console.error = o; } return c.join('\n'); };
const _grp = (n) => ({ name: n, label: n, containers: [], actions: { build: { key: 'build', label: 'Build', type: 'run', script: 'echo', tab: false } }, children: [], parent: null, depth: 0, quick: false });
const tableKey = (key) => { const t = dispatch._effectiveNormalTable(); return (t.global.find(e => e.key === key) || {}).spec; };

getModel().config = { project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {}, groups: { g1: _grp('g1') } };
cap(() => initState());

describe('[E9] catalog ↔ thunk sync', () => {
  it('NORMAL_VERBS key-set equals VERB_CATALOG (no drift)', () => {
    eq(dispatch._normalVerbNames().sort(), Object.keys(km.VERB_CATALOG).sort());
  });
});

describe('[E9] reserved set', () => {
  it('reserves the entangled/dynamic keys, frees the remappable ones', () => {
    const r = dispatch._reservedNormalKeys();
    // review round: ' ' (leader), 'T' (pane menu), digits (panel hotkeys) must be reserved.
    for (const k of ['[', ']', '/', 'x', 'v', 'q', '+', '_', ' ', 'T', '0', '7', '9']) assert(r.has(k), `'${k}' reserved`);
    for (const k of ['r', '?', ',', '.', '<', '>', '"', ':', 'y']) assert(!r.has(k), `'${k}' remappable`);
  });
  it('binding the leader / pane-menu / a digit hotkey is rejected (review round)', () => {
    const reserved = dispatch._reservedNormalKeys();
    const legal = new Set(Object.keys(km.VERB_CATALOG));
    for (const k of [' ', 'T', '7']) {
      const { table, errors } = km.mergeUserNormal(km.DEFAULT_NORMAL, { [k]: 'refresh' }, { reservedKeys: reserved, legalVerbs: legal });
      assert(errors.some(e => /reserved/.test(e)), `'${k}' → reserved error`);
      assert(!table.global.some(e => e.key === k), `'${k}' not installed`);
    }
  });
});

describe('[E9] loadKeymap merge + actionable errors', () => {
  it('applies overrides, rejects reserved + unknown verb with messages', () => {
    const errs = capErr(() => dispatch.loadKeymap({ groups: getModel().config.groups, keymap: { version: 1, normal: {
      C: 'cmdline',           // add a free key
      r: 'noop',              // disable a default
      B: { builtin: 'refesh' }, // typo → unknown verb
      '[': 'refresh',         // reserved → rejected
      g: { action: 'build' },   // action target that resolves
    } } }));
    eq(tableKey('C'), { builtin: 'cmdline' }, 'C added');
    eq(tableKey('r'), undefined, 'r disabled via noop');
    eq(tableKey('B'), undefined, 'unknown-verb binding rejected');
    eq(tableKey('['), undefined, 'reserved key rejected');
    eq(tableKey('g'), { action: 'build' }, 'resolvable action kept');
    assert(/unknown verb 'refesh'/.test(errs), 'unknown-verb error logged');
    assert(/'\['.+reserved/.test(errs) || /reserved.+remappable/.test(errs), 'reserved-key error logged');
  });
  it('an action target that does not resolve is flagged', () => {
    const errs = capErr(() => dispatch.loadKeymap({ groups: getModel().config.groups, keymap: { normal: { z: { action: 'nope' } } } }));
    assert(/targets action 'nope'/.test(errs), 'unresolved action flagged');
  });
});

describe('[E9] handleNormalKey resolves through the table', () => {
  it('a rebound free key fires its verb (C → cmdline opens cmdMode)', () => {
    cap(() => dispatch.loadKeymap({ groups: getModel().config.groups, keymap: { normal: { C: 'cmdline' } } }));
    assert(!getModel().modes.cmdMode, 'cmdline closed to start');
    cap(() => dispatch._handleNormalKey('C', 'C'));
    assert(getModel().modes.cmdMode, 'C opened the command line via the keymap');
  });
});

report();
