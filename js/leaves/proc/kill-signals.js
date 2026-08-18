/**
 * Pure leaf — the signal catalog + the kill-picker menu builder.
 *
 * The process table's `Kill` affordance (a killable `table` pane) opens a generic
 * `menu` overlay to pick WHICH signal to send. This leaf owns the two pure facts:
 * the signal list, and the projection of a selected process (rowKey === pid) into
 * the menu's `[label, verb, arg]` rows. The verb is `kill_signal`; its arg carries
 * the FROZEN pid + the chosen signal, so the picked signal runs against the pid
 * that was under the cursor at keypress — a later re-sort of the (positional-cursor)
 * table can't redirect it. Execution lives in the `kill_signal` handleAction verb.
 *
 * SIGTERM leads (menu opens on it) — the graceful default; SIGKILL is the forced
 * fallback for a stuck process.
 *
 * pid guard: a `table` pane is generic (any hub topic), so `killable: true` only
 * makes sense where rowKey is a pid. `buildKillMenu` returns `[]` for a rowKey that
 * isn't an integer > 1 — a mis-declared `killable` on a non-pid topic, or pid 0/1
 * (init) / garbage, yields NO menu rather than a `kill -TERM <garbage>`. pid 1 is
 * excluded deliberately: click-to-signal init is almost always a mistake.
 */
'use strict';

// name → number. Order IS the menu order (SIGTERM first = the safe default the
// picker opens on). A pragmatic btop-style subset, not the full signal table.
const SIGNALS = [
  ['TERM', 15],   // graceful terminate (default)
  ['KILL', 9],    // forced, uncatchable
  ['INT', 2],     // interrupt (Ctrl-C)
  ['HUP', 1],     // hangup / reload
  ['QUIT', 3],    // quit + core dump
  ['STOP', 19],   // suspend (uncatchable)
  ['CONT', 18],   // resume
  ['USR1', 10],   // user-defined 1
  ['USR2', 12],   // user-defined 2
];

/** Is `rowKey` a plausible pid to signal? Integer > 1 (excludes init + garbage). */
function isSignalablePid(rowKey) {
  const n = Number(rowKey);
  return Number.isInteger(n) && n > 1;
}

/**
 * Pure-data menu rows for the kill picker: `[label, 'kill_signal', {pid, sig}]`
 * per signal (`menu_open` items shape). Empty when `rowKey` isn't a signalable
 * pid — the caller treats an empty list as "no action" (the key isn't claimed).
 */
function buildKillMenu(rowKey) {
  if (!isSignalablePid(rowKey)) return [];
  const pid = Number(rowKey);
  return SIGNALS.map(([sig, num]) => [`SIG${sig} (${num})`, 'kill_signal', { pid, sig }]);
}

/**
 * The action descriptor for a picked `{pid, sig}` (a kill-menu row's arg) — the
 * `runAction` inputs the `kill_signal` verb wraps. Returns null for an unsignalable
 * pid. Injection-proof by construction: `sig` is WHITELISTED against the catalog
 * (unknown → TERM) and `pid` is a guarded integer, so neither can smuggle shell
 * metacharacters into the `kill -<sig> <pid>` command. Pure + colocated with the
 * catalog so the whitelist has ONE home.
 */
function killAction(arg) {
  if (!isSignalablePid(arg && arg.pid)) return null;
  const pid = Number(arg.pid);
  const sig = SIGNALS.some(([s]) => s === arg.sig) ? arg.sig : 'TERM';
  const cmd = `kill -${sig} ${pid}`;
  return { actionKey: `kill-${sig}-${pid}`, action: { type: 'run', script: cmd, label: cmd } };
}

module.exports = { SIGNALS, isSignalablePid, buildKillMenu, killAction };
