'use strict';
/**
 * Test fixture: a minimal consumer-authored Component, loaded via the config
 * `components:` hook. Exercises the external-registration path
 * (app/external-components.js) — same shape as a built-in.
 */
module.exports = {
  name: 'ext-hello',
  init: () => ({ items: ['ext-a', 'ext-b'] }),
  update: (msg, slice) => slice,
  panelTypes: {
    'ext-hello': {
      render: (panel, w, h, slice) => `EXTPANEL:${panel.title}`,
      getItems: (slice) => slice.items,
      getInfo: (item) => [`item: ${item}`],
    },
  },
};
