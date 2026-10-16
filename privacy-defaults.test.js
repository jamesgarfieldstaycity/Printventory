#!/usr/bin/env node
'use strict';

// New installs must not phone home: usage reporting and the printventory.com
// version check are opt-in. main.js is Electron-bound, so assert on its source.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const main = read('main.js');
const html = read('index.html');
const preload = read('preload.js');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}:`, err.message);
  }
}

test('CollectUsage defaults to off for new installs', () => {
  assert.ok(/key: 'CollectUsage', value: '0'/.test(main));
  assert.strictEqual(/key: 'CollectUsage', value: '1'/.test(main), false);
});

test('automatic update check has its own default-off setting', () => {
  assert.ok(/key: 'checkForUpdatesOnStartup', value: '0'/.test(main));
});

test('startup version check is gated on the setting', () => {
  const start = main.indexOf('isAutomaticUpdateCheckEnabled()) {');
  const call = main.indexOf('checkForUpdates().catch');
  assert.ok(start !== -1 && call !== -1 && start < call, 'startup call must sit behind the gate');
});

test('check-for-updates IPC only runs unattended checks when enabled', () => {
  const handler = main.slice(main.indexOf("ipcMain.handle('check-for-updates'"));
  const gate = handler.indexOf('!manual && !isAutomaticUpdateCheckEnabled()');
  const fetchCall = handler.indexOf('checkForUpdates(isBeta, manual)');
  assert.ok(gate !== -1 && fetchCall !== -1 && gate < fetchCall);
});

test('preload forwards the manual flag', () => {
  assert.ok(preload.includes("ipcRenderer.invoke('check-for-updates', isBeta, manual)"));
});

test('About dialog checkboxes are not pre-checked and the toggle exists', () => {
  assert.strictEqual(/id="collect-usage"[^>]*checked/.test(html), false);
  assert.ok(/id="check-updates-on-startup"/.test(html));
  assert.strictEqual(/id="check-updates-on-startup"[^>]*checked/.test(html), false);
  assert.ok(/id="check-updates-now"/.test(html));
});

if (failures) process.exit(1);
