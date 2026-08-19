'use strict';
/**
 * Test fixture: a module exporting an ARRAY of Components — external-component
 * loading flattens it (one module may contribute several panel types).
 */
module.exports = [
  { name: 'ext-alpha', init: () => ({}), update: (m, s) => s,
    panelTypes: { 'ext-alpha': { render: () => 'ALPHA' } } },
  { name: 'ext-beta', init: () => ({}), update: (m, s) => s,
    panelTypes: { 'ext-beta': { render: () => 'BETA' } } },
];
