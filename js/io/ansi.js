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
  'bold red': '\x1b[1;31m',
  'bold green': '\x1b[1;32m',
  'bold magenta': '\x1b[1;35m',
  'bold blue': '\x1b[1;34m',
  'bold white': '\x1b[1;37m',
  'on dark_blue': '\x1b[44m',
};
const RESET = '\x1b[0m';

/**
 * Convert Rich-style markup to ANSI escape sequences.
 * [bold]text[/] → \x1b[1mtext\x1b[0m
 * \[literal] → [literal]
 */
// T23 — escaped-bracket sentinel. Pre-fix used NUL (\x00), which
// collided with literal NULs in binary content: `richToAnsi(esc('a\x00b'))`
// returned `'a[b'` because the NUL was treated as an escaped-bracket
// marker. Switched to a BMP private-use codepoint (U+E002) — outside
// any byte range that appears in normal text or in T22's SGR
// placeholder pair (U+E000/U+E001).
const _BRACKET_SENTINEL = '';

function richToAnsi(text) {
  // Protect escaped brackets
  let result = text.replace(/\\\[/g, _BRACKET_SENTINEL);
  // Replace tags
  result = result.replace(/\[([^\]]*)\]/g, (_, tag) => {
    if (tag === '/' || tag === '/bold' || tag === '/dim') return RESET;
    return CODES[tag] || RESET;
  });
  // Restore escaped brackets
  return result.replace(new RegExp(_BRACKET_SENTINEL, 'g'), '[');
}

/**
 * Strip Rich markup and escaped brackets, return plain text.
 */
function stripMarkup(text) {
  return text.replace(/\\\[/g, _BRACKET_SENTINEL)
    .replace(/\[[^\]]*\]/g, '')
    .replace(new RegExp(_BRACKET_SENTINEL, 'g'), '[');
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
 * Strip dangerous terminal-control sequences that would let untrusted
 * content (streamed command output, YAML labels, file-loader previews)
 * escape the panel viewport and hijack the host terminal. Preserves
 * SGR sequences (\x1b[…m) — the only ANSI codes legitimate action
 * output emits into the viewer for color/style — and strips every
 * other CSI / OSC / SS3 / single-byte escape, plus C0 controls except
 * \t (tab) and \n (newline).
 *
 * T22 SEVERE — pre-fix esc() only escaped `[`, leaving raw \x1b, \r,
 * \b, \x07 to pass through. A streamed command emitting \x1b[2J\x1b[H
 * cleared the host's screen; \x1b[?1049h flipped to the alt buffer;
 * \x1b]52;c;<base64>\x07 wrote OSC52 to the user's clipboard;
 * \x1b[?25l hid the host cursor permanently. Verified via repro on
 * the round-5 audit.
 *
 * Trade-off: stripping non-SGR CSI means actions can no longer emit
 * cursor-move / screen-clear ANSI into the viewer (those would be
 * meaningless inside a panel anyway — the viewer owns its own
 * scrolling). SGR colors + styles work as before. The viewer's
 * embedded PTY terminal (tabs) DOES interpret the full ANSI repertoire
 * via @xterm/headless and isn't affected by this strip.
 */
function stripControls(s) {
  if (typeof s !== 'string') return s;
  // Protect SGR (\x1b[…m) by parking each match under private-use
  // codepoints (U+E000/U+E001) so the C0 + orphan-ESC strips below
  // don't eat the SGR's own `\x1b`. Restored at the end.
  const sgrs = [];
  s = s.replace(/\x1b\[[0-9;]*m/g, (m) => {
    const i = sgrs.length;
    sgrs.push(m);
    return `${i};`;
  });
  s = s
    // CSI (non-SGR — SGR already parked above): cursor moves, screen
    // clears, alt-buffer flips, mode toggles. Now safe to strip any
    // CSI without preserving anything.
    .replace(/\x1b\[[0-9;?<>=!]*[@-~]/g, '')
    // OSC: \x1b]…ST (BEL 0x07 or ESC-backslash). Catches OSC52
    // clipboard writes, OSC8 hyperlinks, title sets, etc.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // DCS / SOS / PM / APC: \x1bP|\x1bX|\x1b^|\x1b_ … ST
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    // 2-byte escapes: \x1b followed by a char in 0x40-0x5f EXCLUDING
    // those consumed above ([ for CSI, ] for OSC, P/X/^/_ for
    // DCS/SOS/PM/APC). Allowed finals: @, A-O, Q-W, Y-Z, backslash.
    .replace(/\x1b[@A-OQ-WYZ\\]/g, '')
    // Orphan ESC: any \x1b left over (chunk-split sequence, malformed
    // input). Strip — a lone ESC byte makes the terminal swallow the
    // next character as part of an escape, which is the same hijack
    // class we're defending against.
    .replace(/\x1b/g, '')
    // C0 controls (0x00-0x1f) except \t (0x09), \n (0x0a), and ESC
    // (already swept above); DEL (0x7f). This sweeps \r (would reset
    // cursor to col 0, wiping panel borders), \b (corrupts preceding
    // cell), \x07 (BEL — beeps the host), stray NULs, etc.
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, '');
  // Restore parked SGR.
  s = s.replace(/(\d+);/g, (_, i) => sgrs[+i]);
  return s;
}

/**
 * Expand `\t` characters to spaces against a tab-stop ruler (TAB_SIZE
 * cols). esc() calls this after stripControls so a tab in content
 * doesn't desync visibleLen (which counts a tab as 1) from the
 * terminal's display width (which advances to the next tab stop) —
 * the mismatch overruns panel padding and pushes the right border
 * past the panel edge, corrupting the next row. Assumes the input
 * is one line starting at column 0; that holds for the real callers
 * (file-loader.js splits on `\n` before esc; stream.js dispatches
 * per-line; YAML labels are single-line strings).
 */
const TAB_SIZE = 8;
function _expandTabs(s) {
  if (s.indexOf('\t') < 0) return s;
  let out = '';
  let col = 0;
  for (const ch of s) {
    if (ch === '\t') {
      const n = TAB_SIZE - (col % TAB_SIZE);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col += charWidth(ch.codePointAt(0));
    }
  }
  return out;
}

/**
 * Escape [ for Rich markup so literal brackets render correctly.
 * T22 — also strips dangerous terminal-control sequences. T31 —
 * also expands tabs to spaces against TAB_SIZE-col stops so tab-
 * containing content (postgresql.conf, Makefiles, etc.) doesn't
 * misalign the panel renderer's right border. Every content-trust-
 * boundary call site (stream output, YAML label render, file-loader
 * preview) routes through esc(), so this single hook closes both
 * the breakout AND the tab-width class.
 */
function esc(text) {
  return _expandTabs(stripControls(text)).replace(/\[/g, '\\[');
}

/**
 * Wrap `content` in a markup color tag that survives nested `[/]`
 * resets inside the content.
 *
 * Why this exists: richToAnsi treats `[/]` as a hard ANSI reset
 * (`\x1b[0m`), not a stack pop. A naïve `[red]${content}[/]` wrapper
 * drops to terminal default partway through whenever `content`
 * contains a nested `[/]` — e.g., a panel title with a `[dim]…[/]`
 * chip suffix, or a footer string with a `[bold red]…[/]` notice
 * embedded. Every char after that inner `[/]` until the next
 * color tag then renders in the terminal's default color (visible
 * as black on light terminals, white on dark — never the intended
 * border / footer color).
 *
 * `wrapColor` rewrites every inner `[/]` to `[/][color]`, so the
 * outer color resumes immediately after each reset. The outer
 * `[color]…[/]` framing is unchanged. Pairs with `esc()`: use
 * `esc()` to neutralize untrusted markup chars; use `wrapColor()`
 * when content INTENTIONALLY carries inner color tags but should
 * compose under an outer color.
 *
 * Examples:
 *   wrapColor('red', 'plain')           → '[red]plain[/]'
 *   wrapColor('red', '[dim]a[/] b')     → '[red][dim]a[/][red] b[/]'
 *   wrapColor('green', '[bold]X[/]Y')   → '[green][bold]X[/][green]Y[/]'
 */
function wrapColor(color, content) {
  // Falsy color (undefined / null / empty) means "no outer wrap" — pass
  // content through unmodified. A theme missing the requested entry
  // should still render the content correctly, not surface a literal
  // `[undefined]` markup tag that would never compile to ANSI and would
  // leak into the visible output.
  if (!color) return String(content);
  const rewritten = String(content).split('[/]').join(`[/][${color}]`);
  return `[${color}]${rewritten}[/]`;
}

module.exports = { richToAnsi, stripMarkup, visibleLen, charWidth, esc, wrapColor, stripControls, RESET };
