/**
 * Static routing check — every Msg type passed to `dispatch.applyMsg`
 * MUST be handled by the root reducer: either an inline `case` in
 * `reducer.update`, OR a type a per-modal sub-reducer declares (the
 * reducer delegates modal Msgs by type — #D12, see dispatch/update/modal/*).
 * The hazard otherwise is silent: a Msg that moved from the root reducer to
 * a Component (Phase B / C migration class) leaves the old call site routing
 * to a dead arm — the reducer falls through to `default`, the Msg vanishes,
 * the feature stops working but no error fires. T29 caught two instances of
 * this (`toggle_group` on Enter-on-branch, `toggle_groups_tab` on `[`/`]`).
 *
 * Run: node js/test/test-msg-routing.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it, assert, report } = require('./test-runner');

const JS_ROOT = path.join(__dirname, '..');

function _readSource(relPath) {
  return fs.readFileSync(path.join(JS_ROOT, relPath), 'utf8');
}

/** Walk every `.js` file under `js/` excluding test/ + scripts/. The check
 *  scans the whole production tree rather than a hardcoded caller list so a
 *  new file adopting applyMsg gets covered automatically — the original
 *  caller list missed `dispatch/runtime/action-runner.js` and `panel/viewer/select.js`. */
function _walkProductionFiles() {
  const out = [];
  const skip = new Set(['test', 'scripts']);
  const stack = [JS_ROOT];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(path.relative(JS_ROOT, full));
      }
    }
  }
  return out;
}

/** Extract every literal Msg type passed to `applyMsg({ type: '...' })` /
 *  `runtime.update({ type: '...' })` style calls in `src`. Returns a Set. */
function _extractAppliedMsgTypes(src) {
  // Match: applyMsg({ type: 'X' ... })  — single-quoted literal types only.
  // Dynamic forms (`applyMsg({ type: var })`) are skipped — they're rare
  // and a static check can't validate them anyway.
  const re = /\bapplyMsg\s*\(\s*\{\s*type:\s*'([a-z_]+)'/g;
  const out = new Set();
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

/** Extract every `case 'X':` in `src`. Returns a Set of Msg type strings. */
function _extractReducerCases(src) {
  const re = /\bcase\s+'([a-z_]+)'\s*:/g;
  const out = new Set();
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

/** The set of Msg types the root reducer HANDLES: inline `case` labels in
 *  reducer.js PLUS every type the per-modal sub-reducers declare (the reducer
 *  delegates these by type — #D12). A modal module exports `{ TYPES, update }`;
 *  TYPES is the authoritative "what this modal handles" contract the reducer's
 *  routing map is built from. */
function _handledRootTypes() {
  const handled = _extractReducerCases(_readSource('dispatch/update/reducer.js'));
  const modalDir = path.join(JS_ROOT, 'dispatch/update/modal');
  for (const entry of fs.readdirSync(modalDir)) {
    if (!entry.endsWith('.js')) continue;
    const mod = require(path.join(modalDir, entry));
    for (const t of (mod.TYPES || [])) handled.add(t);
  }
  return handled;
}

describe('Msg routing — applyMsg targets the root reducer', () => {
  const handledTypes = _handledRootTypes();   // reducer cases ∪ delegated modal TYPES (#D12)
  const productionFiles = _walkProductionFiles();

  it('every Msg type passed to applyMsg is handled by the root reducer (inline case or delegated modal)', () => {
    const offenders = [];
    for (const file of productionFiles) {
      const src = _readSource(file);
      const types = _extractAppliedMsgTypes(src);
      for (const t of types) {
        if (!handledTypes.has(t)) offenders.push(`${file}: applyMsg type:'${t}' has no case in the reducer or a modal sub-reducer`);
      }
    }
    assert(offenders.length === 0,
      offenders.length
        ? `\n  ${offenders.join('\n  ')}\n  (These Msgs probably moved to a Component's update — fix the call site to dispatchMsg(wrap('<comp>', msg)).)`
        : `all applyMsg call sites across ${productionFiles.length} production files route to a real reducer/modal case`);
  });
});

report();
