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

## Publishing to npm (not yet enabled)

`package.json` currently has `"private": true`, so `npm publish` would
refuse. When ready to ship to npm:

1. Set `"private": false` (or remove the field) in `package.json`.
2. Add an `npm publish` step to `release.yml` after the tarball build:
   ```yaml
   - uses: actions/setup-node@v4
     with:
       node-version: '22'
       registry-url: 'https://registry.npmjs.org'
   - run: npm publish
     env:
       NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```
3. Create an `NPM_TOKEN` secret in the GitHub repo settings (npm
   automation token from npmjs.com).
4. First publish: `npm publish` from a tagged commit locally to make
   sure the package metadata is right.

Single-runtime now — the parser is in JS (`js/parser/`) so an
`npm install -g lazytui` user only needs Node ≥ 18. `package.json`
still carries `"private": true` while the publish flow stabilizes;
flipping that to false is all that's needed to enable
`npm publish`.
