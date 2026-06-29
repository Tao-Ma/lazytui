/**
 * E9 (v0.6.7) — `--keymap` headless dump. Prints the normal-mode keymap so a
 * config author (usually an AI) can DISCOVER the vocabulary before writing
 * `keymap:` YAML: every verb + a one-line summary, the bindable forms, the
 * reserved keys (and why), the format version, and the EFFECTIVE bindings
 * (defaults ⊕ the given config). The catalog here is the same single source the
 * dispatcher + validation use, so the dump never drifts from what dispatches.
 *
 *   node js/app/tui.js --keymap [config.yml]
 */
'use strict';

const path = require('path');

function runKeymapDump(configPath) {
  const km = require('../leaves/input/keymap');
  const dispatch = require('../dispatch/control/dispatch');
  const out = (s) => process.stdout.write(s + '\n');

  if (configPath) {
    let config;
    try { config = require('../parser').parse(path.resolve(configPath)); }
    catch (e) { process.stderr.write(`keymap: cannot read ${configPath}: ${e.message}\n`); return 1; }
    // checkActions:false — the merged action set (incl. plugin-synth actions)
    // only exists once the app is booted; skip it here so the dump doesn't
    // mis-warn on every `action:` binding.
    dispatch.loadKeymap(config, { checkActions: false });   // build the effective table
  }

  out(`# lazytui keymap — format version ${km.KEYMAP_VERSION}`);
  out('# YAML: keymap: { version: 1, normal: { <key>: <verb> } }');
  out('');
  out('## verbs  (bare value, or {builtin: <verb>})');
  for (const [name, summary] of Object.entries(km.VERB_CATALOG)) {
    out(`  ${name.padEnd(12)} ${summary}`);
  }
  out('');
  out('## other bindable forms');
  out('  { action: <short-key> }   run a configured action (its $1 prompt, etc.)');
  out('  { command: <name> }       run a :cmdline command');
  out('  noop                      disable a default binding (or move: bind new + noop old)');
  out('');
  out('## reserved keys  (claimed by built-in handlers — binding one is an error)');
  out('  ' + [...dispatch._reservedNormalKeys()].sort().join(' '));
  out('');
  out(`## effective normal-mode bindings  (${configPath || 'defaults'})`);
  const table = dispatch._effectiveNormalTable();
  for (const ctx of Object.keys(table)) {
    for (const e of (table[ctx] || [])) {
      const s = e.spec;
      const v = s.builtin || (s.action && `action:${s.action}`) || (s.command && `command:${s.command}`) || '?';
      out(`  ${String(e.key).padEnd(4)} -> ${v}${ctx !== 'global' ? `   [${ctx}]` : ''}`);
    }
  }
  return 0;
}

module.exports = { runKeymapDump };
