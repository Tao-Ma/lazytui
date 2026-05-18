# Security policy

## Supported versions

lazytui is pre-1.0. The `main` branch is the only supported
version; security fixes land there and roll into the next tagged
release.

| Version | Supported |
|---|---|
| `main` | yes |
| `v0.1.x` | yes (until v0.2.0 lands) |
| older | no |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security reports.

Email the maintainer directly: **tao.ma.1984@gmail.com** with
"lazytui security" in the subject line. Include:

- a description of the issue and its impact,
- repro steps or a proof-of-concept if you have one,
- the lazytui commit / version where you observed it,
- any disclosure timeline preferences.

You can expect an acknowledgement within 5 business days. Fix
timeline depends on severity; coordinated disclosure is the
default unless you specify otherwise.

## Scope notes

lazytui is a framework that **executes shell scripts and YAML
actions defined by users**. Shell-injection-style concerns
inside YAML actions are intentional — the framework runs what
you tell it to run. Real security concerns are things like:

- The framework parsing untrusted YAML in a way that escapes
  the intended sandbox.
- Render-side issues that allow markup injection from data into
  control sequences (the `esc()` rule from
  `docs/PRINCIPLES.md` §7 is load-bearing here).
- Embedded PTY handling (`node-pty` + `@xterm/headless`)
  escaping its scope.

Reports outside that scope are still welcome but may be triaged
as feature requests rather than security fixes.
