'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pickShipBy,
  addBusinessDays,
  resolveShipBy,
  normalizeProcessingDays,
  DEFAULT_PROCESSING_DAYS
} = require('./core/shopify-orders');

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
