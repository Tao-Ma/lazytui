/**
 * test-overlay-dims.js — blessed-exceptions Finding B (overlay model-clock).
 *
 * The footer + overlays resolve terminal size from the MODEL clock
 * (`layoutSlice.dims`, resize-as-Msg) via `render/panel.viewportDims()`,
 * NOT the `io/term` singleton. So refreshing `io/term` WITHOUT dispatching
 * `term_resized` must NOT change what overlays/footer paint against — only
 * the Msg moves the clock. `io/term` survives only as a boot fallback.
 *
 * Run: node js/test/test-overlay-dims.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getInstanceSlice, setInstanceSlice } = require('../panel/api');
const { viewportDims } = require('../render/panel');
const term = require('../io/term');

describe('[1] viewportDims reads the model clock, not the io/term singleton', () => {
  it('returns layoutSlice.dims after a resize Msg', () => {
    sm.bootFresh();
    sm.resize(100, 30);
    eq(viewportDims().cols, 100, 'cols from the model');
    eq(viewportDims().rows, 30, 'rows from the model');
  });

  it('io/term refresh WITHOUT term_resized does NOT move viewportDims (teeth)', () => {
    sm.bootFresh();
    sm.resize(100, 30);              // model + io/term both 100x30
    process.stdout.columns = 220;
    process.stdout.rows = 60;
    term.refreshSize();             // io/term now 220x60; model still 100x30
    eq(term.cols(), 220, 'io/term singleton advanced');
    eq(viewportDims().cols, 100, 'viewportDims stays on the model clock');
    eq(viewportDims().rows, 30, 'viewportDims stays on the model clock');
  });

  it('the term_resized Msg moves the clock', () => {
    sm.bootFresh();
    sm.resize(100, 30);
    sm.resize(220, 60);
    eq(viewportDims().cols, 220, 'model moved with the Msg');
    eq(viewportDims().rows, 60, 'model moved with the Msg');
  });
});

describe('[2] io/term fallback only when the model clock is absent', () => {
  it('zero/missing layoutSlice.dims falls back to io/term', () => {
    sm.bootFresh();
    process.stdout.columns = 144;
    process.stdout.rows = 50;
    term.refreshSize();
    const ls = getInstanceSlice('layout');
    setInstanceSlice('layout', { ...ls, dims: { cols: 0, rows: 0 } });
    eq(viewportDims().cols, 144, 'falls back to io/term cols');
    eq(viewportDims().rows, 50, 'falls back to io/term rows');
  });
});

report();
