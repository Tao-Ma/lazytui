/**
 * Feature-module groupActions resolve in the TUI, not just the CLI.
 *
 * Regression guard for a CLI/TUI drift: the feature plugins (`archive`,
 * `config-branch`, `image-backup`) export only `{ name, groupActions }` — they
 * are NOT Components (no `init`/`update`), so `registerComponent` rejects them,
 * and the TUI's `getGroupActions` (which iterates the Component registry) never
 * saw their synthesized actions. The CLI, by contrast, merged them from its own
 * `BUILT_IN_PLUGINS` list — so `lazytui --list` showed a `config_branch` group's
 * save/load/check-stale while the TUI Actions pane showed only the declared
 * `actions:` (often just an About). A group whose work comes from a feature
 * plugin looked empty/broken in the TUI.
 *
 * The fix single-sources the feature-plugin list (`js/feature/plugins.js`) and
 * has BOTH paths consume it: the CLI via `_mergeForGroup`, the TUI via
 * `api.registerGroupActionPlugin` (a registry `getGroupActions` also consults,
 * alongside Components). This pins (a) the TUI now resolves each feature's
 * actions and (b) the two paths read the identical list, so the drift can't
 * silently return.
 *
 * Run: node js/test/test-group-action-plugins.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const api = require('../panel/api');
const { getModel } = require('../model/store');
const featurePlugins = require('../feature/plugins');   // THE single source of groupAction plugins

const G = (name, o) => ({
  name, label: name, containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false, ...o,
});

function setConfig() {
  getModel().config = {
    project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
    groups: {
      cb: G('cb', {
        config_branch: { branch: 'config', paths: ['a.txt', 'b.txt'] },
        actions: { info: { label: 'About', type: 'run', script: 'echo about' } },
      }),
      ar: G('ar', { archive: { target: 'src', name: 'backup' } }),
      im: G('im', { images: { list: ['alpine:3'] } }),
    },
  };
}

describe('[group-action-plugins] feature groupActions resolve in the TUI (CLI/TUI parity)', () => {
  // Register the feature plugins the way the TUI boot does — the exact set the
  // CLI merges, read from the single source.
  for (const p of featurePlugins) api.registerGroupActionPlugin(p);

  it('config_branch group exposes save/load/check-stale (+ declared About)', () => {
    setConfig();
    const keys = Object.keys(api.getMergedActions('cb'));
    for (const a of ['save', 'load', 'check-stale', 'info']) {
      assert(keys.includes(a), `getMergedActions(cb) has "${a}" — got ${JSON.stringify(keys)}`);
    }
  });

  it('archive group exposes archive/verify', () => {
    setConfig();
    const keys = Object.keys(api.getMergedActions('ar'));
    for (const a of ['archive', 'verify']) {
      assert(keys.includes(a), `getMergedActions(ar) has "${a}" — got ${JSON.stringify(keys)}`);
    }
  });

  it('image-backup group exposes save/load', () => {
    setConfig();
    const keys = Object.keys(api.getMergedActions('im'));
    for (const a of ['save', 'load']) {
      assert(keys.includes(a), `getMergedActions(im) has "${a}" — got ${JSON.stringify(keys)}`);
    }
  });

  it('CLI and TUI read the SAME feature-plugin set (no drift)', () => {
    const cli = require('../app/cli');
    const cliNames = (cli.FEATURE_PLUGINS || []).map((p) => p.name).sort();
    const tuiNames = featurePlugins.map((p) => p.name).sort();
    eq(cliNames, tuiNames, 'CLI BUILT_IN feature plugins === the TUI-registered feature plugins');
    eq(tuiNames, ['archive', 'config-branch', 'image-backup'], 'the three feature plugins are present');
  });
});

report();
