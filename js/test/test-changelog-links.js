/**
 * CHANGELOG structure guard — version headings vs. compare-link footer.
 *
 * RELEASING.md step 2 renames `[Unreleased]` to `[X.Y.Z] — date` and updates
 * the compare links at the bottom of CHANGELOG.md. Two drifts went unnoticed
 * for many releases:
 *   - the footer stopped at v0.6.49 (no links for 0.6.50..0.6.57, nor for
 *     0.6.0/0.6.1/0.6.33-35/0.6.37-42; `[Unreleased]` still compared from
 *     v0.6.49);
 *   - a feature commit landing right after a release rewrote the fresh
 *     `## [0.6.21]` / `## [0.6.22]` heading into its own `### Added`, folding
 *     a shipped section into the next release (their links went orphaned).
 *
 * Invariants:
 *   L1. `## [Unreleased]` is the first heading; version headings follow in
 *       strictly descending semver order, no duplicates.
 *   L2. The link footer lists the same versions as the headings, in the same
 *       order (an orphan link = a folded heading; a missing link = a skipped
 *       footer update).
 *   L3. `[Unreleased]` compares `v<newest version>...HEAD`.
 *   L4. Each version link compares `v<next-older version>...v<version>`, or is
 *       a `releases/tag/v<version>` link (the first releases, which have no
 *       meaningful predecessor on GitHub).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it, assert, eq, report } = require('./test-runner');

const TEXT = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
const LINES = TEXT.split('\n');

const SEMVER = /^\d+\.\d+\.\d+$/;
function cmp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

const headings = [];          // in file order: 'Unreleased' | 'X.Y.Z'
for (const l of LINES) {
  const m = /^## \[([^\]]+)\]/.exec(l);
  if (m) headings.push(m[1]);
}
const links = [];             // in file order: { name, url }
for (const l of LINES) {
  const m = /^\[([^\]]+)\]: (\S+)$/.exec(l);
  if (m && (m[1] === 'Unreleased' || SEMVER.test(m[1]))) links.push({ name: m[1], url: m[2] });
}
const versions = headings.filter(h => h !== 'Unreleased');

describe('L1 headings', () => {
  it('[Unreleased] is the first heading', () => {
    eq(headings[0], 'Unreleased', 'first ## heading');
    eq(headings.filter(h => h === 'Unreleased').length, 1, 'exactly one [Unreleased]');
  });
  it('version headings are semver, strictly descending', () => {
    for (const v of versions) assert(SEMVER.test(v), `heading [${v}] is X.Y.Z`);
    for (let i = 1; i < versions.length; i++) {
      assert(cmp(versions[i - 1], versions[i]) > 0,
        `[${versions[i - 1]}] above [${versions[i]}] (descending, no duplicates)`);
    }
  });
});

describe('L2 footer lists the same versions, same order', () => {
  it('every heading has a link and every link a heading', () => {
    const linkNames = links.filter(l => l.name !== 'Unreleased').map(l => l.name);
    const missing = versions.filter(v => !linkNames.includes(v));
    const orphan = linkNames.filter(n => !versions.includes(n));
    eq(missing, [], 'headings with no compare link');
    eq(orphan, [], 'compare links with no heading (folded section?)');
    eq(linkNames, versions, 'link order = heading order');
  });
});

const BASE = 'https://github.com/Tao-Ma/lazytui/';

describe('L3 [Unreleased] link', () => {
  it('compares the newest version to HEAD', () => {
    const u = links.find(l => l.name === 'Unreleased');
    assert(u, '[Unreleased]: link present');
    if (u) eq(u.url, `${BASE}compare/v${versions[0]}...HEAD`, '[Unreleased] base');
  });
});

describe('L4 version links', () => {
  it('compare from the next-older version, or tag-link the first releases', () => {
    for (const l of links) {
      if (l.name === 'Unreleased') continue;
      const i = versions.indexOf(l.name);
      if (i < 0) continue;                       // reported by L2
      if (l.url === `${BASE}releases/tag/v${l.name}`) continue;
      const prev = versions[i + 1];
      eq(l.url, `${BASE}compare/v${prev}...v${l.name}`, `[${l.name}] link`);
    }
  });
});

report();
