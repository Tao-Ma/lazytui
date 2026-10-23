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

// Port names must be strict identifiers so the `.` separator is unambiguous
// AND the name is a legal POSIX env-var and `\w`-matching `{{name}}` hole.
// Component names (an action-with-ports, or a Component) relax that to also
// allow hyphens — common action-key conventions like `ddns-ping` /
// `rotate-host-keys` need to work alongside `ports.in`. The `.`-delimited
// address scheme still splits unambiguously (hyphen != dot).
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;             // ports: identifier-strict
const COMPONENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;  // components: + hyphens ok

/** True if `s` is a legal fabric PORT name — strict identifier. */
function isValidFabricName(s) {
  return typeof s === 'string' && NAME_RE.test(s);
}

/**
 * True if `s` is a legal fabric COMPONENT name (action-with-ports, Component).
 * Allows hyphens in addition to identifier chars: `ddns-ping`, `rotate-host-keys`.
 * Port names stay stricter (see isValidFabricName) because they bind as POSIX
 * env vars and must `\w`-match in `{{name}}` holes.
 */
function isValidFabricComponentName(s) {
  return typeof s === 'string' && COMPONENT_NAME_RE.test(s);
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
  if (!isValidFabricComponentName(component)) {
    throw new Error(
      `fabric address '${str}': component must be [A-Za-z_][A-Za-z0-9_-]* ` +
      `(identifiers with hyphens ok)`);
  }
  if (!isValidFabricName(port)) {
    throw new Error(
      `fabric address '${str}': port must be a strict identifier ` +
      `[A-Za-z_][A-Za-z0-9_]* (env-var constraint — no hyphens)`);
  }
  return { component, port };
}

/** Format { component, port } → `component.port`. */
function formatFabricAddr(component, port) {
  return `${component}.${port}`;
}

module.exports = { isValidFabricName, isValidFabricComponentName, parseFabricAddr, formatFabricAddr };
