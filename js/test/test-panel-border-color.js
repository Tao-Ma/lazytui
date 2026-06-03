/**
 * Regression test for the top-border color drop when a panel title
 * contains markup with an embedded `[/]` reset tag (e.g. the files
 * panel's `[dim]\[docker:<container>][/]` title suffix).
 *
 * Before the fix, the inner `[/]` emitted `\x1b[0m` (full ANSI reset)
 * and the trailing border fill rendered in terminal default color —
 * visible as black on light terminals. Normal view masked this via
 * `injectTopRowChrome`'s `[fc]` re-emission after each chrome glyph;
 * half/full view skipped that injection and the bug was naked. Fix:
 * `renderPanel` + `_renderCollapsed` re-emit `[fc]` after the title
 * block so the trailing fill picks the border color back up.
 *
 * Bug-find scenario: postgres demo, free-config mode, half view with
 * focus on PGDATA → PGDATA's top border showed black fill after the
 * `[docker:pg]` chip. Suite caught nothing because there was no
 * pinned assertion on the post-title markup.
 */
'use strict';

const { renderPanel } = require('../render/panel');
const { describe, it, assert, eq, report } = require('./test-runner');

describe('renderPanel — title with embedded [/] preserves border color', () => {
  it('top-border fill stays in fc after a title-internal `[/]`', () => {
    // Title carrying inner markup that closes with `[/]` — same shape
    // the files panel emits for its docker chip.
    const out = renderPanel({
      width: 40, height: 5, lines: ['x'],
      title: 'PGDATA [dim]\\[docker:pg][/]',
      hotkey: '3', focused: true, color: 'green',
    });
    const top = out.split('\n')[0];
    // Locate the title's internal `[/]` and confirm a `[green]` (the
    // focus color) is re-emitted before the trailing fill.
    const idx = top.indexOf('[/]');
    assert(idx >= 0, 'title carries a [/]');
    const tail = top.slice(idx + 3);
    assert(tail.startsWith('[green]'),
      `[fc] re-emitted after title's [/] (tail starts with: ${tail.slice(0, 20)})`);
  });

  it('non-focused panel uses dim, not focus, in the re-emit', () => {
    const out = renderPanel({
      width: 40, height: 5, lines: ['x'],
      title: 'PGDATA [dim]\\[docker:pg][/]',
      hotkey: '3', focused: false, color: 'green',
    });
    const top = out.split('\n')[0];
    const idx = top.indexOf('[/]');
    const tail = top.slice(idx + 3);
    assert(tail.startsWith('[dim]'),
      `[dim] re-emitted after title's [/] when unfocused (got: ${tail.slice(0, 20)})`);
  });

  it('plain title (no markup) still wraps cleanly', () => {
    const out = renderPanel({
      width: 40, height: 5, lines: ['x'],
      title: 'Plain', hotkey: '1', focused: true, color: 'green',
    });
    const top = out.split('\n')[0];
    // Top should start with [green] and end with [/]. The re-emit is
    // present even for plain titles (idempotent — extra [green] before
    // the fill is harmless markup).
    assert(top.startsWith('[green]'), 'top opens with [green]');
    assert(top.endsWith('[/]'), 'top closes with [/]');
  });
});

report();
