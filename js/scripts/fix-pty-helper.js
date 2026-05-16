#!/usr/bin/env node
/**
 * Restore the exec bit on node-pty's spawn-helper binary.
 *
 * Some npm-install paths drop the +x bit during tarball extraction
 * (depends on the local tar tool — observed on macOS with default
 * BSD tar). Without it, `pty.spawn` fails immediately with
 * "posix_spawnp failed" because node-pty execs the helper to set up
 * the PTY before the actual shell runs.
 *
 * Idempotent — wired as a postinstall hook so every fresh `npm install`
 * lands a working binary. No-op on Windows (no spawn-helper there).
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Locate node_modules by walking up from this script. Works whether
// the package lives at the repo root (root/node_modules/) or under
// js/ (js/node_modules/, historical layout).
function findNodeModules(startDir) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

const nm = findNodeModules(__dirname);
if (!nm) process.exit(0);
const prebuilds = path.join(nm, 'node-pty', 'prebuilds');
if (!fs.existsSync(prebuilds)) process.exit(0);

for (const arch of fs.readdirSync(prebuilds)) {
  const helper = path.join(prebuilds, arch, 'spawn-helper');
  if (!fs.existsSync(helper)) continue;
  try {
    fs.chmodSync(helper, 0o755);
  } catch (e) {
    // Permission errors / read-only volumes / Windows — log and move on.
    console.warn(`fix-pty-helper: could not chmod ${helper}: ${e.message}`);
  }
}
