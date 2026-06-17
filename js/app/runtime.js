/**
 * app/runtime.js — back-compat shim.
 *
 * The reducer (`update`) moved to `dispatch/update/reducer.js` and the model
 * accessors (`init`/`getModel`/`setModel`) live in `model/store.js` (F3 — see
 * docs/reducer-cleanup-relocation.md). Production code imports those homes
 * directly; this shim preserves the historical `require('app/runtime')`
 * surface so existing tests (and any external callers) keep working without a
 * mass repoint. No logic lives here — it only re-exports.
 */
'use strict';

module.exports = require('../dispatch/update/reducer');
