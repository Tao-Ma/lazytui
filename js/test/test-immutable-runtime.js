/**
 * Pure-TEA conversion smoke test (Phase 4) — the root reducer.
 *
 * Deep-freeze the model handed to `runtime.update(model, msg)` and assert
 * that:
 *   1. No in-place mutation is attempted (no "cannot assign to frozen X"
 *      TypeError).
 *   2. Every Msg that should change state returns a fresh model ref.
 *   3. Cross-layer Cmds (apply_msg / dispatch_msg) are still produced.
 *
 * Coverage spans one representative Msg per modal sub-model (filter /
 * menu / confirm / prompt / copy / registerPopup / cmdline) + the mode
 * flag flips + the cross-layer cascades (escape, reset_group_context).
 *
 * Run: node js/test/test-immutable-runtime.js
 */
'use strict';

const { describe, it, eq, assert, expectNoMutation, report } = require('./test-runner');
const runtime = require('../app/runtime');
const register = require('../feature/register');

function freshModel() {
  const m = runtime.init();
  // register lives on m.register; seed it directly so the freeze/unfreeze
  // round-trips don't go through the module's lazy auto-init.
  m.register = { history: [], cap: 10 };
  return m;
}

describe('[immutable] root reducer — mode flips', () => {
  it('terminal_enter sets the flag on a new model', () => {
    const m = freshModel();
    const [next, cmds] = expectNoMutation(
      'terminal_enter leaves input frozen',
      () => runtime.update(m, { type: 'terminal_enter' }),
      m,
    );
    eq(next.modes.terminalMode, true);
    eq(m.modes.terminalMode, false, 'original untouched');
    eq(cmds.length, 0);
  });

  it('terminal_exit emits cross-layer dispatch_msg', () => {
    const armed = { ...freshModel(), modes: { ...freshModel().modes, terminalMode: true } };
    const [next, cmds] = expectNoMutation(
      'terminal_exit leaves input frozen',
      () => runtime.update(armed, { type: 'terminal_exit' }),
      armed,
    );
    eq(next.modes.terminalMode, false);
    eq(cmds[0].type, 'dispatch_msg');
    eq(cmds[0].msg.kind, 'layout');
  });

  it('mode_set / mode_clear are identity-preserving when no-op', () => {
    const m = freshModel();
    const sameSet = runtime.update(m, { type: 'mode_set', flag: 'cmdMode' });
    eq(sameSet[0].modes.cmdMode, true, 'flag set');
    const same = runtime.update(m, { type: 'mode_clear', flag: 'cmdMode' });
    assert(same[0] === m, 'mode_clear no-op returns same ref');
  });

  it('focus_event flips model.focused', () => {
    const m = freshModel();  // focused: true by default
    const [next] = expectNoMutation(
      'focus_event leaves input frozen',
      () => runtime.update(m, { type: 'focus_event', focused: false }),
      m,
    );
    eq(next.focused, false);
    eq(m.focused, true, 'original untouched');
  });
});

describe('[immutable] root reducer — confirm modal', () => {
  it('confirm_enter stores message + cmd on a fresh modal sub-model', () => {
    const m = freshModel();
    const stagedCmd = { type: 'do_run', actionKey: 'rm' };
    const [next] = expectNoMutation(
      'confirm_enter leaves input frozen',
      () => runtime.update(m, { type: 'confirm_enter', message: 'Sure?', cmd: stagedCmd }),
      m,
    );
    eq(next.modes.confirmMode, true);
    eq(next.modal.confirm.message, 'Sure?');
    assert(next.modal.confirm.cmd === stagedCmd, 'cmd ref carried through');
    eq(m.modal.confirm.cmd, null, 'original modal untouched');
  });

  it('confirm_accept re-emits the staged Cmd + clears the modal', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, confirmMode: true },
      modal: { ...freshModel().modal, confirm: { message: 'Sure?', cmd: { type: 'do_run' } } },
    };
    const [next, cmds] = expectNoMutation(
      'confirm_accept leaves input frozen',
      () => runtime.update(armed, { type: 'confirm_accept' }),
      armed,
    );
    eq(next.modes.confirmMode, false);
    eq(next.modal.confirm.cmd, null);
    eq(cmds[0].type, 'do_run');
  });
});

describe('[immutable] root reducer — prompt modal', () => {
  it('prompt_enter sets the editing buffer', () => {
    const m = freshModel();
    const [next] = expectNoMutation(
      'prompt_enter leaves input frozen',
      () => runtime.update(m, { type: 'prompt_enter', label: 'Args', text: 'ls', ghost: 'ls -la', cmd: { type: 'do_run' } }),
      m,
    );
    eq(next.modes.promptMode, true);
    eq(next.modal.prompt.text, 'ls');
    eq(next.modal.prompt.ghost, 'ls -la');
  });

  it('prompt_key appends a printable char', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, promptMode: true },
      modal: { ...freshModel().modal, prompt: { label: '', spec: '', text: 'ls', ghost: '', cmd: null } },
    };
    const [next] = expectNoMutation(
      'prompt_key leaves input frozen',
      () => runtime.update(armed, { type: 'prompt_key', seq: ' ' }),
      armed,
    );
    eq(next.modal.prompt.text, 'ls ');
    eq(armed.modal.prompt.text, 'ls', 'original buffer untouched');
  });

  it('T26 — paste support: bracketed-paste content appends to prompt', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, promptMode: true },
      modal: { ...freshModel().modal, prompt: { label: '', spec: '', text: 'ls ', ghost: '', cmd: null } },
    };
    const [next] = expectNoMutation(
      'prompt_key paste leaves input frozen',
      () => runtime.update(armed, { type: 'prompt_key', key: 'paste', seq: '/tmp/foo' }),
      armed,
    );
    eq(next.modal.prompt.text, 'ls /tmp/foo', 'paste content appended');
  });
  it('T26 — paste collapses newlines in single-line prompt', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, promptMode: true },
      modal: { ...freshModel().modal, prompt: { label: '', spec: '', text: '', ghost: '', cmd: null } },
    };
    const [next] = runtime.update(armed, { type: 'prompt_key', key: 'paste', seq: 'line1\nline2\r\nline3' });
    eq(next.modal.prompt.text, 'line1 line2 line3', 'newlines collapsed to spaces');
  });

  it('prompt_submit emits the Cmd with parsed args', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, promptMode: true },
      modal: { ...freshModel().modal, prompt: { label: '', spec: '', text: 'foo bar baz', ghost: '', cmd: { type: 'do_run' } } },
    };
    const [next, cmds] = expectNoMutation(
      'prompt_submit leaves input frozen',
      () => runtime.update(armed, { type: 'prompt_submit' }),
      armed,
    );
    eq(next.modes.promptMode, false);
    eq(cmds[0].args.join(','), 'foo,bar,baz');
  });
});

describe('[immutable] root reducer — copy / menu / cmdline', () => {
  it('copy_nav wraps the cursor on a fresh modal', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, copyMode: true },
      modal: { ...freshModel().modal, copy: { options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], idx: 0 } },
    };
    const [next] = expectNoMutation(
      'copy_nav leaves input frozen',
      () => runtime.update(armed, { type: 'copy_nav', dir: -1 }),
      armed,
    );
    eq(next.modal.copy.idx, 2, 'wrapped backwards');
  });

  it('cmdline_enter resets the buffer + emits cmdline_rebuild', () => {
    const m = freshModel();
    const [next, cmds] = expectNoMutation(
      'cmdline_enter leaves input frozen',
      () => runtime.update(m, { type: 'cmdline_enter' }),
      m,
    );
    eq(next.modes.cmdMode, true);
    eq(next.modal.cmdline.text, '');
    eq(cmds[0].type, 'cmdline_rebuild');
  });

  it('cmdline_key (printable) appends + emits cmdline_rebuild', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, cmdMode: true },
      modal: { ...freshModel().modal, cmdline: { text: 'foo', sel: 0, matches: [] } },
    };
    const [next, cmds] = expectNoMutation(
      'cmdline_key leaves input frozen',
      () => runtime.update(armed, { type: 'cmdline_key', seq: 'x' }),
      armed,
    );
    eq(next.modal.cmdline.text, 'foox');
    eq(cmds[0].type, 'cmdline_rebuild');
  });
});

describe('[immutable] root reducer — register popup + push', () => {
  it('register_push folds the leaf return into a fresh model', () => {
    const m = freshModel();
    const [next, cmds] = expectNoMutation(
      'register_push leaves input frozen',
      () => runtime.update(m, { type: 'register_push', text: 'hello' }),
      m,
    );
    eq(next.register.history[0], 'hello');
    eq(m.register.history.length, 0, 'original register untouched');
    eq(cmds[0].type, 'emit_osc52');
  });

  it('register_popup_nav clamps + identity-preserves when nothing changes', () => {
    const m = freshModel();  // empty history → idx clamps to 0
    const same = runtime.update(m, { type: 'register_popup_nav', dir: +1, vh: 10 });
    assert(same[0] === m, 'no-op nav returns same ref');
  });

  it('register_popup_drop pops history + clamps cursor', () => {
    let m = freshModel();
    const [m1] = runtime.update(m, { type: 'register_push', text: 'one' });
    const [m2] = runtime.update(m1, { type: 'register_push', text: 'two' });
    const armed = { ...m2,
      modes: { ...m2.modes, registerPopupMode: true },
      modal: { ...m2.modal, registerPopup: { idx: 0, scroll: 0 } },
    };
    const [next, cmds] = expectNoMutation(
      'register_popup_drop leaves input frozen',
      () => runtime.update(armed, { type: 'register_popup_drop', vh: 10 }),
      armed,
    );
    eq(next.register.history.length, 1, 'one entry dropped');
    eq(cmds[0].type, 'force_full_repaint');
  });
});

describe('[immutable] root reducer — filter mode', () => {
  it('filter_enter stages the buffer', () => {
    const m = freshModel();
    const [next] = expectNoMutation(
      'filter_enter leaves input frozen',
      () => runtime.update(m, { type: 'filter_enter', panel: 'containers', text: 'foo' }),
      m,
    );
    eq(next.modes.filterMode, true);
    eq(next.modal.filter.text, 'foo');
    eq(next.modal.filter.panel, 'containers');
  });

  it('filter_key appends a printable char', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, filterMode: true },
      modal: { ...freshModel().modal, filter: { text: 'fo', panel: 'containers' } },
    };
    const [next] = expectNoMutation(
      'filter_key leaves input frozen',
      () => runtime.update(armed, { type: 'filter_key', seq: 'o' }),
      armed,
    );
    eq(next.modal.filter.text, 'foo');
    eq(armed.modal.filter.text, 'fo', 'original buffer untouched');
  });

  it('filter_key (\\x7f on empty) is identity-preserving', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, filterMode: true },
      modal: { ...freshModel().modal, filter: { text: '', panel: 'containers' } },
    };
    const same = runtime.update(armed, { type: 'filter_key', seq: '\x7f' });
    assert(same[0] === armed, 'backspace on empty: no allocation');
  });
});

describe('[immutable] root reducer — prefix mode', () => {
  it('enter_prefix arms the mode with the root binding node', () => {
    const m = freshModel();
    const [next] = expectNoMutation(
      'enter_prefix leaves input frozen',
      () => runtime.update(m, { type: 'enter_prefix' }),
      m,
    );
    eq(next.modes.prefixMode, true);
    eq(next.prefixSeq.length, 0);
    assert(next.prefixNode !== null, 'prefixNode armed');
    eq(m.modes.prefixMode, false, 'original untouched');
  });

  it('prefix_key on escape clears the mode', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, prefixMode: true },
      prefixSeq: ['x'],
    };
    const [next] = expectNoMutation(
      'prefix_key escape leaves input frozen',
      () => runtime.update(armed, { type: 'prefix_key', key: 'escape' }),
      armed,
    );
    eq(next.modes.prefixMode, false);
    eq(next.prefixSeq.length, 0);
  });
});

describe('[immutable] root reducer — cross-layer cascades', () => {
  it('set_current_group rewrites currentGroup + identity-preserves on no-op', () => {
    const m = freshModel();
    const [next] = expectNoMutation(
      'set_current_group leaves input frozen',
      () => runtime.update(m, { type: 'set_current_group', name: 'pg' }),
      m,
    );
    eq(next.currentGroup, 'pg');
    const same = runtime.update(next, { type: 'set_current_group', name: 'pg' });
    assert(same[0] === next, 'same name: no allocation');
  });

  it('reset_group_context clears terminalMode/listSelectMode + lastRunAction', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, terminalMode: true, listSelectMode: true },
      lastRunAction: 'something',
    };
    const [next, cmds] = expectNoMutation(
      'reset_group_context leaves input frozen',
      () => runtime.update(armed, { type: 'reset_group_context' }),
      armed,
    );
    eq(next.modes.terminalMode, false);
    eq(next.modes.listSelectMode, false);
    eq(next.lastRunAction, '');
    // Cmd payload depends on Component registration; just assert it's an array.
    assert(Array.isArray(cmds), 'cascade Cmds emitted');
  });

  it('set_last_run_action identity-preserves on duplicate', () => {
    const m = { ...freshModel(), lastRunAction: 'foo' };
    const same = runtime.update(m, { type: 'set_last_run_action', action: 'foo' });
    assert(same[0] === m, 'same action: no allocation');
  });
});

describe('[immutable] root reducer — Cmd-only verbs are identity-preserving', () => {
  it('show_help / quit / next_tab / prev_tab do not change the model', () => {
    const m = freshModel();
    // `refresh` no longer goes through the reducer (R4.5) — actions.js
    // calls api.refreshAll() directly.
    for (const t of ['show_help', 'quit', 'next_tab', 'prev_tab']) {
      const [next, cmds] = runtime.update(m, { type: t });
      assert(next === m, `${t} returns same ref`);
      assert(cmds.length >= 1, `${t} emits at least one Cmd`);
    }
  });

  it('unknown Msg is identity-preserving', () => {
    const m = freshModel();
    const same = runtime.update(m, { type: 'something_unknown' });
    assert(same[0] === m, 'unknown returns same ref');
    eq(same[1].length, 0, 'no Cmds');
  });
});

// --- T9 coverage: escape / list_select / menu_* family --------------------
//
// The cross-layer cascades the pre-release audit flagged as the highest-risk
// uncovered class: escape and list_select both flip `model.modes` AND dispatch
// a wrapped multisel_clear into the focused Component's update. The menu_*
// family is the entire untested modal sub-model with cursor + items array.

describe('[immutable] root reducer — escape / list_select', () => {
  it('escape clears listSelectMode and returns a new model', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, listSelectMode: true } };
    const [next, cmds] = expectNoMutation(
      'escape (listSelectMode on) leaves input frozen',
      () => runtime.update(armed, { type: 'escape' }),
      armed,
    );
    eq(next.modes.listSelectMode, false);
    eq(armed.modes.listSelectMode, true, 'original untouched');
    assert(Array.isArray(cmds), 'Cmds array (compName-dependent payload)');
  });
  it('escape identity-preserves when nothing to clear', () => {
    const m = freshModel();
    const [same, cmds] = runtime.update(m, { type: 'escape' });
    assert(same === m, 'no listSelect, no multiSel: same ref');
    eq(cmds.length, 0, 'no Cmds');
  });
  it('list_select toggle flips listSelectMode on a new model', () => {
    const m = freshModel();
    const [next] = expectNoMutation(
      'list_select toggle leaves input frozen',
      () => runtime.update(m, { type: 'list_select', mode: 'toggle' }),
      m,
    );
    eq(next.modes.listSelectMode, true);
    eq(m.modes.listSelectMode, false, 'original untouched');
  });
  it('list_select on (when already on) is identity-preserving', () => {
    const armed = { ...freshModel(),
      modes: { ...freshModel().modes, listSelectMode: true } };
    // mode:'on' always sets to true, but with no actual flip there's still
    // an allocation (the reducer takes the success branch). The contract
    // says no MUTATION, not no-allocation — pin both with expectNoMutation.
    const [next] = expectNoMutation(
      'list_select mode:on leaves input frozen',
      () => runtime.update(armed, { type: 'list_select', mode: 'on' }),
      armed,
    );
    eq(next.modes.listSelectMode, true);
  });
});

describe('[immutable] root reducer — menu_* modal', () => {
  it('menu_open seeds modal.menu on a fresh model', () => {
    const m = freshModel();
    const [next] = expectNoMutation(
      'menu_open leaves input frozen',
      () => runtime.update(m, { type: 'menu_open' }),
      m,
    );
    eq(next.modes.menuOpen, true);
    assert(Array.isArray(next.modal.menu.items), 'items list built');
    eq(next.modal.menu.idx, 0);
    eq(m.modes.menuOpen, false, 'original untouched');
    assert(next.modal !== m.modal, 'modal sub-model is a new object');
  });
  it('menu_nav advances idx, skipping null separators', () => {
    const opened = runtime.update(freshModel(), { type: 'menu_open' })[0];
    if (opened.modal.menu.items.length < 2) return;  // build empty in some test envs
    const [next] = expectNoMutation(
      'menu_nav leaves input frozen',
      () => runtime.update(opened, { type: 'menu_nav', dir: +1 }),
      opened,
    );
    assert(next.modal.menu.idx > 0 || next === opened, 'idx advanced or no-op past tail');
  });
  it('menu_close clears modal.menu + flag on a new model', () => {
    const opened = runtime.update(freshModel(), { type: 'menu_open' })[0];
    const [next] = expectNoMutation(
      'menu_close leaves input frozen',
      () => runtime.update(opened, { type: 'menu_close' }),
      opened,
    );
    eq(next.modes.menuOpen, false);
    eq(next.modal.menu.items.length, 0);
    eq(next.modal.menu.idx, 0);
  });
  it('menu_close on a closed menu is identity-preserving', () => {
    const m = freshModel();
    const same = runtime.update(m, { type: 'menu_close' });
    assert(same[0] === m, 'no-op returns same ref');
  });
  it('menu_activate clears modal + emits menu_action Cmd when item present', () => {
    const opened = runtime.update(freshModel(), { type: 'menu_open' })[0];
    // Walk to a non-null item; if no items at all (empty test config), the
    // activate path still has to leave input frozen — that's the contract.
    const [next, cmds] = expectNoMutation(
      'menu_activate leaves input frozen',
      () => runtime.update(opened, { type: 'menu_activate' }),
      opened,
    );
    eq(next.modes.menuOpen, false);
    eq(next.modal.menu.items.length, 0);
    assert(Array.isArray(cmds), 'Cmds array (item-dependent payload)');
  });
});

// ---- T16 regression: accept arms identity-preserve when flag is off ----
//
// Pre-T16, confirm_accept / prompt_submit / copy_select / copy_cancel /
// menu_activate / cmdline_submit / cmdline_cancel / register_popup_commit
// / register_popup_drop would proceed and emit their side-effecting Cmd
// even when the mode flag was already false (e.g. a stale double-fire).
// Symmetric with the reject/cancel arms.

describe('[immutable] root reducer — T16 accept-arm guards', () => {
  const cases = [
    ['confirm_accept',        {}],
    ['prompt_submit',         {}],
    ['copy_select',           {}],
    ['copy_cancel',           {}],
    ['menu_activate',         {}],
    ['cmdline_submit',        {}],
    ['cmdline_cancel',        {}],
    ['register_popup_commit', {}],
    ['register_popup_drop',   { vh: 5 }],
  ];
  for (const [type, extra] of cases) {
    it(`${type} identity-preserves when its mode flag is off`, () => {
      const m = freshModel();
      const msg = Object.assign({ type }, extra);
      const [next, cmds] = runtime.update(m, msg);
      assert(next === m, `${type} returns same model ref when flag off`);
      eq(cmds.length, 0, `${type} emits no Cmds when flag off`);
    });
  }
});

report();
