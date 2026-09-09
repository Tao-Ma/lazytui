# Releasing lazytui

Maintainer's release process. End users don't need to read this.

## Versioning

lazytui follows [SemVer](https://semver.org/). Pre-1.0 is still a moving
target — breaking changes can land in minor bumps, truly experimental
things in patch bumps. After v1.0.0, strict semver applies.

## Artifacts produced by a release

Every release attaches **five assets** to the GitHub Release — two tarballs plus
three native binaries:

| Artifact | Contents | Use case |
|---|---|---|
| `lazytui-X.Y.Z.tgz` | npm-style package. Runtime + parser + docs only (no tests, no demos, no `.github/`). ~225 files / ~980 kB as of v0.6.8. | `npm install` from URL; future `npm install -g lazytui` once we publish. |
| `lazytui-X.Y.Z-source.tar.gz` | Full source archive of the tagged commit (`git archive HEAD`). Includes tests, demos, CI configs — everything that's in git. | Read-only mirror of the tag for users who can't or don't want to `git clone`. |
| `lazytui-X.Y.Z-{linux-x64,linux-arm64,darwin-arm64}` | Standalone native `lazytui` CLI per platform (Bun `--compile`), no Node/Bun runtime needed. Bun cross-compiles all three from the single Linux runner. (darwin-x64 / windows-x64 are dropped — low demand for a terminal app.) | `curl` the one binary for your platform and run it; no `npm install`. |

The two tarballs split the runtime form (lean, publishable npm package) from the
developer/auditor form (complete, browsable source); the native binaries
(added by the bun/native-binary arc, v0.6.23) are the zero-dependency form for
users who just want to run the CLI. Each native target compiles independently —
a failed target logs a warning without failing the release.

## Release flow

1. Make sure `main` is green on CI.
2. Update `CHANGELOG.md`:
   - Rename `[Unreleased]` to `[X.Y.Z] — YYYY-MM-DD`.
   - Add a fresh empty `[Unreleased]` section above it.
   - Update the compare links at the bottom of the file.
3. Bump `package.json` `version` to `X.Y.Z`.
4. Commit:
   ```sh
   git add CHANGELOG.md package.json
   git commit -m "release: vX.Y.Z"
   git push origin main
   ```
5. Tag and push:
   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
6. The `.github/workflows/release.yml` workflow triggers automatically:
   - Runs the JS test suite against the tagged commit.
   - Builds the two tarballs and the three native binaries above (and
     smoke-runs the linux-x64 binary on the runner).
   - Creates a GitHub Release with auto-generated release notes
     (commits since the previous tag) and all five assets attached.
   - Marks the release as **pre-release** if the version has a
     hyphen (e.g. `v0.2.0-rc1`).

## If the release workflow fails

The tag is already pushed; the release didn't happen. Fix forward:

```sh
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z

# fix the thing, commit it
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Don't reuse a tag silently after a partial release; deletion + re-tag is
the visible record.

## Publishing to npm

As of v0.3.0, `package.json` has `"private": false` and
`release.yml` includes a `Publish to npm` step that runs after the
tarball build. The step is gated by
`if: ${{ !contains(github.ref, '-') && env.HAS_NPM_TOKEN == 'true' }}`,
so it runs only on a non-pre-release tag (`vX.Y.Z`, no hyphen) AND
only when the `NPM_TOKEN` repo secret is configured
(`HAS_NPM_TOKEN: ${{ secrets.NPM_TOKEN != '' }}`). A `vX.Y.Z-rc1` tag —
or any repo without the secret — still produces a GitHub Release for
download; the publish step simply **skips**, it does not fail.

**Prerequisite — one-time setup per repo:**
- Create an npm automation token at npmjs.com (Settings → Access
  Tokens → Generate New Token → Automation).
- Add it to the GitHub repo as a secret named `NPM_TOKEN`
  (Settings → Secrets and variables → Actions).

Without `NPM_TOKEN`, the publish step is **skipped** (the
`HAS_NPM_TOKEN` guard) — the workflow stays green and the GitHub
Release is still created with all five assets; the package just isn't
pushed to npm. (This is what happened for v0.6.5: shipped to GitHub,
not to npm.) To publish a release that went out without npm: add the
secret, then delete and re-push the tag (see "If the release workflow
fails" above), or run `npm publish` locally from the tagged commit.

**First publish:** if you want the extra safety of a manual sanity
check, run `npm publish` locally from the tagged commit before the
secret is wired up — that lets you eyeball npm's response without
the workflow racing it. Subsequent releases ride the workflow.

Single-runtime — the parser is in JS (`js/parser/`) so an
`npm install -g lazytui` user only needs Node ≥ 18.
