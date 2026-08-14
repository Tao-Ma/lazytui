/**
 * Minimal Rich-markup-to-ANSI converter.
 *
 * A tag is space-separated ATOMS, compiled to one SGR sequence in atom order:
 *   attributes  bold · dim · reverse
 *   fg colors   green red yellow blue magenta cyan white · #rrggbb (24-bit)
 *   bg          on <named|dark_blue|#rrggbb>
 *   theme slots warning · error · accent · running · … (any THEMES palette key)
 *   reset       [/] (also [/bold], [/dim])
 * plus escaped brackets \[text]. Examples: [bold cyan], [#rrggbb],
 * [#rrggbb on #rrggbb], [warning]. Hex atoms ALWAYS emit 38;2/48;2 — the
 * pipeline is canonically truecolor; device depth adapts at the WRITE boundary,
 * never here (docs/truecolor.md P3). A tag containing any unknown atom compiles
 * to RESET (defensive, pre-parser behavior preserved). Named atoms emit
 * byte-identical SGR to the pre-parser CODES table (P6, pinned in test-ansi.js).
 *
 * SEMANTIC THEME TOKENS (truecolor arc 3b): an atom naming a palette slot expands
 * to that slot's CURRENT value at paint time (`_expandThemeKeys`), so STORED
 * markup like `[warning]Cancelled.[/]` re-colors on a `:theme` change and a pure
 * reducer can emit themed content without reading the #D8 palette. This makes a
 * compiled tag theme-DEPENDENT, so the memo is invalidated when `theme()` flips
 * (richToAnsi); non-slot tags stay a pure `tag → bytes` memo.
 *
 * Two dependencies back `charWidth` (the width truth function — a standard,
 * spec-evolving problem; see charWidth's doc): `eastasianwidth` (UAX #11, the
 * WIDE axis) and `wcwidth` (POSIX, the ZERO-WIDTH axis). Otherwise pure string
 * transforms.
 *
 * Lives in `leaves/` (not `io/`): every export here is a pure string
 * transform — it builds ANSI/markup strings but performs no I/O (no
 * stdout write, no spawn, no fs). Filing it under `io/` made the pure
 * reducer's `esc` import look like an `update → io` edge and inflated
 * the `panel/overlay/render → io` coupling counts with what are really
 * "→ pure helper" edges. As a leaf the dependency direction reads true.
 */
'use strict';

const { eastAsianWidth } = require('eastasianwidth');
const wcwidth = require('wcwidth');
// Semantic theme tokens resolve against the LIVE palette at paint (below). themes
// is a dependency-free infra leaf, so this is an acyclic leaf→leaf edge.
const { theme } = require('../infra/themes');

const RESET = '\x1b[0m';

// Atom tables. Values are SGR params (joined with ';' in atom order, so
// 'bold cyan' → '1;36' — byte-identical to the retired CODES table).
const _ATTRS = { bold: '1', dim: '2', reverse: '7' };
const _FG = { green: '32', red: '31', yellow: '33', blue: '34', magenta: '35', cyan: '36', white: '37' };
const _BG = { dark_blue: '44', green: '42', red: '41', yellow: '43', blue: '44', magenta: '45', cyan: '46', white: '47' };
const _HEX = /^#([0-9a-fA-F]{6})$/;

function _hexParams(prefix, hex) {
  return `${prefix};2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}`;
}

// Semantic theme tokens (truecolor arc 3b): an atom naming a theme palette slot
// (warning, error, accent, running, partial, …) expands to that slot's CURRENT
// value — a hex, a named-16 color, or a compound `bold #hex` / `#fg on #bg` body.
// Resolved HERE (richToAnsi = paint time), so STORED markup like
// `[warning]Cancelled.[/]` re-colors on a :theme change, and a pure reducer can
// emit themed content without reading the #D8 palette. `dim` stays the faint
// ATTRIBUTE and named-16 FGs (red/green/…) win over any same-named slot (both
// checked first). No slot is named literally in markup today (grep 0), so this
// only ADDS behavior. The result feeds the existing atom compiler + cache, which
// richToAnsi invalidates when theme() flips.
function _expandThemeKeys(tag) {
  if (tag.indexOf(' ') === -1) {
    if (_ATTRS[tag] || _FG[tag]) return tag;
    const v = theme()[tag];
    return v === undefined ? tag : v;
  }
  const atoms = tag.split(' ');
  let changed = false;
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (_ATTRS[a] || _FG[a]) continue;
    const v = theme()[a];
    if (v !== undefined) { atoms[i] = v; changed = true; }
  }
  return changed ? atoms.join(' ') : tag;
}

/** Compile one tag body to SGR, or null when any atom is unknown. */
function _compileTag(tag) {
  if (tag === '/' || tag === '/bold' || tag === '/dim') return RESET;
  const toks = _expandThemeKeys(tag).split(' ');
  const codes = [];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk === 'on') {
      const b = toks[++i];
      if (b !== undefined && _BG[b]) { codes.push(_BG[b]); continue; }
      const m = b !== undefined && _HEX.exec(b);
      if (m) { codes.push(_hexParams('48', m[1])); continue; }
      return null;
    }
    if (_ATTRS[tk]) { codes.push(_ATTRS[tk]); continue; }
    if (_FG[tk]) { codes.push(_FG[tk]); continue; }
    const m = _HEX.exec(tk);
    if (m) { codes.push(_hexParams('38', m[1])); continue; }
    return null;                                  // unknown atom (incl. '')
  }
  return codes.length ? `\x1b[${codes.join(';')}m` : null;
}

// Tag → SGR memo. Pure memoization (deterministic, no observable state) —
// richToAnsi runs per visible row per frame and twice per diffed row, so the
// hot path must stay one Map hit. The cap is defensive only: the tag
// vocabulary is finite (theme slot values + panel literals + gradient steps).
const _TAG_CACHE = new Map();
const _TAG_CACHE_MAX = 1024;
// Semantic theme tokens make a compiled tag theme-DEPENDENT, so the cache must
// drop when the palette changes. `theme()` returns a stable object ref per theme
// (the THEMES table entry), so a `!==` flip is a real :theme change; richToAnsi
// clears the cache once on the first row of the changed frame.
let _lastTheme = null;

function _tagSgr(tag) {
  let v = _TAG_CACHE.get(tag);
  if (v === undefined) {
    v = _compileTag(tag) || RESET;
    if (_TAG_CACHE.size >= _TAG_CACHE_MAX) _TAG_CACHE.clear();
    _TAG_CACHE.set(tag, v);
  }
  return v;
}

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
// Hot-path regex hoisted to module scope (P5.8). `richToAnsi` and
// `stripMarkup` run per visible row per panel per frame; rebuilding
// the sentinel-restore regex on every call was real allocation churn.
const _SENTINEL_RE = new RegExp(_BRACKET_SENTINEL, 'g');

// Tag guard (defensive, truecolor arc 1a): a tag's `[` must not be preceded
// by ESC (lookbehind) and its interior may not contain ESC. On UNESCAPED
// raw-SGR input — which production rows never are, since esc() escapes
// content SGR brackets and the sentinel round-trip reassembles them — the
// old `\[([^\]]*)\]` treated every `\x1b[` as a tag opener: catastrophic
// scans toward a `]` that never comes (~360 µs on a 120-col raw-SGR row),
// and a later literal `]` made it swallow the sequence AND the text into
// one bogus tag → RESET. Legitimate tags are never ESC-adjacent, so both
// guards are behavior-neutral for markup. stripMarkup carries the same
// guards: it must agree with richToAnsi on what is a tag (visibleLen pads
// what richToAnsi renders).
function richToAnsi(text) {
  // Invalidate the tag cache on a :theme change so semantic theme tokens re-resolve.
  const th = theme();
  if (th !== _lastTheme) { _TAG_CACHE.clear(); _lastTheme = th; }
  // Protect escaped brackets
  let result = text.replace(/\\\[/g, _BRACKET_SENTINEL);
  // Replace tags
  result = result.replace(/(?<!\x1b)\[([^\]\x1b]*)\]/g, (_, tag) => _tagSgr(tag));
  // Restore escaped brackets
  return result.replace(_SENTINEL_RE, '[');
}

/**
 * Strip Rich markup and escaped brackets, return plain text.
 */
function stripMarkup(text) {
  return text.replace(/\\\[/g, _BRACKET_SENTINEL)
    .replace(/(?<!\x1b)\[[^\]\x1b]*\]/g, '')
    .replace(_SENTINEL_RE, '[');
}

/**
 * Display width of a single codepoint in terminal columns. THE width truth
 * function — the single source everything routes through (visibleLen, viewer
 * truncation/selection/search, chrome draw, the A2 cell-diff in
 * leaves/render/cell-grid, leaves/text/search). The cell-diff emits ABSOLUTE
 * per-cell MoveTo columns, so this MUST agree with the terminal's actual cursor
 * advance, or borders/glyphs land at the wrong column.
 *
 * Partitioned by axis, each axis resolved by a STANDARD LIBRARY — never a
 * hand-maintained range table (a curated in-repo table is the wrong tool for a
 * standard, spec-evolving problem; the v0.6.7 kana bug came from one such table
 * omitting hiragana/katakana/hangul):
 *   1. cp < 0x300            → 1   (everything below the first combining mark is
 *                                   width 1: ASCII / Latin / Latin-Ext. Fast
 *                                   path — the hot loops pay one int compare per
 *                                   ASCII char and never allocate.)
 *   2. zero-width            → 0   `wcwidth` (POSIX): combining marks, ZWJ,
 *                                   variation selectors, format/default-ignorable.
 *                                   A terminal advances the cursor 0 for these;
 *                                   the cell-diff MUST too or it drifts every
 *                                   absolute MoveTo to the right (NFD text,
 *                                   ZWJ/VS emoji). This is the v0.6.7 round-2 fix.
 *   3. East-Asian Wide/Full  → 2   `eastasianwidth` (UAX #11) `eastAsianWidth()`
 *                                   primitive (NOT `characterLength()`, which
 *                                   counts Ambiguous as 2 → double-width borders).
 *   4. else                  → 1   Ambiguous / Narrow / Halfwidth / Neutral, and
 *                                   emoji/pictographs (→ 1, matching the embedded
 *                                   terminal's cursor advance, the cell-diff oracle).
 *
 * Ambiguous→1 keeps box-drawing (│ ╭ ─), arrows, enclosed digits at width 1.
 * Verified codepoint-by-codepoint against the embedded terminal's OWN wcwidth in
 * test-char-width.js (the exhaustive differential oracle); the residual
 * divergences there are archaic ranges (newer-Unicode libs vs @xterm/headless's
 * V6) + a few astral combining marks — all unhittable in real TUI content,
 * enumerated + pinned so any new divergence surfaces as a test failure.
 */
function charWidth(cp) {
  if (cp < 0x300) return 1;                          // below the first combining mark — all width 1
  const ch = String.fromCodePoint(cp);
  if (wcwidth(ch) === 0) return 0;                   // zero-width axis (POSIX wcwidth)
  const c = eastAsianWidth(ch);                      // wide axis (UAX #11)
  return (c === 'W' || c === 'F') ? 2 : 1;
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
