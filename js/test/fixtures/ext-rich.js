'use strict';
/**
 * Test fixture: an external Component exercising the RICHER seams beyond a bare
 * panel — a `subscriptions()` (interval), `installEffects` (a Cmd handler), and
 * `viewContributions` (a footer slot). Proves the config-declared external path
 * wires these the same way the built-ins get wired at registerComponent.
 */
module.exports = {
  name: 'ext-rich',
  init: () => ({}),
  update: (m, s) => s,
  subscriptions: () => [{ kind: 'interval', id: 'ext-rich-tick', ms: 5000, onTick: () => {} }],
  installEffects: (registerEffect) => { registerEffect('ext_rich_effect', () => {}); },
  viewContributions: { footerLeft: () => 'EXTFOOTER' },
  panelTypes: { 'ext-rich': { render: () => 'RICHPANEL', getItems: () => ['a'] } },
};
