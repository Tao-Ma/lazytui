# Kitty keyboard protocol — arc SPEC (FROZEN 2026-08-05)

Status: **FROZEN** (user pinned all six decisions 2026-08-05). Follow-on
arc to v0.6.13 (truecolor); implementation begins on the user's word,
after v0.6.13 tags. Sibling to terminal-pane color / user theme files.

## Why this exists — the deep-check finding

The input tokenizer (`js/leaves/input/tokenize.js`) carries two
documented "deliberate non-features" (the 50ms `\x1b[`+key misjoin, and
the OSC/DCS-vs-Alt-chord collision). The 2026-08-05 deep check concluded
these are **inherent to legacy terminal input, not artifacts of our
design.** Both are two faces of one root cause:

> Terminal keyboard input is an **unframed, prefix-ambiguous byte
> stream, and the transport strips keystroke boundaries.** `\x1b` is
> simultaneously a complete token (Escape) and the prefix of every
> escape sequence; the chunk boundary carries no semantic information
> (local raw-mode PTY delivers one event per key by accident of
> transport; SSH/TCP coalesces and splits arbitrarily). No parser —
> ours, Node `readline` (same Esc-timeout), or xterm.js's VT parser
> (spec-faithfully swallows OSC/DCS, which on the *input* side is the
> bug) — resolves the ambiguity in-band, because the disambiguating
> information (time; whether we solicited a response) is not in the band.

The tokenizer is correctly sized to that reality. The only genuine
escape from the dilemma is a **different input encoding** — the kitty
keyboard protocol (KKP), also known as CSI-u / "comprehensive keyboard
handling." That is what this arc adds.

**Honest framing of the payoff (read this first):** KKP is NOT a refactor
that deletes the hard tokenizer code. It is an **additional, negotiated,
better path that sits alongside the legacy path forever.** On terminals
that speak it, the ambiguity is *avoided* (Escape arrives as a
self-terminating `\x1b[27u`, so the 50ms carry window never opens for it;
Alt+] arrives as a CSI-u code, so it no longer collides with the OSC
introducer). On terminals that don't (Terminal.app, old xterm, many
others), the legacy path runs unchanged and keeps its documented corners.
So the tokenizer's two won't-fixes do **not** disappear — they become
*unreachable on capable terminals*. Do not expect this arc to simplify
tokenize.js; it grows the system, it doesn't shrink it.

## Protocol primer (what we'd implement)

KKP is negotiated with CSI-u control sequences (all pass the existing CSI
grammar — see integration map):

- **Query** current flags: `CSI ? u` (`\x1b[?u`).
- **Response** (supporting terminal only): `CSI ? <flags> u`
  (`\x1b[?<n>u`).
- **Push** flags (enable): `CSI > <flags> u` (`\x1b[><n>u`).
- **Pop** flags (restore): `CSI < u` (`\x1b[<u`, pop 1).
- **Detection fence:** send the query, then Primary Device Attributes
  `CSI c` (`\x1b[c`). Every terminal answers DA1 (`\x1b[?...c`); a
  KKP-supporting one emits the `\x1b[?<flags>u` reply *before* the DA
  reply. DA1 is the sync barrier: reply-before-DA ⇒ supported,
  DA-alone ⇒ not.

Progressive-enhancement flag bits (bitfield): `1` disambiguate escape
codes · `2` report event types (press/repeat/release) · `4` report
alternate keys · `8` report all keys as escape codes · `16` report
associated text.

Key events (with disambiguate on): `CSI <unicode-code> ; <modifiers> u`
for most keys (Esc = `\x1b[27u`, Enter = `\x1b[13u`, Tab = `\x1b[9u`,
Backspace = `\x1b[127u`); functional keys keep their legacy final byte
but can now carry a modifier param (`\x1b[1;5A` = Ctrl+Up). Modifiers =
`1 + bitmask` (shift 1, alt 2, ctrl 4, super 8, …).

## Integration map (grounded in current code, 2026-08-05)

| Seam | File | Change |
|---|---|---|
| Escape sequences | `js/io/term.js` | Add `enableKKP()`/`disableKKP()`/`queryKKP()`, symmetric with the existing `enableMouse` family. |
| Boot | `js/app/tui.js` (~329, next to `color_depth` resolve) | After raw mode + `enableMouse`, initiate detection (write query + DA fence). |
| Exit teardown | `js/dispatch/runtime/cleanup.js` (disableMouse/showCursor block) | **MUST** `disableKKP()` (pop). Leaving KKP on after exit breaks the user's shell. |
| Suspend/resume | `js/app/suspend.js` (`suspendTerminal`/`resumeTerminal`) | **MUST** pop on suspend, re-push on resume — same reason, and covers Ctrl-Z + the `type:spawn` editor/shell handoff that reuses these. The "adding a new mode happens once" comment invites exactly this. |
| Tokenizer | `js/leaves/input/tokenize.js` | **NO CHANGE.** `\x1b[27u`, `\x1b[27;5u`, `\x1b[?1u`, `\x1b[?62;c` all match the existing sticky `_CSI_FULL` regex (params `[0-?]` covers `?><=;:` + digits; final `[@-~]` covers `u`,`c`). The tokenizer already emits them as single complete tokens. This is the arc's biggest gift — the hard part is already done. |
| Dispatch ladder | `js/dispatch/control/input.js` `_dispatchToken` (~1168) | (a) **Response arm** — recognize `\x1b[?<flags>u` (KKP reply) and `\x1b[?...c` (DA fence) → emit a capability Msg, not a key. Place before the key arms (the `?` private marker means no collision with real keys). (b) **CSI-u decoder arm** — decode `\x1b[<code>;<mods>u` and modified functional forms into the SAME key names the legacy arms produce (`up`, `escape`, `ctrl-c`, …), so the keymap layer (E9) is untouched. |
| Capability state | model + a `kkp_detected` Msg | Land support in `model` via a Msg so it's replayable (like arrange / color-depth state). New field e.g. `model.caps.keyboard`. |
| Config + env | `js/parser/schema.js` (allowlist), `js/parser/index.js`, `js/app/tui.js` | `keyboard_protocol:` key (`auto`/`legacy`/`kitty`) + `LAZYTUI_KBD` env override, env-beats-config precedence mirroring `color_depth`. Never-brick kill switch for misbehaving terminals. |

**New for this codebase:** detection is a **round-trip** (solicit →
parse reply). `color_depth`, the closest capability precedent, is a
one-shot env read with no round-trip. This arc builds the first
"solicit a terminal response and route the reply as a Msg" seam — which
is also the reusable home for any future query (OSC 11 background color,
etc.). That is a genuine architectural addition, not just a parser tweak.

**Replay/TEA note:** the query *write* is a boot-time terminal-setup
side-effect in the same class as `enableMouse` (a `stdout.write`, not a
model-driven Cmd), so it's replay-neutral. The *reply* arrives as normal
input, already captured by the Msg-WAL; routing it to a `kkp_detected`
Msg keeps detection fully replayable. No new WAL machinery.

## Dependency vs independent implementation — the standard-data question

KKP is a **published standard** (kovidgoyal's kitty keyboard protocol
spec), so per the dep policy its encoding tables + handshake are
*standard-data* — implement from the spec, don't invent (same category as
UAX #11 for `charWidth`). But an npm-landscape check (2026-08-05) found **no mature,
CJS, node>=18 runtime dep** that clears the bar for a never-brick core
input path:

- `kitty-keyboard@0.1.0` (the one directly-relevant package) — **ESM-only**
  and **`engines: node>=24`**. Adopting it bumps our minimum Node 18→24
  and forces async ESM-interop into a synchronous input path, on a
  1-release/one-month-old package. Rejected as a runtime dep.
- `@bindtty/input@0.1.0-beta.x` — ESM-only, beta, coupled to its own
  framework (`@bindtty/text`). Rejected.
- `@xterm/headless` (already a dep) is an *output* emulator — it does not
  provide a stdin→keyevent decoder we can consume.

**Therefore: independent implementation from the open spec + a test
oracle — the same shape used for `charWidth` (NOT "borrowing"):**
1. **Implement from the public spec.** Write our own decoder and our own
   table (our format) for the flag bits (`1/2/4/8/16`), modifier math
   (`value = 1 + mask`), PUA functional-key numbers, the `CSI ? u` query
   + `CSI c` (DA1) fence, and push/pop, pinned by tests. A protocol is a
   *method of operation* (17 U.S.C. §102(b)) — not copyrightable — so this
   is independent implementation, not a derivative work. Cite the spec
   URL as a REFERENCE (engineering hygiene), not as a license step.
2. **Reference impl as a differential-test ORACLE** (like `test-char-width.js`
   pins `charWidth` against @xterm): best case reuse `@xterm/headless`
   (already an MIT dep) *if* it round-trips kitty input (needs
   verification); fallback runs `kitty-keyboard` (MIT) as a **dev-only**
   oracle (Node 24 in CI is fine even though runtime targets 18; a
   devDependency is not distributed to consumers). Library-grade
   correctness without shipping the runtime constraints.

Net: the decoder is ours (no mature lib to lean on) — spec-derived and
oracle-pinned, not copied. Revisit a runtime dep if a CJS/node>=18
implementation matures.

### Licensing & provenance (verified 2026-08-05)

- lazytui = **MIT** (publishable); all 5 current runtime deps = MIT. The
  posture is strictly permissive.
- **kitty terminal = GPL-3.0 → its source is OFF-LIMITS.** We never copy
  kitty's C/Python. We implement from the *spec* only.
- The spec has no separate doc license (lives in the GPL repo). Implementing
  the protocol needs no license (§102(b); crossterm/Go/`kitty-keyboard`
  all implement it under permissive licenses). But we must NOT paste the
  spec's **prose** verbatim into our docs/comments — restate facts in our
  own words; a URL citation is fine.
- `kitty-keyboard@0.1.0` = **MIT** (© Derek Petersen), presents as a
  clean-room spec implementation (README cites the spec, no GPL markers).
  Safe as a **dev-only** oracle. We use it as a black box — we do NOT copy
  its code (if we ever did, MIT requires preserving its notice).
- Running real kitty (GPL) to *capture* reference sequences is fine —
  observing behavior imposes no obligation; we don't distribute kitty.
- Nominative use of the name "kitty" ("implements the kitty keyboard
  protocol") is descriptive fair use.

## PINNED DECISIONS (frozen 2026-08-05)

All six pinned to the recommended options:

| # | Decision | **Pinned** |
|---|---|---|
| D1 | Flags | **Disambiguate only (flag 1)** |
| D2 | Detection | **Handshake** (query + DA1 fence → capability Msg, enable on confirm) |
| D3 | Coverage | **KKP only** (no modifyOtherKeys) |
| D4 | Key names | **Normalize CSI-u → existing legacy names** |
| D5 | Version | **v0.6.14** (next release after v0.6.13) |
| D6 | Implementation | **Implement-from-spec + reference-impl-as-oracle, no runtime dep** (hard rules: no GPL kitty source, no verbatim spec prose) |

Rationale for each pin below (retained as the "why").

**D1 — Which flags?** Recommend **flag 1 (disambiguate) only** for v1.
It alone dissolves both un-fixable horns. Flags 2/4/8/16 are features
(key-release detection, alternate keys, associated text) with no current
consumer and they enlarge the decode matrix. Defer.

**D2 — Detection strategy.** Three tiers:
- (a) **No detection** — unconditionally push `CSI > 1 u` and
  unconditionally run the CSI-u decoder arm. Spec-safe: non-KKP
  terminals ignore the push and never emit CSI-u, so the decoder never
  fires for them; the legacy path (incl. the 50ms window) simply stays.
  Smallest surface. Cost: no capability signal, no reusable
  solicit/parse seam, can't tell a partially/buggily-implementing
  terminal from a good one.
- (b) **Handshake** (recommended) — query + DA fence → capability Msg,
  then push only on confirmed support. Robust; builds the reusable
  solicit-and-parse seam; matches the never-brick ethos. Cost: the
  round-trip machinery (the new part).
- (c) Handshake + expose the capability to config/diagnostics.
Recommend **(b)**.

**D3 — KKP vs modifyOtherKeys.** Recommend **KKP only** for v1.
`modifyOtherKeys` (xterm `CSI >4;2m`, encodes `CSI 27;mods;code~`) has
broader *old-xterm* reach but doubles the negotiation + decode matrix.
Possible tier-2 fallback in a later pass; not v1.

**D4 — Expose new keys, or normalize back to legacy names?** Recommend
**normalize** for v1 — the decoder maps CSI-u events to the existing key
names so nothing downstream (keymap E9, dispatch) changes. KKP *can*
distinguish keys legacy can't (Ctrl-I vs Tab, Ctrl-M vs Enter,
key-release), but surfacing those is a feature beyond dissolving the
horns and would touch the keymap layer. Defer as a possible follow-on.

**D5 — Version target.** **PINNED v0.6.14** (user, 2026-08-05) — the
next release after v0.6.13, ahead of / alongside terminal-pane color +
theme files rather than deferred to a v0.7 batch.

**D6 — Implementation strategy** (see "Dependency vs independent
implementation" above). Recommend **implement-from-spec +
reference-impl-as-oracle**, no runtime dep (none is CJS/node>=18/mature
enough today). Oracle: prefer reusing `@xterm/headless` if it round-trips
kitty input; else `kitty-keyboard` (MIT) dev-only. Hard rules: no GPL
kitty source, no verbatim spec prose. Revisit a runtime dep when a
suitable one matures.

## Testing plan

- **Decoder unit vectors** — hand-authored from the KKP spec: `\x1b[27u`
  → escape, `\x1b[99;5u` → ctrl-c, `\x1b[1;5A` → ctrl-up, plain/shifted
  letters, surrogate-pair codepoints. Assert same key names as legacy.
- **Handshake parse** — feed `\x1b[?1u\x1b[?62;1c` ⇒ detects KKP; feed
  `\x1b[?62;1c` alone ⇒ no KKP, legacy path selected. Fail-on-old.
- **Fallback unchanged** — the existing tokenize + input-burst suites
  must stay green with KKP off (legacy path is the default until
  detected/configured).
- **Lifecycle** — smoke: KKP popped on quit (cleanup.js) and on
  suspend, re-pushed on resume; not leaked to a spawned editor/shell.
- **No @xterm oracle here** — @xterm/headless emulates the *output*
  (host→terminal) direction and does not generate KKP *input*. Verify
  the decoder with spec vectors + a manual real-terminal capture matrix.
- **Real-terminal matrix (manual)** — kitty, foot, WezTerm, Ghostty,
  recent xterm (supported) vs Terminal.app, older tmux (not / quirky).
  tmux needs `extended-keys` and has version quirks — note as a risk.

## Explicitly out of scope

- Simplifying / deleting the legacy tokenizer path (it stays forever for
  non-KKP terminals; its two won't-fixes remain, just unreachable where
  KKP is on).
- Retroactively "fixing" the OSC/DCS collision on legacy terminals — KKP
  does not do this.
- Key-release / event-type / associated-text features (flags 2/4/8/16).
- modifyOtherKeys fallback tier.
- Exposing KKP-only key distinctions (Ctrl-I≠Tab) to the keymap.
