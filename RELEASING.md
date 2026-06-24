# Releasing lazytui

Maintainer's release process. End users don't need to read this.

## Versioning

lazytui follows [SemVer](https://semver.org/). Pre-1.0 is still a moving
target — breaking changes can land in minor bumps, truly experimental
things in patch bumps. After v1.0.0, strict semver applies.

## Artifacts produced by a release

Every release builds **two tarballs**, both attached to the GitHub Release:

| Artifact | Contents | Use case |
|---|---|---|
| `lazytui-X.Y.Z.tgz` | npm-style package. Runtime + parser + docs only (no tests, no demos, no `.github/`). 78 files / ~170 kB. | `npm install` from URL; future `npm install -g lazytui` once we publish. |
| `lazytui-X.Y.Z-source.tar.gz` | Full source archive of the tagged commit (`git archive HEAD`). Includes tests, demos, CI configs — everything that's in git. | Read-only mirror of the tag for users who can't or don't want to `git clone`. |

The split exists because the npm tarball is the runtime form (lean,
publishable) while the source tarball is the developer/auditor form
(complete, browsable).

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
   - Builds the two tarballs above.
   - Creates a GitHub Release with auto-generated release notes
     (commits since the previous tag) and both tarballs attached.
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
Release is still created with both tarballs; the package just isn't
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
