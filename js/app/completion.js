/**
 * Shell tab-completion from the YAML port schema.
 *
 * Two user-facing flags live on the main entry point:
 *   --completion bash|zsh [--cmd <name>]
 *       Print a one-shot completion script to stdout. The script collects
 *       the current words and calls back to --complete for candidates.
 *       Install:  eval "$(./do --completion zsh --cmd ./do)"
 *       Or source into ~/.zshrc / ~/.bashrc etc. The script contains NO
 *       absolute paths — the callback uses `--cmd`'s literal name — so
 *       the consumer's wrapper handles node/NODE_PATH/config as it does
 *       for every other invocation.
 *   --complete <cword> -- <word1> <word2> …
 *       The dynamic candidate helper. Prints one candidate per line to
 *       stdout; exits 0 always (any error, timeout, unknown state → empty
 *       output + exit 0; stderr noise during TAB is a completion-system
 *       bug). <cword> is 1-based: word 0 is the command itself.
 *
 * Completion logic (cword branches):
 *   cword == 1 → group paths (incl. dotted subgroup paths) that contain
 *                actions. Reuses listActions traversal — no parallel walk.
 *   cword == 2 → action keys within the group path in word1.
 *   cword >= 3 → positional port in the action's `ports.in` declaration
 *                order. Port has choices_cmd → run it, print normalized
 *                items. choices_fn → nothing (Components aren't booted in
 *                CLI mode). No ports.in (legacy `$@`) → nothing.
 *
 * choices_cmd execution semantics mirror the TUI fetch, with two
 * deliberate differences:
 *   - cwd = projectDirFor(configPath, config) — same as `script:` spawns.
 *   - Env binding: all earlier positionals bind to port names (not just
 *     depends_on — the words are already typed; binding them is strictly
 *     more useful). Shadow-named ports (PATH, LD_PRELOAD, BASH_FUNC_*,
 *     …) are filtered via filterShadowedPortValues (silently — no stderr
 *     during TAB).
 *   - Timeout: min(choices_timeout ?? 5000, 2500) ms. A hung TAB freezes
 *     the user's prompt — tighter cap than the TUI. SIGTERM to the whole
 *     process group (detached: true + process.kill(-pid, 'SIGTERM')).
 *     On timeout: print nothing, exit 0.
 *   - Normalization: parseChoicesStdout (same leaf the TUI uses) — CRLF,
 *     blank-line drop, labeled split, 32-item cap on items displayed.
 *     choices_labeled: true → emit VALUES only; labels are popover UX.
 *
 * Pure logic (generateScript / complete) separated from printing so tests
 * can call it directly.
 */
'use strict';

const { spawn } = require('child_process');
const { loadConfig } = require('./state');
const { getModel } = require('../model/store');
const {
  listActions, iterActions, resolveAction, mergeForGroup, projectDirFor,
} = require('./cli');
const { parseChoicesStdout } = require('../leaves/text/choices-lines');
const { filterShadowedPortValues } = require('../dispatch/runtime/action-runner');
const { cacheKey } = require('../leaves/ports/choices-cache-key');
const diskCache = require('../leaves/ports/choices-disk-cache');

// Timeout cap — tighter than the TUI's 5000 default: a hung TAB freezes
// the user's prompt. Honors a per-port choices_timeout: UPPER-BOUNDED by
// this constant; a smaller per-port value still wins.
const COMPLETION_TIMEOUT_MAX_MS = 2500;
const COMPLETION_TIMEOUT_DEFAULT_MS = 2500;
// Same 32 cap the choices_cmd runtime applies — humans realistically scan
// ≤ ~32 items; past that the author's command is mis-shaped.
const MAX_COMPLETION_ITEMS = 32;

// Module-level ref so a SIGINT handler installed by runCompletion() can
// reach the currently-spawned choices_cmd child and kill its pgroup
// before node exits. Without this, Ctrl-C mid-TAB kills node but leaves
// the detached child orphaned (Z-BUG1 — the child is in its own pgroup
// because of `detached: true`, which prevents the TTY's SIGINT from
// reaching it). Null when no spawn is active. Single-threaded JS event
// loop → no race between concurrent spawns; completion is one spawn at
// a time via its _spawnAndCapture → _completePositionalArg → complete()
// → runCompletion call stack.
let _currentChild = null;

// -----------------------------------------------------------------------
// Shell script generation
// -----------------------------------------------------------------------

/**
 * Return a bash or zsh completion script string for `cmdName`. The script
 * is deliberately dumb: it collects the current words via standard shell
 * mechanisms and calls back to `--complete`. Contains NO absolute paths —
 * all tool resolution happens through `cmdName` itself, so the consumer's
 * wrapper handles its own invocation details.
 */
function generateScript(shell, cmdName) {
  if (!cmdName || typeof cmdName !== 'string') cmdName = 'do';
  // Reject cmdName containing shell-active characters that would let a
  // crafted --cmd value inject arbitrary shell when the user eval's the
  // generated script. The function-name regex sanitizes the identifier,
  // but cmdName is ALSO interpolated verbatim into the `complete …`
  // registration line and the `<(…)` subshell. A hostile value like
  // `foo\nrm -rf /` would land as `complete -o default -F fn foo\nrm -rf /`,
  // and `eval "$(... --cmd "$(cat untrusted)")"` would execute it.
  // Allow conservative shell-safe filename chars only.
  if (/[\s'"`$\\;|&<>()\n\r\t]/.test(cmdName)) {
    throw new Error(`--cmd value contains shell-active characters (whitespace, quote, $, \\, ;, |, &, <, >, ...): ${JSON.stringify(cmdName)}`);
  }
  if (shell === 'bash') return _bashScript(cmdName);
  if (shell === 'zsh') return _zshScript(cmdName);
  throw new Error(`unsupported shell: ${shell} (expected 'bash' or 'zsh')`);
}

function _bashScript(cmdName) {
  // Function name must be a valid shell identifier — strip non-alnum from
  // cmdName, prefix with `_lazytui_complete_` so it won't collide with
  // generic function names.
  const fn = `_lazytui_complete_${cmdName.replace(/[^a-zA-Z0-9]/g, '_')}`;
  // v0.6.40 — three fixes to the bash script after dev9 QA caught them:
  //   1. PREFIX FILTER: bash doesn't filter raw COMPREPLY assignment
  //      against the typed word (compgen is where filtering happens).
  //      Typing `./do sec<TAB>` with 16 unfiltered candidates lets
  //      menu-cycling replace `sec` with unrelated groups. Filter in
  //      the loop against ${COMP_WORDS[COMP_CWORD]}.
  //   2. NO mapfile: macOS /bin/bash is 3.2.57 (Apple's last GPLv2
  //      ship). `mapfile` is bash 4+; every TAB errors on macOS.
  //      `while IFS= read -r` is the 3.2-portable form AND satisfies
  //      the "candidates may contain spaces" quoting rule (compgen -W
  //      word-splits; this doesn't).
  //   3. -o default FALLBACK: `complete -F fn cmd` without `-o default`
  //      means an empty COMPREPLY = NO completion (not file fallback).
  //      The guide says "shell falls back to default/file completion
  //      for ports without choices" — `-o default` makes that true.
  return `# lazytui bash completion — generated by \`${cmdName} --completion bash\`
${fn}() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  local line
  COMPREPLY=()
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case $line in "$cur"*) COMPREPLY+=("$line");; esac
  done < <(${cmdName} --complete "$COMP_CWORD" -- "\${COMP_WORDS[@]}" 2>/dev/null)
  return 0
}
complete -o default -F ${fn} ${cmdName}
`;
}

function _zshScript(cmdName) {
  const fn = `_lazytui_complete_${cmdName.replace(/[^a-zA-Z0-9]/g, '_')}`;
  // zsh: $CURRENT is 1-based (word 1 = command). We pass CURRENT as-is;
  // the complete() receiver interprets cword consistently (word 0 = command
  // for bash's 0-based, word 1 = first after cmd for zsh's 1-based). Pin
  // the cword normalization: the receiver subtracts 1 from zsh's value in
  // the wrapper below (so both shells feed the receiver with cword
  // "positional index relative to the FIRST word AFTER the command").
  //
  // v0.6.40 — guard against the "${(@f)""}" artifact: zsh's split-on-NL
  // flag on an empty string produces a one-element array containing the
  // empty string, so `compadd -- ""` would offer an empty candidate.
  // Call `_default` to fall through to filename completion when the
  // helper returns nothing (ports without choices, legacy "$@" actions).
  // zsh's compadd handles prefix filtering natively, so no `case` loop
  // mirror of the bash fix is needed on this side.
  return `# lazytui zsh completion — generated by \`${cmdName} --completion zsh\`
${fn}() {
  local -a candidates
  local cword=$(( CURRENT - 1 ))
  local raw
  raw="$(${cmdName} --complete "$cword" -- "\${words[@]}" 2>/dev/null)"
  if [ -z "$raw" ]; then
    _default
    return
  fi
  candidates=("\${(@f)raw}")
  compadd -- "\${candidates[@]}"
}
compdef ${fn} ${cmdName}
`;
}

// -----------------------------------------------------------------------
// Dynamic completion helper
// -----------------------------------------------------------------------

/**
 * Compute candidates for the current cword given the typed words.
 *   configPath   — path to the YAML config
 *   cword        — index of the word being completed (0-based: word 0 is
 *                  the command itself; word 1 is the first positional)
 *   words        — the full word list, words[0] = command, words[1..] =
 *                  positionals typed so far
 * Returns Promise<string[]>. Resolves with an empty array on any error.
 */
async function complete(configPath, cword, words) {
  const safeExit = () => [];
  if (typeof cword !== 'number' || !Number.isFinite(cword) || cword < 1) return safeExit();
  if (!Array.isArray(words) || words.length === 0) return safeExit();
  const config = await _loadSafely(configPath);
  if (!config) return safeExit();

  // cword == 1 → group paths
  if (cword === 1) return _completeGroupPaths(config);

  // cword == 2 → action keys within the group path at words[1]
  if (cword === 2) return _completeActionKeys(config, words[1]);

  // cword >= 3 → positional port
  return _completePositionalArg(configPath, config, cword, words);
}

async function _loadSafely(configPath) {
  try {
    loadConfig(configPath);
    const config = getModel().config;
    return config || null;
  } catch (_) {
    return null;
  }
}

function _completeGroupPaths(config) {
  // Only emit group paths that have at least one action (the user's TAB
  // for cword==1 is "pick a group to invoke under" — a group with no
  // actions can't appear as word 1 of a valid invocation).
  const seen = new Set();
  for (const { path } of iterActions(config)) {
    const groupPath = path.split(':')[0];
    seen.add(groupPath);
  }
  return Array.from(seen).sort();
}

function _completeActionKeys(config, groupPath) {
  if (typeof groupPath !== 'string' || !groupPath) return [];
  const group = (config.groups || {})[groupPath];
  if (!group) return [];
  const actions = mergeForGroup(group, groupPath, config);
  return Object.keys(actions).sort();
}

async function _completePositionalArg(configPath, config, cword, words) {
  // words = [cmdName, groupPath, actionKey, posArg0, posArg1, …]
  // cword points at a positional (cword >= 3). Positional index into
  // ports.in is cword - 3.
  const groupPath = words[1];
  const actionKey = words[2];
  if (!groupPath || !actionKey) return [];
  const resolved = resolveAction(config, `${groupPath}:${actionKey}`);
  if (resolved.error || !resolved.action) return [];
  const action = resolved.action;
  const portsIn = action.ports && action.ports.in;
  if (!portsIn) return [];                              // legacy "$@" action
  const portNames = Object.keys(portsIn);
  const portIdx = cword - 3;
  if (portIdx < 0 || portIdx >= portNames.length) return [];
  const portName = portNames[portIdx];
  const portDecl = portsIn[portName];
  if (!portDecl || typeof portDecl !== 'object') return [];
  // Brief 3 — variadic port: positionals from here on are "command + args",
  // not choice candidates. Emit nothing; the wrapper's `-o default` falls
  // back to filename completion, which is what the user wants for an exec-
  // style tail. (A variadic port's declaration forbids all three choices
  // channels, so this check is also a cheap tripwire for a renamed arm.)
  if (portDecl.variadic === true) return [];
  // Literal `choices:` — the parser normalizes to {items, labels, truncated}.
  // No spawn, no timeout; emit the values directly (labeled maps → values only,
  // matching the choices_cmd+labeled contract: TAB inserts the value you'd
  // actually submit, not the label).
  if (portDecl.choices && typeof portDecl.choices === 'object'
      && Array.isArray(portDecl.choices.items)) {
    return portDecl.choices.items
      .filter((v) => typeof v === 'string')
      .slice(0, MAX_COMPLETION_ITEMS);
  }
  // choices_fn: unsupported in CLI mode — Components aren't booted. Don't
  // fake candidates; let the shell fall back to default/file completion.
  if (typeof portDecl.choices_cmd !== 'string' || !portDecl.choices_cmd) return [];

  const cmd = portDecl.choices_cmd;
  const labeled = portDecl.choices_labeled === true;
  const timeoutMs = _pickTimeout(portDecl.choices_timeout);
  const { env: envBindings, safe } = _bindEarlierPositionals(words, portNames, portIdx);
  const cwd = projectDirFor(configPath, config);

  // On-disk TTL cache: a burst of TABs while composing one command line
  // otherwise respawns `choices_cmd` on every press. The TUI's
  // model.choicesCache does not apply here (`--complete` is a one-shot
  // process). Key encodes action + port + cmd + the SHADOW-FILTERED
  // bindings — that's what actually feeds the spawn, so it's what
  // determines the output. See js/leaves/ports/choices-disk-cache.js.
  //
  // LAZYTUI_COMPLETE_NO_CACHE=1 skips both read AND write for debugging
  // choices_cmd recipes ("why isn't my edited command running").
  const cacheDisabled = process.env.LAZYTUI_COMPLETE_NO_CACHE === '1';
  const key = cacheDisabled ? null : cacheKey(`${groupPath}:${actionKey}`, portName, `cmd:${cmd}`, safe);
  if (key) {
    const state = diskCache.readCache(configPath);
    const hit = diskCache.get(state, key, Date.now(), diskCache.DEFAULT_TTL_MS);
    if (hit && Array.isArray(hit.items)) {
      // Cap at READ too — a future cap raise must not resurrect longer
      // cached lists written by an older version.
      //
      // Pre-release round-2 security review — strip C0 + DEL from every
      // cached item before printing. An attacker able to tamper with the
      // on-disk cache (XDG hijack on a shared system, or any pre-fix
      // writer that didn't sanitize) could seed items containing OSC/CSI
      // escapes that execute on display in the TAB menu (title spoof,
      // cursor-position-report → keystroke injection). The spawn path's
      // `_flatten` now strips the full C0 range, but a cache written by
      // an older version does not — defense-in-depth on READ closes that
      // window. Items are non-string / null-ish defensive drop.
      return hit.items
        .filter((c) => typeof c === 'string')
        .map((c) => c.replace(/[\x00-\x1f\x7f]+/g, ' '))
        .slice(0, MAX_COMPLETION_ITEMS);
    }
  }

  const { items, labels, truncated } = await _spawnAndCapture({ cmd, cwd, env: envBindings, timeoutMs, labeled });
  // Only persist successful, non-empty results. Timeouts, spawn errors,
  // and empty item lists return [] from _spawnAndCapture — an empty
  // result is indistinguishable from a transient failure and caching it
  // buys nothing.
  if (key && items && items.length > 0) {
    const state = diskCache.readCache(configPath) || { entries: {}, order: [] };
    const next = diskCache.put(state, key, { items, labels: labels || null, truncated: !!truncated }, Date.now(), diskCache.DEFAULT_CAP);
    diskCache.writeCache(configPath, next);
  }
  // Load-bearing cap — parseChoicesStdout does NOT cap on its own (the
  // choices_cmd runtime applies the TUI's 32-cap AFTER calling the leaf;
  // completion.js is a parallel caller that applies its own cap here).
  // Same discipline as fabric-form.js's resolver-arm cap (R3F-BUG1).
  return items.slice(0, MAX_COMPLETION_ITEMS);
}

function _pickTimeout(portTimeout) {
  if (typeof portTimeout !== 'number' || !Number.isFinite(portTimeout) || portTimeout <= 0) {
    return COMPLETION_TIMEOUT_DEFAULT_MS;
  }
  return Math.min(portTimeout, COMPLETION_TIMEOUT_MAX_MS);
}

function _bindEarlierPositionals(words, portNames, portIdx) {
  // Bind every positional typed so far to its port name (not just
  // depends_on — the words are sitting right there; binding them is
  // strictly more useful). words[3..] are positionals; positional i
  // binds to portNames[i].
  const raw = {};
  for (let i = 0; i < portIdx; i++) {
    const value = words[3 + i];
    if (typeof value === 'string') {
      raw[portNames[i]] = value;
    }
  }
  // Shadow filter — silently drop PATH / LD_PRELOAD / BASH_FUNC_* etc.
  // No stderr noise (completion must stay silent).
  const { safe } = filterShadowedPortValues(raw);
  // Return BOTH the spawn-ready env (process.env + safe) and the safe
  // subset — the latter is what the cache key hashes (process.env has
  // thousands of unrelated keys and would just invalidate every TAB).
  return { env: { ...process.env, ...safe }, safe };
}

function _spawnAndCapture({ cmd, cwd, env, timeoutMs, labeled }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('sh', ['-c', cmd], {
        cwd, env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,                       // own process group so SIGTERM reaches grand-children
      });
    } catch (_) {
      resolve({ items: [], labels: null });
      return;
    }
    // Expose for the SIGINT handler installed by runCompletion. See the
    // `_currentChild` declaration at module scope for why — short version:
    // detached:true puts the sh child in its own pgroup, so the TTY's SIGINT
    // doesn't reach it; runCompletion's handler must kill the pgroup
    // explicitly before node exits.
    _currentChild = child;

    let stdoutBytes = 0;
    const stdoutChunks = [];
    const MAX_STDOUT = 1024 * 1024;           // 1 MiB defensive cap (same as choices-cmd-runtime)
    let settled = false;
    let timedOut = false;
    let killTimer = null;

    const sendSignal = (sig) => {
      try { process.kill(-child.pid, sig); }
      catch (_) {
        try { child.kill(sig); } catch (__) { /* already gone */ }
      }
    };

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(alarm);
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      // Clear only if this call's child is still the active one. (A test
      // might race multiple spawns in sequence; this guard keeps the
      // module-level ref honest.)
      if (_currentChild === child) _currentChild = null;
      resolve(payload);
    };

    const alarm = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      // SIGTERM is trappable. If `choices_cmd:` traps or ignores it the
      // child survives. We MUST NOT resolve before SIGKILL goes out —
      // node exits as soon as the Promise resolves and the event loop is
      // empty, which cancels any pending setTimeout and leaks the child
      // to PID 1. So: TERM, keep the loop alive 250ms, KILL, then settle.
      // Worst-case TAB latency goes 2.5s → 2.75s; still fine for an
      // interactive completion.
      sendSignal('SIGTERM');
      killTimer = setTimeout(() => {
        killTimer = null;
        sendSignal('SIGKILL');
        settle({ items: [], labels: null });
      }, 250);
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      if (stdoutBytes + buf.length > MAX_STDOUT) {
        // Same cascade as the timeout path: TERM now, KILL after a grace,
        // then let the close handler settle naturally (settle guards
        // against double-resolve).
        if (!killTimer) {
          sendSignal('SIGTERM');
          killTimer = setTimeout(() => {
            killTimer = null;
            sendSignal('SIGKILL');
          }, 250);
        }
        return;
      }
      stdoutBytes += buf.length;
      stdoutChunks.push(buf);
    });
    // stderr is intentionally ignored — completion must stay silent.
    child.stderr.on('data', () => {});
    child.on('error', () => settle({ items: [], labels: null }));
    child.on('close', (code) => {
      if (timedOut || settled) return;
      if (code !== 0) { settle({ items: [], labels: null }); return; }
      let parsed;
      try {
        parsed = parseChoicesStdout(Buffer.concat(stdoutChunks).toString('utf8'), { labeled });
      } catch (_) {
        settle({ items: [], labels: null });
        return;
      }
      settle(parsed);
    });
  });
}

// -----------------------------------------------------------------------
// CLI runners (print + exit — thin wrappers over the pure logic)
// -----------------------------------------------------------------------

function runGenerateScript(shell, cmdName) {
  try {
    const script = generateScript(shell, cmdName);
    process.stdout.write(script);
    return Promise.resolve(0);
  } catch (e) {
    process.stderr.write(`tui --completion: ${e.message}\n`);
    return Promise.resolve(1);
  }
}

async function runCompletion(configPath, cword, words) {
  // SIGINT/SIGTERM handler: when the user Ctrl-Cs mid-TAB (choices_cmd
  // still running), node receives SIGINT but the detached sh child
  // (own pgroup via `detached: true` in _spawnAndCapture) does NOT —
  // the TTY's SIGINT only reaches node's pgroup. Default node behavior
  // then exits ~130 and leaves the sh child orphaned. Override: kill
  // the active child's pgroup first, THEN exit with the standard
  // signal rc. Install `once` so we don't fire twice on repeated
  // Ctrl-Cs. (Z-BUG1 — pre-release hard-review.)
  //
  // Cascade: TERM is trappable (a `trap "" TERM; sleep 10` choices_cmd
  // would survive it). We send TERM first (polite), wait 250ms, then
  // SIGKILL (hard), then exit. If we called process.exit immediately
  // after TERM, the child would orphan to PID 1 on any trap. The 250ms
  // grace is bounded worst-case latency on Ctrl-C; the common case
  // (well-behaved choices_cmd) sees the child die to TERM in <10ms and
  // close fires before KILL is needed — but we send KILL unconditionally
  // because we can't observe close from this handler.
  const _onSignal = (sig) => {
    const rc = sig === 'SIGINT' ? 130 : 143;
    if (!_currentChild) { process.exit(rc); return; }
    const pid = _currentChild.pid;
    const sendTo = (s) => {
      try { process.kill(-pid, s); }
      catch (_) {
        try { _currentChild && _currentChild.kill(s); } catch (__) { /* already gone */ }
      }
    };
    sendTo('SIGTERM');
    setTimeout(() => {
      sendTo('SIGKILL');
      process.exit(rc);
    }, 250);
  };
  process.once('SIGINT', () => _onSignal('SIGINT'));
  process.once('SIGTERM', () => _onSignal('SIGTERM'));

  // Any error path returns 0 with empty output — stderr noise during TAB
  // is a completion-system bug. The one exception: a usage error (missing
  // config path) is detected by the caller before we reach here.
  try {
    const candidates = await complete(configPath, cword, words);
    for (const c of candidates) process.stdout.write(c + '\n');
  } catch (_) { /* swallow — silent TAB */ }
  return 0;
}

module.exports = {
  generateScript, complete,
  runGenerateScript, runCompletion,
  COMPLETION_TIMEOUT_MAX_MS, COMPLETION_TIMEOUT_DEFAULT_MS, MAX_COMPLETION_ITEMS,
};
