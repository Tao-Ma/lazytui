/**
 * Fabric address parsing — `component.port` (attribute-access; see
 * docs/ports-and-wires.md, decision 4).
 *
 * P1 addresses are SAME-GROUP: `component.port`, both parts dot-free
 * identifiers, so the single `.` splits unambiguously. Cross-group
 * (`group.component.port`) is deferred — parseFabricAddr rejects it with a
 * forward-pointing message rather than guessing.
 *
 * This is the fabric's OWN address parser, deliberately NOT the `:open` scheme
 * registry (that opens targets as content tabs and never parses a
 * component→port relationship). Pure, zero-dependency leaf — `js/fabric/` is
 * the dataflow fabric layer (the DI seams that used to own `js/ports/` are now
 * `js/hosts/`).
 */
'use strict';

// Component and port names must be identifiers so the `.` separator is
// unambiguous (decision 4's dot-free-name guard). Reused by schema validation.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True if `s` is a legal fabric identifier (component or port name). */
function isValidFabricName(s) {
  return typeof s === 'string' && NAME_RE.test(s);
}

/**
 * Parse `component.port` → { component, port }. Throws a clear Error on any
 * malformed address — used at load to VALIDATE (a throw becomes a load error),
 * and at invoke where addresses are already validated so it won't throw.
 */
function parseFabricAddr(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new Error(`fabric address must be a non-empty string, got ${typeof str}`);
  }
  const parts = str.split('.');
  if (parts.length === 1) {
    throw new Error(`fabric address '${str}' must be 'component.port'`);
  }
  if (parts.length > 2) {
    throw new Error(
      `fabric address '${str}': cross-group addressing (group.component.port) ` +
      `is not supported yet — wires are same-group in P1`);
  }
  const [component, port] = parts;
  if (!isValidFabricName(component) || !isValidFabricName(port)) {
    throw new Error(
      `fabric address '${str}': component and port must be identifiers ` +
      `[A-Za-z_][A-Za-z0-9_]*`);
  }
  return { component, port };
}

/** Format { component, port } → `component.port`. */
function formatFabricAddr(component, port) {
  return `${component}.${port}`;
}

module.exports = { isValidFabricName, parseFabricAddr, formatFabricAddr };
