#!/usr/bin/env node
'use strict';

// getAccessToken must never print the client secret or the access token it receives.

const assert = require('assert');
const shopify = require('./shopify');

const SECRET = 'sup3r/secret+value=with&chars';
// Built at runtime so no token-shaped literal sits in the source (GitHub push protection).
const TOKEN_BODY = 'a1b2c3d4'.repeat(4);
const TOKEN = 'shp' + 'at_' + TOKEN_BODY;

async function capture(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const level of Object.keys(orig)) {
    console[level] = (...args) => lines.push(args.map(String).join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return lines.join('\n');
}

async function main() {
  const realFetch = global.fetch;
  let failures = 0;
  const run = async (name, fn) => {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL ${name}:`, err.message);
    }
  };

  await run('successful token request logs neither the secret nor the token', async () => {
    shopify.clearTokenCache('example.myshopify.com', 'client-a');
    global.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ access_token: TOKEN, scope: 'read_orders', expires_in: 86399 })
    });
    let result;
    const output = await capture(async () => {
      result = await shopify.getAccessToken('example.myshopify.com', 'client-a', SECRET);
    });
    assert.strictEqual(result, TOKEN);
    assert.strictEqual(output.includes(TOKEN), false, 'access token leaked');
    assert.strictEqual(output.includes(TOKEN_BODY.slice(0, 16)), false, 'access token fragment leaked');
    assert.strictEqual(output.includes(SECRET), false, 'client secret leaked');
    assert.strictEqual(output.includes(encodeURIComponent(SECRET)), false, 'encoded client secret leaked');
    assert.ok(output.includes('200'), 'status should still be logged');
  });

  await run('failed token request still logs status and an error body, but no secret', async () => {
    shopify.clearTokenCache('example.myshopify.com', 'client-b');
    global.fetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"error":"invalid_client"}'
    });
    let thrown;
    const output = await capture(async () => {
      try {
        await shopify.getAccessToken('example.myshopify.com', 'client-b', SECRET);
      } catch (err) {
        thrown = err;
      }
    });
    assert.ok(thrown && /401/.test(thrown.message));
    assert.ok(output.includes('401') && output.includes('invalid_client'));
    assert.strictEqual(output.includes(SECRET), false);
  });

  global.fetch = realFetch;
  if (failures) process.exit(1);
}

main();
