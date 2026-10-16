#!/usr/bin/env node
'use strict';

// Runs a script with Electron's bundled Node (ELECTRON_RUN_AS_NODE=1) instead of the
// system Node. better-sqlite3 is rebuilt for Electron's ABI by `postinstall`, so tests
// that load it fail under plain `node` with NODE_MODULE_VERSION errors.
//
// Usage: node scripts/run-electron-node.js <script.js> [args...]
// Works the same on Windows, macOS and Linux (no shell env-var syntax needed).

const { spawnSync } = require('child_process');
const electronPath = require('electron');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/run-electron-node.js <script.js> [args...]');
  process.exit(2);
}

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const result = spawnSync(electronPath, args, { stdio: 'inherit', env });

if (result.error) {
  console.error('Failed to start Electron:', result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
