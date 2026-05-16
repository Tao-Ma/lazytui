/**
 * Decorator framework smoke test — exercises register/decorate/unregister,
 * composition rules, weight-based ordering, multi-plugin fan-out, error
 * isolation, width truncation, and the zero-overhead empty-slot path.
 *
 * Run: node js/test/test-decorators.js
 */
'use strict';

const decorators = require('../decorators');
const { register, unregister, decorate, slots, _reset } = decorators;
const { describe, it, assert, eq, report } = require('./test-runner');

describe('[1] empty slot returns "" without iteration', () => {
  it('no handlers → ""', () => {
    _reset();
    eq(decorate('row:right:containers', { selected: false, width: 30 }), '');
    eq(decorate('footer:right', {}), '', 'untouched slot → ""');
    eq(slots().size, 0, 'registry stays empty');
  });
});

describe('[2] single handler', () => {
  it('handler output returned', () => {
    _reset();
    register('row:right:containers', (ctx) => `cpu:${ctx.cpu}%`, 'plugin-a');
    eq(decorate('row:right:containers', { cpu: 42 }), 'cpu:42%');
    eq(decorate('row:other', { cpu: 42 }), '', 'different slot still empty');
  });
});

describe('[3] composition with slot separator', () => {
  it('footer:left uses powerline " │ " separator', () => {
    _reset();
    register('footer:left', () => 'env:dev', 'plugin-a');
    register('footer:left', () => 'branch:main', 'plugin-b');
    eq(decorate('footer:left', {}), 'env:dev │ branch:main');
  });
  it('row:* uses single space separator', () => {
    _reset();
    register('row:right:containers', () => 'A', 'p1');
    register('row:right:containers', () => 'B', 'p2');
    eq(decorate('row:right:containers', {}), 'A B');
  });
  it('title:* uses ", "', () => {
    _reset();
    register('title:groups', () => '3 active', 'p1');
    register('title:groups', () => 'updated 2s ago', 'p2');
    eq(decorate('title:groups', {}), '3 active, updated 2s ago');
  });
});

describe('[4] weight-based ordering', () => {
  it('sorted by weight ascending', () => {
    _reset();
    register('footer:left', () => ({ text: 'last',  weight: 100 }), 'p1');
    register('footer:left', () => ({ text: 'first', weight: -10 }), 'p2');
    register('footer:left', () => ({ text: 'mid',   weight: 0   }), 'p3');
    eq(decorate('footer:left', {}), 'first │ mid │ last');
  });
});

describe('[5] stable sort preserves registration order on weight tie', () => {
  it('registration order kept on weight tie', () => {
    _reset();
    register('footer:left', () => 'a', 'p1');
    register('footer:left', () => 'b', 'p2');
    register('footer:left', () => 'c', 'p3');
    eq(decorate('footer:left', {}), 'a │ b │ c');
  });
});

describe('[6] footer:right reverses for right alignment', () => {
  it('footer:right reversed after sort', () => {
    _reset();
    register('footer:right', () => ({ text: 'clock', weight: 999 }), 'p1');
    register('footer:right', () => ({ text: 'mode',  weight: 0 }),   'p2');
    // Sort ascending: ['mode', 'clock']. Reverse → 'clock │ mode'. So when
    // rendered, "clock" appears LEFTMOST in the rightmost block — which is
    // correct for right-aligned segments where the highest weight should be
    // the rightmost on screen. Renderer pastes this against the right edge.
    eq(decorate('footer:right', {}), 'clock │ mode');
  });
});

describe('[7] null / "" / undefined dropped from output', () => {
  it('only non-empty results joined', () => {
    _reset();
    register('footer:left', () => 'keep', 'p1');
    register('footer:left', () => null,   'p2');
    register('footer:left', () => '',     'p3');
    register('footer:left', () => undefined, 'p4');
    register('footer:left', () => 'also', 'p5');
    eq(decorate('footer:left', {}), 'keep │ also');
  });
});

describe('[8] error isolation', () => {
  it('good handlers survived; bad one skipped', () => {
    _reset();
    const origErr = console.error;
    let errMsg = '';
    console.error = (msg) => { errMsg = msg; };
    register('row:x', () => 'good', 'plugin-good');
    register('row:x', () => { throw new Error('boom'); }, 'plugin-bad');
    register('row:x', () => 'also-good', 'plugin-good2');
    const result = decorate('row:x', {});
    console.error = origErr;
    eq(result, 'good also-good');
    assert(errMsg.includes('plugin-bad') && errMsg.includes('boom'),
           `error reported with plugin name and message (got "${errMsg}")`);
  });
});

describe('[9] outer truncate at ctx.width boundary', () => {
  it('truncated to ≤10 with ellipsis', () => {
    _reset();
    register('footer:left', () => 'this-is-a-very-long-segment-of-text', 'p1');
    const truncated = decorate('footer:left', { width: 10 });
    assert(truncated.length <= 10, `truncated to ≤10 (got "${truncated}", len ${truncated.length})`);
    assert(truncated.endsWith('…'), 'ellipsis on truncation');
  });
});

describe('[10] unregister removes the handler', () => {
  it('only permanent after unregister', () => {
    _reset();
    const tok = register('footer:left', () => 'temp', 'plugin-temp');
    register('footer:left', () => 'permanent', 'plugin-perm');
    eq(decorate('footer:left', {}), 'temp │ permanent', 'both before unregister');
    unregister(tok);
    eq(decorate('footer:left', {}), 'permanent');
  });
});

describe('[11] slots() introspection', () => {
  it('lists registered slots and their plugins', () => {
    _reset();
    register('row:groups', () => 'x', 'docker');
    register('row:groups', () => 'y', 'sparklines');
    register('footer:right', () => 'z', 'core');
    const map = slots();
    eq([...map.keys()].sort(), ['footer:right', 'row:groups'], 'two slots present');
    eq(map.get('row:groups'), ['docker', 'sparklines'], 'plugin names in order');
  });
});

describe('[12] empty slot is fast (no alloc, no iteration)', () => {
  it('empty-slot call < 500ns', () => {
    _reset();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1_000_000; i++) decorate('row:nobody', { width: 30 });
    const t1 = process.hrtime.bigint();
    const nsPerCall = Number(t1 - t0) / 1_000_000;
    console.log(`  · ~${nsPerCall.toFixed(0)}ns per empty-slot call (1M iterations)`);
    assert(nsPerCall < 500, `empty-slot call < 500ns (got ${nsPerCall.toFixed(0)}ns)`);
  });
});

report();
