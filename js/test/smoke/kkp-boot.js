/**
 * Smoke — kitty keyboard protocol through the REAL boot path in a PTY.
 *
 * The in-process smoke (smoke/kkp.js) drives the handshake by calling
 * beginKeyboardDetection() directly; it never runs tui.js#main(), so the
 * TTY-gated boot wiring (real setRawMode, the boot detection block, the
 * config/env gate, exit cleanup) goes unexercised — the same blind spot
 * smoke/boot.js exists to cover. Terminal-side CSI-u ENCODING can't be
 * synthesized headlessly (no library encodes a keypress → kitty bytes; it's
 * the terminal's job), but the round-trip WE own is testable: a raw node-pty
 * is not a terminal emulator, so it never auto-answers our query — we play
 * the terminal, injecting the reply the protocol specifies and asserting the
 * real binary reacts.
 *
 *   auto:   boot emits the query `\x1b[?u`; on our flags-report + DA1 reply it
 *           pushes the flags `\x1b[>1u`; quitting pops them `\x1b[<u`.
 *   legacy: LAZYTUI_KBD=legacy → boot never probes (no `\x1b[?u`).
 *
 * Run: node js/test/smoke/kkp-boot.js
 */
'use strict';

const path = require('path');
const pty = require('node-pty');
const { describe, it, assert, report } = require('../test-runner');

const ROOT = path.resolve(__dirname, '../../..');
const ENTRY = path.join(ROOT, 'js/app/tui.js');
const CONFIG = path.join(__dirname, '_helpers/boot.yml');

const QUERY  = '\x1b[?u';   // our handshake query (unique: no other CSI ends in ?u)
const ENABLE = '\x1b[>1u';  // push disambiguate flag
const POP    = '\x1b[<u';   // pop on teardown
const REPLY  = '\x1b[?1u\x1b[?62;1;6c';  // kitty flags report + Primary-DA fence

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll `cond()` up to `ms`, checking every 25ms. Returns true if it became
// true before the deadline. Poll-until-condition (not a fixed sleep) keeps the
// test robust under CI load AND races the reply in well before the detection
// safety-net timeout fires.
async function until(cond, ms = 4000) {
  for (let waited = 0; waited < ms; waited += 25) { if (cond()) return true; await sleep(25); }
  return cond();
}

// Boot the real binary in a PTY, play the terminal side, collect the byte
// stream. `env` selects the mode; `reply` (optional) is injected the moment the
// query is seen; then we quit with Ctrl-C and let exit cleanup run.
async function run({ env, reply }) {
  let out = '';
  let exitCode = null;
  const term = pty.spawn(process.execPath, [ENTRY, CONFIG], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: ROOT, env,
  });
  term.onData((d) => { out += d; });
  term.onExit((e) => { exitCode = e.exitCode; });

  let enabled = false;
  const queried = await until(() => out.includes(QUERY), 4000);
  if (reply && queried) {
    const beforeReply = out.length;
    term.write(reply);                     // inject promptly — beats the timeout
    enabled = await until(() => out.slice(beforeReply).includes(ENABLE), 2000);
  } else if (!reply) {
    // legacy mode never queries — give boot a beat to prove no probe appears.
    await sleep(600);
  }

  term.write('\x03');                      // Ctrl-C → quit → exit cleanup
  const popped = await until(() => out.includes(POP), 2000);
  try { term.kill(); } catch { /* already gone */ }
  return { out, exitCode, queried, enabled, popped };
}

(async () => {
  const auto = await run({ env: { ...process.env, LAZYTUI_KBD: '' }, reply: REPLY });
  const legacy = await run({ env: { ...process.env, LAZYTUI_KBD: 'legacy' } });

  describe('[1] auto mode — real boot handshake round-trip', () => {
    it('boot emits the detection query', () => {
      if (!auto.queried) console.error(`  ↳ no query; head:\n${auto.out.slice(0, 400)}`);
      assert(auto.queried, 'main() ran the handshake (\\x1b[?u on the wire)');
    });
    it('a flags-report + DA1 reply pushes the disambiguate flag', () => {
      if (!auto.enabled) console.error(`  ↳ no enable after reply; tail:\n${auto.out.slice(-400)}`);
      assert(auto.enabled, 'detection → enableKKP pushed \\x1b[>1u');
    });
    it('exit cleanup pops the flag (never leaked to the shell)', () => {
      assert(auto.popped, 'teardown wrote \\x1b[<u');
    });
  });

  describe('[2] legacy mode — LAZYTUI_KBD=legacy never probes', () => {
    it('boot emits no detection query', () => {
      assert(!legacy.queried, 'no \\x1b[?u when the protocol is disabled');
    });
    it('and no enable sequence', () => {
      assert(!legacy.out.includes(ENABLE), 'no \\x1b[>1u pushed');
    });
  });

  report();
})();
