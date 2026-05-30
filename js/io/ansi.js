/**
 * Minimal Rich-markup-to-ANSI converter.
 *
 * Supports: [bold], [dim], [reverse], [green], [red], [yellow], [cyan],
 * [on dark_blue], [/], and escaped brackets \[text].
 * Zero dependencies.
 */
'use strict';

const CODES = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reverse: '\x1b[7m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  'bold cyan': '\x1b[1;36m',
  'bold yellow': '\x1b[1;33m',
  'on dark_blue': '\x1b[44m',
};
const RESET = '\x1b[0m';

/**
 * Convert Rich-style markup to ANSI escape sequences.
 * [bold]text[/] → \x1b[1mtext\x1b[0m
 * \[literal] → [literal]
 */
function richToAnsi(text) {
  // Protect escaped brackets
  let result = text.replace(/\\\[/g, '\x00');
  // Replace tags
  result = result.replace(/\[([^\]]*)\]/g, (_, tag) => {
    if (tag === '/' || tag === '/bold' || tag === '/dim') return RESET;
    return CODES[tag] || RESET;
  });
  // Restore escaped brackets
  return result.replace(/\x00/g, '[');
}

/**
 * Strip Rich markup and escaped brackets, return plain text.
 */
function stripMarkup(text) {
  return text.replace(/\\\[/g, '\x00').replace(/\[[^\]]*\]/g, '').replace(/\x00/g, '[');
}

/**
 * Display width of a single codepoint in terminal columns. CJK and
 * fullwidth characters are 2; everything else is 1. Single source of
 * truth for east-asian width detection — used by visibleLen and panel.js
 * truncation alike.
 */
function charWidth(cp) {
  if ((cp >= 0x4E00 && cp <= 0x9FFF) ||      // CJK Unified Ideographs
      (cp >= 0x3000 && cp <= 0x303F) ||      // CJK Symbols and Punctuation
      (cp >= 0xFF01 && cp <= 0xFF60) ||      // Fullwidth Forms
      (cp >= 0xF900 && cp <= 0xFAFF) ||      // CJK Compatibility Ideographs
      (cp >= 0x3400 && cp <= 0x4DBF) ||      // CJK Extension A
      (cp >= 0x20000 && cp <= 0x2A6DF)) {    // CJK Extension B
    return 2;
  }
  return 1;
}

/**
 * Display width of text in terminal columns.
 */
function visibleLen(text) {
  const plain = stripMarkup(text);
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0));
  return w;
}

/**
 * Escape [ for Rich markup so literal brackets render correctly.
 */
function esc(text) {
  return text.replace(/\[/g, '\\[');
}

module.exports = { richToAnsi, stripMarkup, visibleLen, charWidth, esc, RESET };
