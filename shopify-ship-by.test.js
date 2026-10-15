'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pickShipBy,
  addBusinessDays,
  resolveShipBy,
  normalizeProcessingDays,
  dateInputToNoonIso,
  setShopifyOrderShipBy,
  syncShopifyOrders,
  DEFAULT_PROCESSING_DAYS
} = require('./core/shopify-orders');
const shopifyApi = require('./shopify');
const { ensureShopifyTablesExist } = require('./core/schema');

test('returns null when the order has no fulfillment orders', () => {
  assert.equal(pickShipBy({}), null);
  assert.equal(pickShipBy({ fulfillmentOrders: [] }), null);
  assert.equal(pickShipBy(null), null);
});

test('returns null when no fulfillment order has a fulfillBy', () => {
  assert.equal(pickShipBy({ fulfillmentOrders: [{ status: 'OPEN', fulfillBy: null }] }), null);
});

test('returns the fulfillBy of a single open fulfillment order', () => {
  const order = { fulfillmentOrders: [{ status: 'OPEN', fulfillBy: '2026-10-20T23:00:00Z' }] };
  assert.equal(pickShipBy(order), '2026-10-20T23:00:00Z');
});

test('picks the earliest fulfillBy across active fulfillment orders', () => {
  const order = {
    fulfillmentOrders: [
      { status: 'OPEN', fulfillBy: '2026-10-22T00:00:00Z' },
      { status: 'IN_PROGRESS', fulfillBy: '2026-10-20T00:00:00Z' }
    ]
  };
  assert.equal(pickShipBy(order), '2026-10-20T00:00:00Z');
});

test('ignores closed/cancelled fulfillment orders while an active one has a date', () => {
  const order = {
    fulfillmentOrders: [
      { status: 'CLOSED', fulfillBy: '2026-10-01T00:00:00Z' },
      { status: 'CANCELLED', fulfillBy: '2026-10-02T00:00:00Z' },
      { status: 'OPEN', fulfillBy: '2026-10-25T00:00:00Z' }
    ]
  };
  assert.equal(pickShipBy(order), '2026-10-25T00:00:00Z');
});

test('falls back to closed fulfillment orders so a shipped order keeps its ship-by', () => {
  const order = { fulfillmentOrders: [{ status: 'CLOSED', fulfillBy: '2026-10-01T00:00:00Z' }] };
  assert.equal(pickShipBy(order), '2026-10-01T00:00:00Z');
});

test('skips unparseable dates', () => {
  const order = {
    fulfillmentOrders: [
      { status: 'OPEN', fulfillBy: 'not-a-date' },
      { status: 'OPEN', fulfillBy: '2026-10-21T00:00:00Z' }
    ]
  };
  assert.equal(pickShipBy(order), '2026-10-21T00:00:00Z');
});

// --- Estimated ship-by (QuickSync/Etsy orders have no fulfillBy) ---
// 2026-10-15 is a Thursday. Built from local-time parts so the tests hold in any timezone.
const local = (y, m, d, h = 10) => new Date(y, m - 1, d, h, 0, 0).toISOString();
const ymd = (iso) => {
  const d = new Date(iso);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
};

test('addBusinessDays: Thursday + 3 business days lands the following Tuesday', () => {
  assert.deepEqual(ymd(addBusinessDays(local(2026, 10, 15), 3)), [2026, 10, 20]);
});

test('addBusinessDays: Friday + 3 skips the weekend (Wednesday)', () => {
  assert.deepEqual(ymd(addBusinessDays(local(2026, 10, 16), 3)), [2026, 10, 21]);
});

test('addBusinessDays: weekend orders count from the next business day', () => {
  assert.deepEqual(ymd(addBusinessDays(local(2026, 10, 17), 3)), [2026, 10, 21]); // Sat
  assert.deepEqual(ymd(addBusinessDays(local(2026, 10, 18), 1)), [2026, 10, 19]); // Sun
});

test('addBusinessDays: 0 days is the order day itself; 5 is one full week', () => {
  assert.deepEqual(ymd(addBusinessDays(local(2026, 10, 15), 0)), [2026, 10, 15]);
  assert.deepEqual(ymd(addBusinessDays(local(2026, 10, 15), 5)), [2026, 10, 22]);
});

test('addBusinessDays: result is local noon, independent of order time of day', () => {
  const late = addBusinessDays(local(2026, 10, 15, 23), 3);
  const early = addBusinessDays(local(2026, 10, 15, 0), 3);
  assert.equal(late, early);
  assert.equal(new Date(late).getHours(), 12);
});

test('addBusinessDays: null for a missing or invalid order date', () => {
  assert.equal(addBusinessDays(null, 3), null);
  assert.equal(addBusinessDays('nope', 3), null);
});

test('normalizeProcessingDays: whole number 0-30, default for junk', () => {
  assert.equal(normalizeProcessingDays(3), 3);
  assert.equal(normalizeProcessingDays('5'), 5);
  assert.equal(normalizeProcessingDays(2.9), 2);
  assert.equal(normalizeProcessingDays(0), 0);
  assert.equal(normalizeProcessingDays(99), 30);
  assert.equal(normalizeProcessingDays(-1), DEFAULT_PROCESSING_DAYS);
  assert.equal(normalizeProcessingDays('abc'), DEFAULT_PROCESSING_DAYS);
  assert.equal(normalizeProcessingDays(undefined), DEFAULT_PROCESSING_DAYS);
});

test('resolveShipBy: no fulfillBy -> estimated from the order date', () => {
  const order = { createdAt: local(2026, 10, 15), fulfillmentOrders: [{ status: 'OPEN', fulfillBy: null }] };
  const r = resolveShipBy(order, 3);
  assert.equal(r.source, 'estimated');
  assert.deepEqual(ymd(r.shipBy), [2026, 10, 20]);
});

test('resolveShipBy: a real fulfillBy overrides the estimate', () => {
  const order = {
    createdAt: local(2026, 10, 15),
    fulfillmentOrders: [{ status: 'OPEN', fulfillBy: '2026-10-19T00:00:00Z' }]
  };
  assert.deepEqual(resolveShipBy(order, 3), { shipBy: '2026-10-19T00:00:00Z', source: 'shopify' });
});

test('resolveShipBy: same order flips estimated -> shopify when fulfillBy appears on a later sync', () => {
  const base = { createdAt: local(2026, 10, 15), fulfillmentOrders: [{ status: 'OPEN', fulfillBy: null }] };
  assert.equal(resolveShipBy(base, 3).source, 'estimated');
  base.fulfillmentOrders[0].fulfillBy = '2026-10-21T00:00:00Z';
  assert.equal(resolveShipBy(base, 3).source, 'shopify');
});

test('resolveShipBy: no fulfillBy and no order date -> nothing (never invents a date)', () => {
  assert.deepEqual(resolveShipBy({ fulfillmentOrders: [] }, 3), { shipBy: null, source: null });
});

// ---- Manual override precedence: manual > Shopify fulfillBy > estimate ----

const MANUAL = '2026-10-30T12:00:00.000Z';
const orderWith = (fulfillBy) => ({
  createdAt: local(2026, 10, 15),
  fulfillmentOrders: [{ status: 'OPEN', fulfillBy }]
});

test('resolveShipBy: manual beats the estimate', () => {
  assert.deepEqual(resolveShipBy(orderWith(null), 3, MANUAL), { shipBy: MANUAL, source: 'manual' });
});

test('resolveShipBy: manual beats a real Shopify fulfillBy', () => {
  assert.deepEqual(resolveShipBy(orderWith('2026-10-19T00:00:00Z'), 3, MANUAL), { shipBy: MANUAL, source: 'manual' });
});

test('resolveShipBy: manual is not replaced when a real fulfillBy appears on a later sync', () => {
  const order = orderWith(null);
  assert.equal(resolveShipBy(order, 3, MANUAL).source, 'manual');
  order.fulfillmentOrders[0].fulfillBy = '2026-10-21T00:00:00Z';
  assert.deepEqual(resolveShipBy(order, 3, MANUAL), { shipBy: MANUAL, source: 'manual' });
});

test('resolveShipBy: manual is not replaced when the processing-days setting changes', () => {
  assert.equal(resolveShipBy(orderWith(null), 1, MANUAL).shipBy, MANUAL);
  assert.equal(resolveShipBy(orderWith(null), 10, MANUAL).shipBy, MANUAL);
});

test('resolveShipBy: no manual -> Shopify beats estimate (full precedence order)', () => {
  assert.equal(resolveShipBy(orderWith('2026-10-19T00:00:00Z'), 3, null).source, 'shopify');
  assert.equal(resolveShipBy(orderWith(null), 3, null).source, 'estimated');
  assert.equal(resolveShipBy(orderWith(null), 3, undefined).source, 'estimated');
});

test('resolveShipBy: an unparseable stored manual value falls through rather than poisoning the order', () => {
  assert.equal(resolveShipBy(orderWith(null), 3, 'not-a-date').source, 'estimated');
});

test('dateInputToNoonIso: accepts a real calendar date as local noon', () => {
  assert.deepEqual(ymd(dateInputToNoonIso('2026-10-30')), [2026, 10, 30]);
  assert.equal(new Date(dateInputToNoonIso('2026-10-30')).getHours(), 12);
  assert.deepEqual(ymd(dateInputToNoonIso('2028-02-29')), [2028, 2, 29]);
});

test('dateInputToNoonIso: rejects impossible dates, blanks and other formats', () => {
  const bad = ['2026-02-30', '2027-02-29', '2026-13-01', '', '  ', null, undefined, '30/10/2026', '2026-1-5', '2026-10-30T00:00:00Z', 'tomorrow'];
  for (const value of bad) {
    assert.equal(dateInputToNoonIso(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

// ---- DB-backed: sync + setShopifyOrderShipBy ----
// better-sqlite3 here is built for Electron's ABI, so under plain Node it
// cannot load and these are skipped. Run them with:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe shopify-ship-by.test.js
let Database = null;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (_) {
  Database = null;
}
const dbTest = Database ? test : test.skip;

function makeDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, filePath TEXT, fileName TEXT)');
  ensureShopifyTablesExist(db);
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  set.run('shopifyStoreDomain', 'test.myshopify.com');
  set.run('shopifyClientId', 'id');
  set.run('shopifyClientSecret', 'secret');
  return db;
}

function stubFetchOrders(orders) {
  const original = shopifyApi.fetchOrders;
  shopifyApi.fetchOrders = async () => orders;
  return () => { shopifyApi.fetchOrders = original; };
}

const fetched = (fulfillBy) => ({
  id: 'gid://shopify/Order/1',
  name: '#1001',
  createdAt: local(2026, 10, 15),
  customerName: 'Test',
  totalAmount: '10.00',
  totalCurrency: 'GBP',
  financialStatus: 'PAID',
  fulfillmentStatus: 'UNFULFILLED',
  fulfillmentOrders: [{ status: 'OPEN', fulfillBy }],
  lineItems: []
});

const readOrder = (db) => db.prepare('SELECT * FROM shopify_orders WHERE shopify_order_gid = ?').get('gid://shopify/Order/1');

dbTest('sync stores the estimate as effective and automatic ship-by', async () => {
  const db = makeDb();
  const restore = stubFetchOrders([fetched(null)]);
  try {
    await syncShopifyOrders(db, () => {});
    const row = readOrder(db);
    assert.equal(row.ship_by_source, 'estimated');
    assert.equal(row.ship_by_auto_source, 'estimated');
    assert.equal(row.ship_by, row.ship_by_auto);
  } finally { restore(); db.close(); }
});

dbTest('manual override survives later syncs, even when Shopify supplies a fulfillBy', async () => {
  const db = makeDb();
  let restore = stubFetchOrders([fetched(null)]);
  try {
    await syncShopifyOrders(db, () => {});
    const id = readOrder(db).id;
    const r = await setShopifyOrderShipBy(db, { orderId: id, date: '2026-10-30' });
    assert.equal(r.success, true);
    assert.equal(r.source, 'manual');

    await syncShopifyOrders(db, () => {}); // same data
    let row = readOrder(db);
    assert.equal(row.ship_by_source, 'manual');
    assert.deepEqual(ymd(row.ship_by), [2026, 10, 30]);
    assert.equal(row.ship_by_auto_source, 'estimated');

    restore();
    restore = stubFetchOrders([fetched('2026-10-19T00:00:00Z')]); // Shopify now has a real date
    await syncShopifyOrders(db, () => {});
    row = readOrder(db);
    assert.equal(row.ship_by_source, 'manual');
    assert.deepEqual(ymd(row.ship_by), [2026, 10, 30]);
    assert.equal(row.ship_by_auto_source, 'shopify');
    assert.equal(row.ship_by_auto, '2026-10-19T00:00:00Z');
  } finally { restore(); db.close(); }
});

dbTest('Clear override restores the latest automatic value without a network call', async () => {
  const db = makeDb();
  let restore = stubFetchOrders([fetched(null)]);
  try {
    await syncShopifyOrders(db, () => {});
    const id = readOrder(db).id;
    await setShopifyOrderShipBy(db, { orderId: id, date: '2026-10-30' });
    restore();
    restore = stubFetchOrders([fetched('2026-10-19T00:00:00Z')]);
    await syncShopifyOrders(db, () => {});

    shopifyApi.fetchOrders = async () => { throw new Error('clearing must not hit the network'); };
    const r = await setShopifyOrderShipBy(db, { orderId: id, date: '' });
    assert.deepEqual({ success: r.success, source: r.source }, { success: true, source: 'shopify' });
    const row = readOrder(db);
    assert.equal(row.ship_by_source, 'shopify');
    assert.equal(row.ship_by, '2026-10-19T00:00:00Z');
  } finally { restore(); db.close(); }
});

dbTest('clearing when there is no override is a harmless no-op', async () => {
  const db = makeDb();
  const restore = stubFetchOrders([fetched(null)]);
  try {
    await syncShopifyOrders(db, () => {});
    const before = readOrder(db);
    const r = await setShopifyOrderShipBy(db, { orderId: before.id, date: null });
    assert.equal(r.success, true);
    const after = readOrder(db);
    assert.equal(after.ship_by, before.ship_by);
    assert.equal(after.ship_by_source, 'estimated');
  } finally { restore(); db.close(); }
});

dbTest('setShopifyOrderShipBy rejects bad input and leaves the row untouched', async () => {
  const db = makeDb();
  const restore = stubFetchOrders([fetched(null)]);
  try {
    await syncShopifyOrders(db, () => {});
    const before = readOrder(db);
    assert.equal((await setShopifyOrderShipBy(db, { orderId: before.id, date: '2026-02-30' })).success, false);
    assert.equal((await setShopifyOrderShipBy(db, { orderId: before.id, date: 'soon' })).success, false);
    assert.equal((await setShopifyOrderShipBy(db, { orderId: 'abc', date: '2026-10-30' })).success, false);
    assert.equal((await setShopifyOrderShipBy(db, { orderId: 9999, date: '2026-10-30' })).success, false);
    assert.equal((await setShopifyOrderShipBy(db, undefined)).success, false);
    const after = readOrder(db);
    assert.equal(after.ship_by, before.ship_by);
    assert.equal(after.ship_by_source, 'estimated');
  } finally { restore(); db.close(); }
});
