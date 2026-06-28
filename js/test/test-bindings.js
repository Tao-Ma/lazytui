/**
 * E9 — footer/help key-hint registry (leaves/input/bindings.js).
 *
 * Characterization: `footerFor` must reproduce the EXACT hint strings the
 * hand-typed footer produced before E9 (the contract that lets footer.js read
 * the registry with zero behavior change), across every focus-kind, the four
 * conditional detail variants, the per-panel extras, and the modal-mode tails.
 *
 * Run: node js/test/test-bindings.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const b = require('../leaves/input/bindings');

describe('[E9] focus-kind footers (verbatim parity)', () => {
  it('list / actions / groups match the old hand-typed strings', () => {
    eq(b.footerFor('list'),    ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit');
    eq(b.footerFor('actions'), ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit | Enter run');
    eq(b.footerFor('groups'),  ' ↑↓ select | ←→ panel | / filter | +/_ view | x menu | q quit | Enter actions');
  });
});

describe('[E9] detail footer — the four conditional variants', () => {
  it('non-terminal, single tab, no search', () => {
    eq(b.footerFor('detail', { total: 1, isTerminal: false }),
      ' ←→ panel | +/_ view | x menu | q quit | / search');
  });
  it('non-terminal, multiple tabs', () => {
    eq(b.footerFor('detail', { total: 3, isTerminal: false }),
      ' ←→ panel | ]\\[ tabs | +/_ view | x menu | q quit | / search');
  });
  it('terminal tab, alive', () => {
    eq(b.footerFor('detail', { total: 2, isTerminal: true, dead: false }),
      ' ←→ panel | ]\\[ tabs | +/_ view | x menu | q quit | Enter activate');
  });
  it('terminal tab, dead + ephemeral → x close + Enter restart', () => {
    eq(b.footerFor('detail', { total: 2, isTerminal: true, dead: true, isEphemeral: true }),
      ' ←→ panel | ]\\[ tabs | +/_ view | x close | q quit | Enter restart');
  });
  it('terminal tab, dead but NOT ephemeral → x menu + Enter restart', () => {
    eq(b.footerFor('detail', { total: 1, isTerminal: true, dead: true, isEphemeral: false }),
      ' ←→ panel | +/_ view | x menu | q quit | Enter restart');
  });
});

describe('[E9] modal-mode static tails (live prefix prepended in footer.js)', () => {
  it('copy / menu / prefix / filter / search / terminal', () => {
    eq(b.footerFor('copyMode'),         ' ↑↓ select | Esc cancel | Enter copy');
    eq(b.footerFor('menuOpen'),         ' ↑↓ select | Esc close | Enter run');
    eq(b.footerSegs('prefixMode').join(' | '),       '<key> select | Esc cancel');
    eq(b.footerFor('filterMode'),       ' Esc clear | Enter ok');
    eq(b.footerSegs('detailSearchMode').join(' | '), '↑↓ step | Esc cancel | Enter commit');
    eq(b.footerSegs('terminalMode').join(' | '),     'Ctrl+\\ return to TUI');
  });
});

describe('[E9] unknown context', () => {
  it('an undeclared context yields no hints', () => {
    eq(b.footerFor('nope'), '');
    eq(b.footerSegs('nope'), []);
  });
});

report();
