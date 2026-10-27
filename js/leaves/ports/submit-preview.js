/**
 * Submit-preview formatter (v0.6.44 Brief 3) — "what will run" rendered
 * from the SAME resolved data the spawn path uses, so the preview can
 * never lie about what the submit actually invokes.
 *
 * Pure leaf: data-in / data-out, no I/O, no require of upward modules.
 * Called at render time by `overlay/confirm.js` (when the staged action
 * has `ports.in`) and `overlay/fabric-form.js` (always-on compact
 * footer); both call sites format from the LIVE model state. Nothing
 * from this file ever lands in a Msg payload — the brief's rule
 * "format at render time, don't stamp the formatted text into a Msg"
 * is enforced by not having a Msg to stamp into.
 *
 * Sensitive handling: a port declared `sensitive: true` (parser-stamped
 * via `js/parser/schema.js`) renders as `name=••••••` regardless of
 * whether its value is resolved / typed / defaulted. The parser also
 * forces `remember: false` on any `sensitive: true` port, so the
 * [last] seed never pre-fills a sensitive field (one less leak path).
 *
 * The compact footer in the ports form emits ONE summary line
 * (`N port(s), K sensitive — ‹script›…`); the full preview block (one
 * line per port + variadic items) is for the confirm overlay. The two
 * callers share the same leaf — a port can't be masked in one surface
 * and leak in the other.
 */
'use strict';

const SENSITIVE_MASK = '••••••';

/**
 * Pre-release correctness note: a sensitive port renders as the mask
 * even when its value is UNRESOLVED (pending / missing). The alternative
 * — "mask only when resolved, show <pending> otherwise" — leaks the
 * fact that no value was typed, which can itself be a signal. The mask
 * is the constant shape.
 */
function _formatPortValue(portName, portDecl, resolvedValue, source) {
  if (portDecl && portDecl.sensitive === true) {
    return `${portName}=${SENSITIVE_MASK}`;
  }
  if (resolvedValue == null || resolvedValue === '') {
    return `${portName}=<pending>`;
  }
  // The source tag ('user', 'default', 'last', 'inject', 'env', 'wire')
  // is useful context for the confirm preview — tells the operator
  // where this value came from without them having to track across
  // the actions pane / ports form / env state.
  const srcTag = source ? ` [${source}]` : '';
  return `${portName}=${String(resolvedValue)}${srcTag}`;
}

/**
 * Format the FULL preview block for the confirm overlay.
 *
 * `script`: the resolved shell line that will run (action.script).
 * `boundPorts`: Array<{name, decl, value, source?}> — ordered as the
 *   author declared them. `decl` is the port decl (reads `.sensitive`);
 *   `value` is the resolved value (may be null / '' for a missing port
 *   that the subsequent form will prompt for); `source` is the
 *   derivation tag.
 * `variadic`: {name, items: Array<string>} | null — the variadic port's
 *   argv tail, printed as a dedent-indented list under `name=…`.
 *
 * Returns Array<string> (rich-markup lines). Caller controls layout +
 * truncation; this leaf only emits content.
 */
function formatPreview({ script, boundPorts = [], variadic = null } = {}) {
  const lines = [];
  if (script) {
    lines.push(`[dim]$ ${script}[/]`);
  }
  for (const p of boundPorts) {
    if (!p || !p.name) continue;
    lines.push(`  ${_formatPortValue(p.name, p.decl, p.value, p.source)}`);
  }
  if (variadic && Array.isArray(variadic.items) && variadic.items.length > 0) {
    const isSensitive = variadic.decl && variadic.decl.sensitive === true;
    if (isSensitive) {
      lines.push(`  ${variadic.name}=${SENSITIVE_MASK} (${variadic.items.length} item${variadic.items.length === 1 ? '' : 's'})`);
    } else {
      lines.push(`  ${variadic.name}:`);
      for (const item of variadic.items) {
        lines.push(`    - ${item}`);
      }
    }
  }
  return lines;
}

/**
 * Format the COMPACT one-line footer summary for the ports form.
 * Operator always sees SOMETHING about what will run before pressing
 * Enter; the detail lives in the confirm overlay (if the action has
 * `confirm:`) or the --dev log (otherwise).
 *
 * `boundPorts`: same shape as formatPreview.
 * `script`: the resolved shell line (truncated to ~40 chars).
 * Returns a single rich-markup string line.
 */
function formatCompactFooter({ script, boundPorts = [], variadic = null } = {}) {
  const n = boundPorts.length + (variadic ? 1 : 0);
  const sensitiveCount =
    boundPorts.filter((p) => p && p.decl && p.decl.sensitive === true).length +
    (variadic && variadic.decl && variadic.decl.sensitive === true ? 1 : 0);
  const scriptTeaser = script
    ? ` [dim]— ${script.length > 40 ? script.slice(0, 37) + '…' : script}[/]`
    : '';
  const sensitiveTag = sensitiveCount > 0
    ? `, [warning]${sensitiveCount} sensitive[/]`
    : '';
  return `[dim]${n} port${n === 1 ? '' : 's'}${sensitiveTag}${scriptTeaser}`;
}

module.exports = {
  formatPreview, formatCompactFooter,
  SENSITIVE_MASK,
  _formatPortValue,
};
