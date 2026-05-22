/**
 * Parser error hierarchy. Mirrors parser/errors.py exactly so the JS
 * port can throw the same shapes the Python parser used to. The
 * `message` property carries the same composite string ("line N:
 * context: detail") so callers comparing error.message stay stable.
 */
'use strict';

class ParseError extends Error {
  constructor(message, { context = null, line = null } = {}) {
    let full = message;
    if (context) full = `${context}: ${full}`;
    if (line !== null && line !== undefined) full = `line ${line}: ${full}`;
    super(full);
    this.name = 'ParseError';
    this.context = context;
    this.line = line;
  }
}

class SchemaError extends ParseError {
  constructor(message, opts) { super(message, opts); this.name = 'SchemaError'; }
}

class ResolutionError extends ParseError {
  constructor(message, opts) { super(message, opts); this.name = 'ResolutionError'; }
}

module.exports = { ParseError, SchemaError, ResolutionError };
