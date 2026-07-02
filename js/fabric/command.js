/**
 * Command templates — the no-shell, bind-parameter execution model
 * (docs/ports-and-wires.md, "Command model — no shell, bind parameters").
 *
 * A fabric command is an ARGV TEMPLATE: a program + argument slots. `{{name}}`
 * holes are bound parameters (an input port's resolved value), filled in JS into
 * argv elements and later run with `spawn(argv0, rest, { shell:false })` — so a
 * value never touches a shell parser. Structure is code, values travel
 * out-of-band: injection is structurally impossible, like a prepared statement.
 *
 *   compileCommand(run)          list form (canonical) as-is, or a string tokenised
 *   commandHoles(template)       the {{name}} holes referenced (load-time checks)
 *   fillCommand(template, values){{name}} → argv; a whole-element list-hole splices
 *                                to N args; an embedded hole concatenates
 *
 * Pure, zero-dependency leaf.
 */
'use strict';

const HOLE_RE = /\{\{(\w+)\}\}/g;
const WHOLE_RE = /^\{\{(\w+)\}\}$/;

/** Normalise a `run:` value to an argv template (array of element strings). */
function compileCommand(run) {
  if (Array.isArray(run)) return run.map(String);
  if (typeof run === 'string') return tokenize(run);
  throw new Error(`fabric run must be a list or string, got ${typeof run}`);
}

/**
 * Split a command string into argv elements: whitespace separates; single and
 * double quotes group (and are consumed); adjacent quoted/unquoted spans
 * concatenate into one element (`--flag="a b"` → `--flag=a b`). No shell
 * expansion, no backslash escapes — `{{name}}` holes pass through untouched. For
 * exotic literal args, author the list form.
 */
function tokenize(str) {
  const out = [];
  let cur = '', inTok = false, quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inTok = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (inTok) { out.push(cur); cur = ''; inTok = false; }
      continue;
    }
    cur += ch; inTok = true;
  }
  if (inTok) out.push(cur);
  return out;
}

/** The unique `{{name}}` holes referenced anywhere in the template. */
function commandHoles(template) {
  const names = new Set();
  for (const el of template) {
    let m; HOLE_RE.lastIndex = 0;
    while ((m = HOLE_RE.exec(el)) !== null) names.add(m[1]);
  }
  return [...names];
}

/**
 * Fill a template into a concrete argv array. A whole-element hole (`"{{x}}"`)
 * bound to an array splices into N elements; bound to undefined it is OMITTED
 * (an unset optional arg). An embedded hole concatenates; undefined → "". The
 * value is placed as data — never re-parsed — so any bytes (spaces, quotes, `$`,
 * `;`, newlines) arrive as one literal argument.
 */
function fillCommand(template, values) {
  const vals = values || {};
  const argv = [];
  for (const el of template) {
    const whole = el.match(WHOLE_RE);
    if (whole) {
      const v = vals[whole[1]];
      if (v === undefined) continue;                 // omit an unresolved whole-element hole
      if (Array.isArray(v)) { for (const x of v) argv.push(String(x)); continue; }
      argv.push(String(v));
      continue;
    }
    argv.push(el.replace(HOLE_RE, (_m, name) => {
      const v = vals[name];
      // A list value only splices as a WHOLE-element hole; embedding it would
      // silently String()-join to a CSV. Reject instead (M4).
      if (Array.isArray(v)) {
        throw new Error(`fabric: cannot embed a list value in {{${name}}} — use {{${name}}} as a standalone argument`);
      }
      return v === undefined ? '' : String(v);
    }));
  }
  return argv;
}

module.exports = { compileCommand, tokenize, commandHoles, fillCommand };
