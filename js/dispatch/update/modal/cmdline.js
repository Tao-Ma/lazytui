/**
 * `:` cmdline modal sub-reducer (#D12). The reducer owns text + sel + the
 * render-safe match list (model.modal.cmdline); the run closures stay
 * module-held in dispatch/control/cmdline.js. Any text change emits a
 * cmdline_rebuild Cmd — the effects layer rebuilds the registry from the plugin
 * facade (which the pure reducer can't touch) and re-applies cmdline_set_matches
 * with the render-safe projection. That Cmd→Msg writeback keeps the reducer the
 * single writer of model state while the effect supplies the data.
 * `update(model, msg) → [model, cmds]`.
 */
'use strict';

const { withModalMode: _withModalMode, withModal: _withModal } = require('../model-ops');
// cmdline split + viewport size live in a zero-dep leaf so this file,
// dispatch/control/cmdline.js, and overlay/cmdline.js all read the same values.
const { splitQuery: _cmdlineSplit, DROPDOWN_VIEWPORT: CMDLINE_VW } = require('../../../leaves/text/cmdline-split');

const TYPES = ['cmdline_enter', 'cmdline_set_matches', 'cmdline_nav', 'cmdline_key', 'cmdline_submit', 'cmdline_cancel'];

function update(model, msg) {
  switch (msg.type) {
    case 'cmdline_enter':
      return [_withModalMode(model, { cmdMode: true },
        { cmdline: { text: '', sel: 0, scroll: 0, matches: [] } }), [{ type: 'cmdline_rebuild' }]];
    case 'cmdline_set_matches': {
      const c = model.modal.cmdline;
      const matches = msg.matches || [];
      let sel = c.sel > matches.length - 1 ? Math.max(0, matches.length - 1) : c.sel;
      // Skip past hint entries when defaulting — they're discoverability
      // markers (e.g. `docker://`) with no meaningful run action, so
      // Enter shouldn't land on one by default. Once the user arrows TO
      // a hint deliberately, c.sel is preserved across rebuilds; this
      // fixup only fires when sel WOULD point to a hint as a side-effect
      // of the new match set.
      if (matches[sel] && matches[sel].kind === 'hint') {
        let i = sel;
        while (i < matches.length && matches[i].kind === 'hint') i++;
        if (i < matches.length) sel = i;
      }
      // Scroll viewport — match-set size changed, ensure sel is in view
      // and scroll is within bounds.
      const maxScroll = Math.max(0, matches.length - CMDLINE_VW);
      let scroll = Math.min(Math.max(0, c.scroll || 0), maxScroll);
      if (sel < scroll) scroll = sel;
      else if (sel >= scroll + CMDLINE_VW) scroll = sel - CMDLINE_VW + 1;
      // cmdline_preview drives the live-preview teardown/apply on the new
      // sel (typing-narrowed match set). Entries opt in via preview(); the
      // framework calls teardown when sel moves off.
      return [_withModal(model, { cmdline: { ...c, matches, sel, scroll } }),
              [{ type: 'cmdline_preview', sel }]];
    }
    case 'cmdline_nav': {
      const c = model.modal.cmdline;
      // up (dir>0) walks toward worse matches (higher idx); down (dir<0) walks
      // back toward the best match at idx 0 — the dropdown paints best-nearest-
      // the-prompt, so the visual "up" is a higher index.
      const sel = msg.dir > 0
        ? Math.min(c.sel + 1, c.matches.length - 1)
        : Math.max(0, c.sel - 1);
      if (sel === c.sel) return [model, []];
      // Scroll the visible window so sel stays in view. When sel walks
      // OFF the top (sel exceeds the window's upper bound) advance scroll
      // so sel ends up at the top of the new window. Symmetrical the
      // other direction.
      let scroll = c.scroll || 0;
      if (sel < scroll) scroll = sel;
      else if (sel >= scroll + CMDLINE_VW) scroll = sel - CMDLINE_VW + 1;
      return [_withModal(model, { cmdline: { ...c, sel, scroll } }),
              [{ type: 'cmdline_preview', sel }]];
    }
    case 'cmdline_key': {
      const c = model.modal.cmdline;
      if (msg.seq === '\t') {
        // Tab accepts the SELECTED match into the buffer (refine further),
        // keeping any args already typed past the matched name. argComplete
        // entries already pack the full cmdline replacement into `display`
        // (e.g. "open /etc/hosts/"), so we swap the buffer wholesale —
        // the command-name splice formula doesn't apply when display IS
        // the entire command line.
        const chosen = c.matches[c.sel];
        if (!chosen) return [model, []];
        let text;
        if (chosen.argComplete) {
          text = chosen.display;
        } else {
          const { args } = _cmdlineSplit(c.text);
          text = chosen.display.toLowerCase() + (args.length ? ' ' + args.join(' ') : '');
        }
        return [_withModal(model, { cmdline: { ...c, text, sel: 0, scroll: 0 } }), [{ type: 'cmdline_rebuild' }]];
      }
      if (msg.seq === '\x7f') {
        return [_withModal(model, { cmdline: { ...c, text: c.text.slice(0, -1), sel: 0 } }), [{ type: 'cmdline_rebuild' }]];
      }
      if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32 && msg.seq.charCodeAt(0) < 127) {
        return [_withModal(model, { cmdline: { ...c, text: c.text + msg.seq, sel: 0 } }), [{ type: 'cmdline_rebuild' }]];
      }
      // T26 — paste support: bracketed-paste content arrives as
      // key='paste', seq=<full content>. Single-line modal — collapse
      // line breaks to single spaces.
      if (msg.key === 'paste' && typeof msg.seq === 'string') {
        const pasted = msg.seq.replace(/[\r\n]+/g, ' ');
        return [_withModal(model, { cmdline: { ...c, text: c.text + pasted, sel: 0 } }), [{ type: 'cmdline_rebuild' }]];
      }
      return [model, []];
    }
    case 'cmdline_submit': {
      if (!model.modes.cmdMode) return [model, []];
      const c = model.modal.cmdline;
      const chosen = c.matches[c.sel];
      // Enter on a "refinable" entry (hint / dir / docker container —
      // no terminal action) acts like Tab: rewrite the buffer with the
      // entry's display and stay in cmdline mode so the user can keep
      // refining. Without this, Enter would fire the entry's no-op
      // run() and silently close the cmdline — looks like a dead key.
      if (chosen && chosen.refine) {
        return [_withModal(model, { cmdline: { ...c, text: chosen.display, sel: 0, scroll: 0 } }),
                [{ type: 'cmdline_rebuild' }]];
      }
      const sel = c.sel;
      const { args } = _cmdlineSplit(c.text);
      const had = c.matches.length > 0;
      const next = _withModalMode(model, { cmdMode: false },
        { cmdline: { text: '', sel: 0, scroll: 0, matches: [] } });
      // cmdline_run resolves the module-held closure at `sel` + runs it with
      // the parsed args; cmdline_clear drops the held registry afterward.
      // #F4.4 — carry the chosen entry's `display` on the Cmd so the use-site
      // alignment guard can compare against what the user actually saw. It must
      // be captured HERE (reduce time) because `next` clears `matches`, so the
      // effect can no longer read it back from the model.
      return [next, had
        ? [{ type: 'cmdline_run', sel, args, display: chosen ? chosen.display : undefined }, { type: 'cmdline_clear' }]
        : [{ type: 'cmdline_clear' }]];
    }
    case 'cmdline_cancel':
      if (!model.modes.cmdMode) return [model, []];
      // cmdline_revert_preview restores whatever the active preview's
      // teardown points at (theme on revert, etc.) BEFORE clear drops
      // the registry — Esc must restore, not commit.
      return [_withModalMode(model, { cmdMode: false },
        { cmdline: { text: '', sel: 0, scroll: 0, matches: [] } }),
      [{ type: 'cmdline_revert_preview' }, { type: 'cmdline_clear' }]];
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
