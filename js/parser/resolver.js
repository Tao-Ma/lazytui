/**
 * Variable and helper resolution for `script:` actions.
 *
 * Mirrors parser/resolver.py — two regex passes:
 *   1. @use helper_name on its own line → inline helper body (indented
 *      to match the @use line's indentation).
 *   2. $VAR / ${VAR} → vars_block value. Unknown vars are left as-is
 *      (could be shell builtins like $HOME, $1).
 */
'use strict';

const { ResolutionError } = require('./errors');

// Match `@use helper_name` on its own line. Group 1 = leading indent,
// group 2 = helper name. JS regex uses /m so ^/$ are line anchors.
const USE_RE = /^([ \t]*)@use\s+(\w+)\s*$/gm;

// $VAR or ${VAR}. Group 1 = braced name, group 2 = bare name.
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function passthroughCmd(cmd, context) {
  // T19 — `cmd:` is the one-liner short form; `@use` directives need
  // the multi-line `script:` resolution pass to expand. Pre-fix the
  // string passed through verbatim and the shell got `/bin/sh -c
  // '@use greet'` → "@use: command not found" at runtime, leaving
  // the user thinking the helper was broken. Reject at parse time
  // with a useful message.
  if (typeof cmd === 'string' && /(^|\n)\s*@use\s+\w+/.test(cmd)) {
    throw new ResolutionError(`'@use' directives require 'script:' (multi-line) not 'cmd:'`, { context });
  }
  return { script: cmd, varsUsed: {}, helpersUsed: [] };
}

function resolveScript(rawScript, varsBlock, helpersBlock, context) {
  const { script: afterHelpers, helpersUsed } = expandHelpers(rawScript, helpersBlock, context);
  const { script, varsUsed } = resolveVars(afterHelpers, varsBlock);
  return { script, varsUsed, helpersUsed };
}

function expandHelpers(script, helpersBlock, context) {
  const helpersUsed = [];
  const out = script.replace(USE_RE, (_match, indent, name) => {
    if (!Object.prototype.hasOwnProperty.call(helpersBlock, name)) {
      throw new ResolutionError(`undefined helper '${name}'`, { context });
    }
    helpersUsed.push(name);
    // Strip trailing newlines from helper body, then indent each
    // non-blank line by `indent`. Blank lines stay bare so the
    // user's script doesn't gain trailing whitespace.
    const body = helpersBlock[name].replace(/\n+$/, '');
    const lines = body.split('\n');
    return lines.map(line => line.trim() ? indent + line : line).join('\n');
  });
  return { script: out, helpersUsed };
}

function resolveVars(script, varsBlock) {
  const varsUsed = {};
  const out = script.replace(VAR_RE, (match, braced, bare) => {
    const name = braced || bare;
    if (Object.prototype.hasOwnProperty.call(varsBlock, name)) {
      varsUsed[name] = varsBlock[name];
      return varsBlock[name];
    }
    return match;  // leave unknown $FOO alone
  });
  return { script: out, varsUsed };
}

module.exports = { passthroughCmd, resolveScript };
