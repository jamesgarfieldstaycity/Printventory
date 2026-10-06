/**
 * Guardrail for the migration-ordering bug fixed 2026-10-05: a legacy backfill
 * block inside ensureShopifyTablesExist() ran before the ALTER TABLE
 * migrations it depended on, threw, and silently skipped every statement
 * scheduled after it (shopify_orders, shopify_order_line_items,
 * shopify_fulfillment_log, shopify_series_counter, several indexes, and
 * default product-type seeding) on any brand-new database.
 *
 * This boots server mode against a throwaway, never-before-seen database
 * file and asserts every table ensureShopifyTablesExist() is supposed to
 * create actually exists afterward. It would have caught the ordering bug
 * directly: a reordering regression here fails loudly instead of only
 * surfacing as "Sync failed: no such table: shopify_orders" in the field.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, expect, _electron: electron } = require('@playwright/test');
const { DatabaseSync } = require('node:sqlite');
const { APP_ROOT, getTestEnv } = require('./test-utils');

const EXPECTED_TABLES = [
  'shopify_products',
  'shopify_product_files',
  'shopify_orders',
  'shopify_order_line_items',
  'shopify_fulfillment_log',
  'shopify_series_counter'
];

test.describe('Server mode: fresh-database schema completeness', () => {
  test.setTimeout(90000);

  test('every expected Shopify table exists after first boot against a new DB', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printventory-schema-test-'));
    const dbPath = path.join(tmpDir, 'printventory.db');
    const userDataDir = path.join(tmpDir, 'user-data');

    // Confirm we really are starting from nothing — a stale file here would
    // make this test meaningless.
    expect(fs.existsSync(dbPath)).toBe(false);

    const env = getTestEnv({
      PRINTVENTORY_DB_PATH: dbPath,
      PRINTVENTORY_PORT: '15099'
    });

    const app = await electron.launch({
      args: [APP_ROOT, '--server', '--user-data-dir=' + userDataDir],
      env,
      cwd: APP_ROOT
    });

    try {
      // Give main.js's async ensureShopifyTablesExist() a chance to run and
      // finish. Poll rather than sleep a fixed amount, since schema setup
      // time can vary with machine load.
      const deadline = Date.now() + 60000;
      let lastError = null;
      let tables = new Set();

      while (Date.now() < deadline) {
        if (fs.existsSync(dbPath)) {
          try {
            const db = new DatabaseSync(dbPath, { readOnly: true });
            try {
              const rows = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table'"
              ).all();
              tables = new Set(rows.map((r) => r.name));
              lastError = null;
            } finally {
              db.close();
            }
            if (EXPECTED_TABLES.every((t) => tables.has(t))) break;
          } catch (e) {
            // DB may be mid-write (locked) or not fully initialized yet — retry.
            lastError = e;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const missing = EXPECTED_TABLES.filter((t) => !tables.has(t));
      expect(
        missing,
        `missing tables after boot: ${missing.join(', ')}` +
          (lastError ? ` (last read error: ${lastError.message})` : '') +
          ` — present: ${[...tables].join(', ')}`
      ).toEqual([]);
    } finally {
      await app.close().catch(() => {});
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
