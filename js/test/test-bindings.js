/**
 * E9 — footer/help key-hint registry (leaves/input/bindings.js).
 *
 * Characterization: `footerFor` must reproduce the EXACT hint strings the
 * hand-typed footer produced before E9 (the contract that lets footer.js read
 * the registry with zero behavior change), across every focus-kind, the detail
 * tab-count variants, the terminal context, and the modal-mode tails.
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

describe('[E9] detail footer — tab count variants', () => {
  it('single tab, no search', () => {
    eq(b.footerFor('detail', { total: 1 }),
      ' ←→ panel | +/_ view | x menu | q quit | / search');
  });
  it('multiple tabs', () => {
    eq(b.footerFor('detail', { total: 3 }),
      ' ←→ panel | ]\\[ tabs | +/_ view | x menu | q quit | / search');
  });
});

// A focused `terminal` pane has its own context (field report 2026-11-14: it
// fell through to the list hints; the terminal variants above it in the viewer
// table were unreachable since terminals became their own pane kind).
describe('terminal footer — dead / closable / typeable', () => {
  // typeable = on screen (an interior) AND a PTY can run (node-pty installed).
  it('alive, typeable → Enter type here', () => {
    eq(b.footerFor('terminal', { dead: false, closable: false, onScreen: true, typeable: true }),
      ' ←→ panel | +/_ view | x menu | q quit | Enter type here');
  });
  it('alive, minimized (no interior) → no Enter hint', () => {
    eq(b.footerFor('terminal', { dead: false, closable: true, onScreen: false, typeable: false }),
      ' ←→ panel | +/_ view | x menu | q quit');
  });
  it('on screen but no PTY can run (node-pty absent) → no Enter hint', () => {
    eq(b.footerFor('terminal', { dead: false, closable: false, onScreen: true, typeable: false }),
      ' ←→ panel | +/_ view | x menu | q quit');
  });
  it('dead, closable → x close + Enter restart', () => {
    eq(b.footerFor('terminal', { dead: true, closable: true, onScreen: true, typeable: true }),
      ' ←→ panel | +/_ view | x close | q quit | Enter restart');
  });
  it('dead, the slot\'s last tab → x menu + Enter restart', () => {
    eq(b.footerFor('terminal', { dead: true, closable: false, onScreen: true, typeable: true }),
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
