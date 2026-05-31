/**
 * Hotkey pools for layout panels — single source of truth.
 *
 * Used by the parser (auto-assignment at config load), the layout
 * reducer (rekey-on-mutate after pool_hide / pool_show), and the
 * runtime synthesis path in app/state.js (legacy default layout).
 * Pre-v0.6.x these arrays were redeclared in three places, drifting
 * the next time someone touched one of them.
 *
 * Zero deps — pure data.
 */
'use strict';

const LEFT_HOTKEY_POOL  = ['1', '2', '3', '4', '5', '6'];
const RIGHT_HOTKEY_POOL = ['7', '8', '9'];

module.exports = { LEFT_HOTKEY_POOL, RIGHT_HOTKEY_POOL };
