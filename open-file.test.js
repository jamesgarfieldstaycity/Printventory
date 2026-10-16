#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isLoopbackAddress, blockedExtension, openFileOnHost, resolveOpenTarget } = require('./core/open-file');

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok ${name}`))
    .catch((err) => {
      console.error(`FAIL ${name}:`, err);
      process.exitCode = 1;
    });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-open-file-'));
  const model = path.join(dir, 'thing.3mf');
  fs.writeFileSync(model, 'x');

  await test('isLoopbackAddress accepts only loopback forms', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) {
      assert.strictEqual(isLoopbackAddress(a), true, a);
    }
    for (const a of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', 'fe80::1', '', null, undefined, '1127.0.0.1', '127.0.0.1.evil.com']) {
      assert.strictEqual(isLoopbackAddress(a), false, String(a));
    }
  });

  await test('resolveOpenTarget: desktop and loopback open on host; remote must choose', () => {
    assert.strictEqual(resolveOpenTarget({ isServerMode: false, clientAddress: null }), 'host');
    assert.strictEqual(resolveOpenTarget({ isServerMode: true, clientAddress: '::1' }), 'host');
    assert.strictEqual(resolveOpenTarget({ isServerMode: true, clientAddress: '192.168.1.20' }), 'choice');
    assert.strictEqual(resolveOpenTarget({ isServerMode: true, clientAddress: null }), 'choice');
    assert.strictEqual(resolveOpenTarget({ isServerMode: true, clientAddress: '192.168.1.20', requestedTarget: 'server' }), 'host');
  });

  await test('missing file returns success:false with path and never calls shell', async () => {
    let called = false;
    const logs = [];
    const missing = path.join(dir, 'nope.3mf');
    const res = await openFileOnHost(missing, { shell: { openPath: async () => { called = true; return ''; } }, fs, log: (m) => logs.push(m) });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.path, missing);
    assert.match(res.error, /not found/i);
    assert.strictEqual(called, false);
    assert.ok(logs.some((l) => l.includes('FAILED') && l.includes('nope.3mf')));
  });

  await test("shell.openPath's returned error string is surfaced", async () => {
    const res = await openFileOnHost(model, { shell: { openPath: async () => 'No application is associated with this file' }, fs });
    assert.deepStrictEqual(res, { success: false, error: 'No application is associated with this file', path: model });
  });

  await test('shell.openPath rejection is surfaced, not thrown', async () => {
    const res = await openFileOnHost(model, { shell: { openPath: async () => { throw new Error('boom'); } }, fs });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'boom');
  });

  await test('success returns path and logs the attempt', async () => {
    const logs = [];
    const res = await openFileOnHost(model, { shell: { openPath: async () => '' }, fs, log: (m) => logs.push(m), context: 'client=::1' });
    assert.deepStrictEqual(res, { success: true, path: model });
    assert.ok(logs.some((l) => l.includes('[OpenFile] client=::1') && l.includes('OK')));
  });

  await test('directories and empty paths are rejected', async () => {
    const shell = { openPath: async () => '' };
    assert.strictEqual((await openFileOnHost(dir, { shell, fs })).success, false);
    assert.strictEqual((await openFileOnHost('', { shell, fs })).success, false);
    assert.strictEqual((await openFileOnHost(null, { shell, fs })).success, false);
  });

  await test('executable/script extensions are refused', async () => {
    const exe = path.join(dir, 'run.EXE');
    fs.writeFileSync(exe, 'x');
    let called = false;
    const res = await openFileOnHost(exe, { shell: { openPath: async () => { called = true; return ''; } }, fs });
    assert.strictEqual(res.success, false);
    assert.strictEqual(called, false);
    assert.strictEqual(blockedExtension('a.3mf'), null);
    assert.strictEqual(blockedExtension('C:\\x\\y.ps1'), '.ps1');
  });

  await test('desktop Open File (renderer and native context menu) goes through the shared host-open path', () => {
    const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const fn = renderer.slice(renderer.indexOf('window.openModelFile = async'));
    const desktopBranch = fn.slice(0, fn.indexOf('let result = await openViaServer'));
    assert.ok(desktopBranch.includes("executeClientCommand({ type: 'open-file'"));
    assert.strictEqual(desktopBranch.includes('electron.openPath('), false, 'desktop must not call the unchecked open-path IPC');
    assert.ok(/openPathsOnHost\(filePaths\.slice\(\)/.test(main), 'context menu must use openPathsOnHost');
    assert.strictEqual(/await shell\.openPath\(filePath\)/.test(main), false, 'no unchecked shell.openPath(filePath) left');
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

main();
