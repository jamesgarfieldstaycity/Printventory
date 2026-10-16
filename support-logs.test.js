#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createCapture,
  redactLogText,
  readLogTail,
  logsZipFilename
} = require('./support-logs');

// Fake Shopify tokens are assembled at runtime so no token-shaped literal sits in the
// source (GitHub push protection flags them).
const shp = (kind, body) => ['shp', kind, '_', body].join('');
const FAKE_AT = shp('at', '0'.repeat(32));
const FAKE_CA = shp('ca', 'AbCdEf123456');
const FAKE_SS = shp('ss', 'zzzz9999');
const FAKE_PA = shp('pa', 'qq11');

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL ${name}:`, err);
      process.exitCode = 1;
    });
}

async function main() {
  await test('redacts webhook urls and api keys', () => {
    const input = 'hook https://discord.com/api/webhooks/123/abcdefghijklmnop key sk-proj-abcdefghijklmnopqrstuvwxyz Authorization: Bearer super-secret.token';
    const output = redactLogText(input);
    assert.strictEqual(output.includes('abcdefghijklmnop'), false);
    assert.strictEqual(output.includes('sk-proj-'), false);
    assert.strictEqual(output.includes('super-secret'), false);
    assert.ok(output.includes('[discord-webhook]'));
    assert.ok(output.includes('[api-key]'));
    assert.ok(output.includes('Bearer [redacted]'));
  });

  await test('reads only the tail of a log file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printventory-logs-'));
    const file = path.join(dir, 'app.log');
    fs.writeFileSync(file, `HEAD\n${'x'.repeat(100)}\nTAIL`);
    const tail = readLogTail(file, 20);
    assert.ok(tail.startsWith('[earlier log truncated]'));
    assert.ok(tail.endsWith('TAIL'));
    assert.strictEqual(tail.includes('HEAD'), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('zip contains app logs and console logs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printventory-logs-'));
    const capture = createCapture();
    capture.appendApp('info', ['starting', 'sk-abcdefghijklmnopqrstuvwxyz']);
    capture.appendConsole('warning', 'renderer failed https://discord.com/api/webhooks/9/tokentokentoken', 'renderer.js', 12);
    capture.openLogDirectory(dir);
    const zipBuffer = await capture.createLogsZip('9.9.9');
    assert.ok(zipBuffer.slice(0, 2).toString() === 'PK');
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(zipBuffer);
    const appLog = await zip.file('app.log').async('string');
    const consoleLog = await zip.file('console.log').async('string');
    const system = await zip.file('system.txt').async('string');
    assert.ok(appLog.includes('starting'));
    assert.strictEqual(appLog.includes('sk-abcdefghijklmnopqrstuvwxyz'), false);
    assert.ok(appLog.includes('[api-key]'));
    assert.ok(consoleLog.includes('renderer failed'));
    assert.ok(consoleLog.includes('renderer.js:12'));
    assert.strictEqual(consoleLog.includes('tokentokentoken'), false);
    assert.ok(system.includes('Printventory 9.9.9'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('redacts Shopify tokens by prefix', () => {
    const input = `token ${FAKE_AT} and ${FAKE_CA} and ${FAKE_SS} and ${FAKE_PA}`;
    const output = redactLogText(input);
    for (const secret of [FAKE_AT, FAKE_CA, FAKE_SS, FAKE_PA]) {
      assert.strictEqual(output.includes(secret), false, secret);
    }
    assert.strictEqual(output.split('[shopify-token]').length - 1, 4);
  });

  await test('redacts access_token / client_secret fields in JSON, inspect, form and header forms', () => {
    const cases = [
      '{"access_token":"abc123SECRET","scope":"read_orders","expires_in":86399}',
      "{ access_token: 'abc123SECRET', scope: 'x' }",
      'grant_type=client_credentials&client_id=pub&client_secret=abc123SECRET&x=1',
      'X-Shopify-Access-Token: abc123SECRET',
      'Shopify OAuth error: No access_token in response - {\\"access_token\\":\\"abc123SECRET\\"}',
      '"client_secret": "abc123SECRET"'
    ];
    for (const input of cases) {
      const output = redactLogText(input);
      assert.strictEqual(output.includes('abc123SECRET'), false, `leaked in: ${input} -> ${output}`);
      assert.ok(output.includes('[redacted]'), output);
    }
    // non-secret neighbours are preserved
    const kept = redactLogText('{"access_token":"abc123SECRET","scope":"read_orders","expires_in":86399}');
    assert.ok(kept.includes('"scope":"read_orders"') && kept.includes('86399'));
    assert.strictEqual(redactLogText('client_id=pub'), 'client_id=pub');
  });

  await test('zip redacts Shopify tokens already sitting in older log files on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printventory-logs-'));
    fs.writeFileSync(path.join(dir, 'app.log'), '2026-10-01T00:00:00.000Z [info] [Shopify] Response body: {"access_token":"' + shp('at', 'OLDLEAK1234567890') + '","scope":"read_orders"}' + String.fromCharCode(10));
    const capture = createCapture();
    capture.openLogDirectory(dir);
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(await capture.createLogsZip('1.0.0'));
    const appLog = await zip.file('app.log').async('string');
    assert.strictEqual(appLog.includes('OLDLEAK'), false);
    assert.ok(appLog.includes('read_orders'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('logs written through capture are redacted at write time', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printventory-logs-'));
    const capture = createCapture();
    capture.openLogDirectory(dir);
    capture.appendApp('info', ['[Shopify] Response body:', '{"access_token":"' + shp('at', 'LIVE1234567890') + '"}']);
    capture.appendConsole('info', 'client_secret=topsecretvalue', 'renderer.js', 1);
    return new Promise((resolve) => setTimeout(resolve, 100)).then(() => {
      const app = fs.readFileSync(path.join(dir, 'app.log'), 'utf8');
      const con = fs.readFileSync(path.join(dir, 'console.log'), 'utf8');
      assert.strictEqual(app.includes('LIVE1234567890'), false);
      assert.strictEqual(con.includes('topsecretvalue'), false);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  await test('logsZipFilename is a timestamped .zip', () => {
    assert.match(logsZipFilename(new Date('2026-10-16T09:08:07.123Z')), /^printventory-logs-20261016T090807Z.zip$/);
  });

  await test('Save Logs: cancelling the dialog writes nothing', async () => {
    const capture = createCapture();
    let boxes = 0;
    const result = await capture.saveLogs({
      version: '1.0.0',
      dialog: {
        async showSaveDialog() { return { canceled: true }; },
        async showMessageBox() { boxes += 1; return { response: 0 }; }
      }
    });
    assert.strictEqual(result.saved, false);
    assert.strictEqual(boxes, 0);
  });

  await test('Save Logs: writes a redacted zip to the chosen path and uploads nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printventory-logs-'));
    const target = path.join(dir, 'out.zip');
    const capture = createCapture();
    capture.appendApp('error', ['disk full', shp('at', 'SAVEME1234567890')]);
    capture.openLogDirectory(path.join(dir, 'logs'));
    const messages = [];
    const result = await capture.saveLogs({
      version: '2.2.17',
      dialog: {
        async showSaveDialog(_parent, options) {
          assert.ok(options.defaultPath.endsWith('.zip'));
          return { canceled: false, filePath: target };
        },
        async showMessageBox(_parent, options) { messages.push(options); return { response: 0 }; }
      }
    });
    assert.deepStrictEqual({ saved: result.saved, filePath: result.filePath }, { saved: true, filePath: target });
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(target));
    const appLog = await zip.file('app.log').async('string');
    assert.ok(appLog.includes('disk full'));
    assert.strictEqual(appLog.includes('SAVEME'), false);
    assert.ok((await zip.file('system.txt').async('string')).includes('Printventory 2.2.17'));
    assert.strictEqual(messages[0].type, 'info');
    assert.strictEqual(/discord/i.test(JSON.stringify(messages)), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('Save Logs: a write failure is reported, not thrown', async () => {
    const capture = createCapture();
    const messages = [];
    const result = await capture.saveLogs({
      version: '1.0.0',
      dialog: {
        async showSaveDialog() { return { canceled: false, filePath: path.join(os.tmpdir(), 'pv-no-such-dir-xyz', 'out.zip') }; },
        async showMessageBox(_parent, options) { messages.push(options); return { response: 0 }; }
      }
    });
    assert.strictEqual(result.saved, false);
    assert.ok(result.error);
    assert.strictEqual(messages[0].type, 'error');
  });

  await test('Discord upload is gone', () => {
    const capture = createCapture();
    assert.strictEqual(capture.confirmAndSend, undefined);
    const mod = require('./support-logs');
    assert.strictEqual(mod.buildDiscordMultipart, undefined);
    assert.strictEqual(mod.resolveDiscordWebhookUrl, undefined);
  });
}

main();
