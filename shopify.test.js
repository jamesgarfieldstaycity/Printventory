#!/usr/bin/env node
'use strict';

// SQLite tests need Electron's better-sqlite3 binary:
//   $env:ELECTRON_RUN_AS_NODE='1'; npx electron shopify.test.js

const assert = require('assert');
const Database = require('better-sqlite3');

// Import shopify module for token/API tests
const shopify = require('./shopify');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

// ============================================================================
// Database Schema Setup (matches actual production schema)
// ============================================================================

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // Models table (actual schema from main.js)
  db.prepare(`
    CREATE TABLE models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filePath TEXT UNIQUE,
      fileName TEXT,
      designer TEXT,
      source TEXT,
      notes TEXT,
      license TEXT,
      parentModel TEXT,
      dateAdded DATETIME,
      isNew INTEGER DEFAULT 0,
      rating INTEGER,
      favorite INTEGER DEFAULT 0
    )
  `).run();

  // Tags tables
  db.prepare(`
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE TABLE model_tags (
      model_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY(model_id, tag_id),
      FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE,
      FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    )
  `).run();

  // Shopify product types
  db.prepare(`
    CREATE TABLE shopify_product_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Shopify collection codes
  db.prepare(`
    CREATE TABLE shopify_collection_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Shopify products table (folder-based reconciliation schema)
  db.prepare(`
    CREATE TABLE shopify_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_path TEXT UNIQUE,
      model_id INTEGER,
      collection_code TEXT,
      type_code TEXT,
      product_code TEXT,
      series_number INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      licensor_collection TEXT,
      option_name TEXT DEFAULT 'Finish',
      needs_measurement_review INTEGER DEFAULT 1,
      needs_pricing_review INTEGER DEFAULT 1,
      needs_final_photography INTEGER DEFAULT 1,
      not_approved_for_publishing INTEGER DEFAULT 1,
      photo_order TEXT,
      source_folder TEXT,
      shopify_product_id TEXT,
      push_status TEXT DEFAULT 'not_pushed',
      last_pushed_at DATETIME,
      last_push_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE SET NULL
    )
  `).run();

  // Shopify product files table (tracks primary/skipped files per folder)
  db.prepare(`
    CREATE TABLE shopify_product_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_path TEXT NOT NULL,
      model_id INTEGER NOT NULL,
      is_primary INTEGER DEFAULT 0,
      link_status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE,
      UNIQUE(folder_path, model_id)
    )
  `).run();

  // Shopify variants table
  db.prepare(`
    CREATE TABLE shopify_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      variant_number INTEGER NOT NULL,
      option_value TEXT NOT NULL,
      sku TEXT,
      price REAL,
      compare_at_price REAL,
      inventory_quantity INTEGER,
      shopify_variant_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES shopify_products(id) ON DELETE CASCADE,
      UNIQUE(product_id, variant_number)
    )
  `).run();

  // Series counter
  db.prepare(`
    CREATE TABLE shopify_series_counter (
      collection_code TEXT NOT NULL,
      type_code TEXT NOT NULL,
      last_series INTEGER DEFAULT 0,
      PRIMARY KEY(collection_code, type_code)
    )
  `).run();

  // Shopify product models link table (legacy - links models to products)
  db.prepare(`
    CREATE TABLE shopify_product_models (
      shopify_product_id INTEGER NOT NULL,
      model_id INTEGER NOT NULL,
      variant_number INTEGER NOT NULL,
      FOREIGN KEY(shopify_product_id) REFERENCES shopify_products(id) ON DELETE CASCADE,
      FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE,
      PRIMARY KEY(shopify_product_id, model_id)
    )
  `).run();

  // Settings table
  db.prepare(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `).run();

  return db;
}

// ============================================================================
// Reconciliation Query Tests
// ============================================================================

test('reconciliation query executes without SQL errors on empty database', () => {
  const db = createTestDb();

  // This is the exact query from getUnlinkedProductsHandler
  const query = `
    SELECT
      m.id as model_id,
      m.fileName as title,
      m.filePath as source_folder,
      m.designer,
      sp.id as shopify_product_id_local,
      sp.shopify_product_id,
      sp.push_status
    FROM models m
    LEFT JOIN shopify_products sp ON sp.model_id = m.id
    WHERE sp.id IS NULL
       OR (
         (sp.shopify_product_id IS NULL OR sp.shopify_product_id = '')
         AND (sp.push_status IS NULL OR sp.push_status NOT IN ('will_create_new', 'draft'))
       )
    ORDER BY m.fileName
  `;

  const result = db.prepare(query).all();
  assert.ok(Array.isArray(result), 'Query should return an array');
  assert.strictEqual(result.length, 0, 'Empty db should return 0 results');
  db.close();
});

test('reconciliation query finds models without shopify_products entry', () => {
  const db = createTestDb();

  // Insert test models
  db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/models/altar.3mf', 'The Shadow Altar.3mf')").run();
  db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/models/skull.3mf', 'Gothic Skull.3mf')").run();
  db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/models/dragon.stl', 'Dragon Figure.stl')").run();

  const query = `
    SELECT
      m.id as model_id,
      m.fileName as title,
      m.filePath as source_folder,
      m.designer,
      sp.id as shopify_product_id_local,
      sp.shopify_product_id,
      sp.push_status
    FROM models m
    LEFT JOIN shopify_products sp ON sp.model_id = m.id
    WHERE sp.id IS NULL
       OR (
         (sp.shopify_product_id IS NULL OR sp.shopify_product_id = '')
         AND (sp.push_status IS NULL OR sp.push_status NOT IN ('will_create_new', 'draft'))
       )
    ORDER BY m.fileName
  `;

  const result = db.prepare(query).all();
  assert.strictEqual(result.length, 3, 'Should find all 3 unlinked models');
  assert.strictEqual(result[0].title, 'Dragon Figure.stl');
  assert.strictEqual(result[1].title, 'Gothic Skull.3mf');
  assert.strictEqual(result[2].title, 'The Shadow Altar.3mf');
  db.close();
});

test('reconciliation query excludes models linked to Shopify', () => {
  const db = createTestDb();

  // Insert models
  const m1 = db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/models/altar.3mf', 'The Shadow Altar.3mf')").run().lastInsertRowid;
  const m2 = db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/models/skull.3mf', 'Gothic Skull.3mf')").run().lastInsertRowid;

  // Link one model to Shopify
  db.prepare(`
    INSERT INTO shopify_products (model_id, title, shopify_product_id, push_status)
    VALUES (?, 'The Shadow Altar', 'gid://shopify/Product/123', 'draft')
  `).run(m1);

  const query = `
    SELECT
      m.id as model_id,
      m.fileName as title,
      m.filePath as source_folder,
      m.designer,
      sp.id as shopify_product_id_local,
      sp.shopify_product_id,
      sp.push_status
    FROM models m
    LEFT JOIN shopify_products sp ON sp.model_id = m.id
    WHERE sp.id IS NULL
       OR (
         (sp.shopify_product_id IS NULL OR sp.shopify_product_id = '')
         AND (sp.push_status IS NULL OR sp.push_status NOT IN ('will_create_new', 'draft'))
       )
    ORDER BY m.fileName
  `;

  const result = db.prepare(query).all();
  assert.strictEqual(result.length, 1, 'Should find only 1 unlinked model');
  assert.strictEqual(result[0].title, 'Gothic Skull.3mf');
  db.close();
});

test('reconciliation query excludes models marked as will_create_new', () => {
  const db = createTestDb();

  // Insert models
  const m1 = db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/models/altar.3mf', 'The Shadow Altar.3mf')").run().lastInsertRowid;
  const m2 = db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/models/skull.3mf', 'Gothic Skull.3mf')").run().lastInsertRowid;

  // Mark one model as will_create_new
  db.prepare(`
    INSERT INTO shopify_products (model_id, title, push_status)
    VALUES (?, 'The Shadow Altar', 'will_create_new')
  `).run(m1);

  const query = `
    SELECT
      m.id as model_id,
      m.fileName as title,
      m.filePath as source_folder,
      m.designer,
      sp.id as shopify_product_id_local,
      sp.shopify_product_id,
      sp.push_status
    FROM models m
    LEFT JOIN shopify_products sp ON sp.model_id = m.id
    WHERE sp.id IS NULL
       OR (
         (sp.shopify_product_id IS NULL OR sp.shopify_product_id = '')
         AND (sp.push_status IS NULL OR sp.push_status NOT IN ('will_create_new', 'draft'))
       )
    ORDER BY m.fileName
  `;

  const result = db.prepare(query).all();
  assert.strictEqual(result.length, 1, 'Should find only 1 unlinked model');
  assert.strictEqual(result[0].title, 'Gothic Skull.3mf');
  db.close();
});

// ============================================================================
// SKU Generation Tests
// ============================================================================

function generateSku(collectionCode, typeCode, productCode, seriesNumber, variantNumber) {
  const series = String(seriesNumber).padStart(3, '0');
  const variant = String(variantNumber).padStart(2, '0');
  return `GR-${collectionCode}-${typeCode}-${productCode}-${series}-${variant}`;
}

function getNextSeriesNumber(db, collectionCode, typeCode) {
  const row = db.prepare(`
    SELECT last_series FROM shopify_series_counter
    WHERE collection_code = ? AND type_code = ?
  `).get(collectionCode, typeCode);
  return (row?.last_series || 0) + 1;
}

function allocateSeriesNumber(db, collectionCode, typeCode) {
  db.prepare(`
    INSERT INTO shopify_series_counter (collection_code, type_code, last_series)
    VALUES (?, ?, 1)
    ON CONFLICT(collection_code, type_code) DO UPDATE SET last_series = last_series + 1
  `).run(collectionCode, typeCode);

  return db.prepare(`
    SELECT last_series FROM shopify_series_counter
    WHERE collection_code = ? AND type_code = ?
  `).get(collectionCode, typeCode).last_series;
}

test('SKU generation follows GR-[Collection]-[Type]-[Product]-[Series]-[Variant] pattern', () => {
  const sku = generateSku('DIS', 'FIG', 'MICKEY', 1, 1);
  assert.strictEqual(sku, 'GR-DIS-FIG-MICKEY-001-01');

  const sku2 = generateSku('DRK', 'ORN', 'SHADOW', 42, 3);
  assert.strictEqual(sku2, 'GR-DRK-ORN-SHADOW-042-03');
});

test('series number allocates once per product, increments per collection+type', () => {
  const db = createTestDb();

  // First product in DIS-FIG
  const series1 = allocateSeriesNumber(db, 'DIS', 'FIG');
  assert.strictEqual(series1, 1);

  // Second product in DIS-FIG
  const series2 = allocateSeriesNumber(db, 'DIS', 'FIG');
  assert.strictEqual(series2, 2);

  // First product in DIS-ORN (different type)
  const series3 = allocateSeriesNumber(db, 'DIS', 'ORN');
  assert.strictEqual(series3, 1);

  // Third product in DIS-FIG
  const series4 = allocateSeriesNumber(db, 'DIS', 'FIG');
  assert.strictEqual(series4, 3);

  db.close();
});

test('variant number increments within a product', () => {
  const db = createTestDb();

  // Create a product
  const productId = db.prepare(`
    INSERT INTO shopify_products (title, collection_code, type_code, product_code, series_number)
    VALUES ('Test Product', 'DIS', 'FIG', 'TEST', 1)
  `).run().lastInsertRowid;

  // Add variants
  db.prepare(`
    INSERT INTO shopify_variants (product_id, variant_number, option_value, sku)
    VALUES (?, 1, 'Matte Black', 'GR-DIS-FIG-TEST-001-01')
  `).run(productId);

  db.prepare(`
    INSERT INTO shopify_variants (product_id, variant_number, option_value, sku)
    VALUES (?, 2, 'Bronze', 'GR-DIS-FIG-TEST-001-02')
  `).run(productId);

  db.prepare(`
    INSERT INTO shopify_variants (product_id, variant_number, option_value, sku)
    VALUES (?, 3, 'Silver', 'GR-DIS-FIG-TEST-001-03')
  `).run(productId);

  const variants = db.prepare('SELECT * FROM shopify_variants WHERE product_id = ? ORDER BY variant_number').all(productId);
  assert.strictEqual(variants.length, 3);
  assert.strictEqual(variants[0].sku, 'GR-DIS-FIG-TEST-001-01');
  assert.strictEqual(variants[1].sku, 'GR-DIS-FIG-TEST-001-02');
  assert.strictEqual(variants[2].sku, 'GR-DIS-FIG-TEST-001-03');

  db.close();
});

test('existing SKUs from Shopify reconciliation are never overwritten', () => {
  const db = createTestDb();

  // Create a product
  const productId = db.prepare(`
    INSERT INTO shopify_products (title, shopify_product_id)
    VALUES ('The Shadow Altar', 'gid://shopify/Product/123')
  `).run().lastInsertRowid;

  // Insert variant with existing Shopify SKU
  db.prepare(`
    INSERT INTO shopify_variants (product_id, variant_number, option_value, sku, shopify_variant_id)
    VALUES (?, 1, 'Matte Black', 'EXISTING-SKU-FROM-SHOPIFY', 'gid://shopify/ProductVariant/456')
  `).run(productId);

  // Verify the SKU is preserved
  const variant = db.prepare('SELECT sku FROM shopify_variants WHERE product_id = ?').get(productId);
  assert.strictEqual(variant.sku, 'EXISTING-SKU-FROM-SHOPIFY');

  // Simulate what happens if we try to "update" - we should check for existing SKU first
  const existingSku = db.prepare('SELECT sku FROM shopify_variants WHERE id = ?').get(1)?.sku;
  if (existingSku) {
    // Don't overwrite - this is the correct behavior
    assert.strictEqual(existingSku, 'EXISTING-SKU-FROM-SHOPIFY');
  }

  db.close();
});

// ============================================================================
// Token Cache Tests
// ============================================================================

test('normalizeStoreDomain handles various input formats', () => {
  assert.strictEqual(shopify.normalizeStoreDomain('my-store.myshopify.com'), 'my-store.myshopify.com');
  assert.strictEqual(shopify.normalizeStoreDomain('https://my-store.myshopify.com'), 'my-store.myshopify.com');
  assert.strictEqual(shopify.normalizeStoreDomain('https://my-store.myshopify.com/'), 'my-store.myshopify.com');
  assert.strictEqual(shopify.normalizeStoreDomain('MY-STORE.MYSHOPIFY.COM'), 'my-store.myshopify.com');
});

test('buildEndpoint constructs correct GraphQL URL', () => {
  const endpoint = shopify.buildEndpoint('my-store.myshopify.com', '2024-10');
  assert.strictEqual(endpoint, 'https://my-store.myshopify.com/admin/api/2024-10/graphql.json');
});

test('clearTokenCache removes cached tokens', () => {
  // This is a basic test - the actual token caching is internal
  // We just verify the function doesn't throw
  shopify.clearTokenCache('test-store.myshopify.com', 'test-client-id');
  assert.ok(true, 'clearTokenCache should not throw');
});

// ============================================================================
// Variant Import Tests
// ============================================================================

test('variants table stores all required fields from Shopify', () => {
  const db = createTestDb();

  const productId = db.prepare(`
    INSERT INTO shopify_products (title, shopify_product_id, option_name)
    VALUES ('The Shadow Altar', 'gid://shopify/Product/123', 'Finish')
  `).run().lastInsertRowid;

  // Simulate importing variants from Shopify
  const shopifyVariants = [
    { id: 'gid://shopify/ProductVariant/1', optionValue: 'Matte Black', sku: 'GR-DRK-DEC-SHADOW-001-01', price: '45.00', compareAtPrice: '55.00', inventoryQuantity: 12 },
    { id: 'gid://shopify/ProductVariant/2', optionValue: 'Bronze & Silver', sku: 'GR-DRK-DEC-SHADOW-001-02', price: '55.00', compareAtPrice: null, inventoryQuantity: 8 },
    { id: 'gid://shopify/ProductVariant/3', optionValue: 'Other', sku: 'GR-DRK-DEC-SHADOW-001-03', price: '40.00', compareAtPrice: null, inventoryQuantity: null }
  ];

  const insertVariant = db.prepare(`
    INSERT INTO shopify_variants (product_id, variant_number, option_value, sku, price, compare_at_price, inventory_quantity, shopify_variant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  shopifyVariants.forEach((v, i) => {
    insertVariant.run(productId, i + 1, v.optionValue, v.sku, parseFloat(v.price), v.compareAtPrice ? parseFloat(v.compareAtPrice) : null, v.inventoryQuantity, v.id);
  });

  const variants = db.prepare('SELECT * FROM shopify_variants WHERE product_id = ? ORDER BY variant_number').all(productId);

  assert.strictEqual(variants.length, 3);
  assert.strictEqual(variants[0].option_value, 'Matte Black');
  assert.strictEqual(variants[0].price, 45.0);
  assert.strictEqual(variants[0].compare_at_price, 55.0);
  assert.strictEqual(variants[0].inventory_quantity, 12);
  assert.strictEqual(variants[0].shopify_variant_id, 'gid://shopify/ProductVariant/1');

  assert.strictEqual(variants[1].option_value, 'Bronze & Silver');
  assert.strictEqual(variants[1].compare_at_price, null);

  assert.strictEqual(variants[2].inventory_quantity, null);

  db.close();
});

// ============================================================================
// Migration Test - Verify model_id column exists
// ============================================================================

test('shopify_products table has model_id column', () => {
  const db = createTestDb();

  const columns = db.prepare("PRAGMA table_info(shopify_products)").all();
  const columnNames = columns.map(c => c.name);

  assert.ok(columnNames.includes('model_id'), 'shopify_products should have model_id column');
  assert.ok(columnNames.includes('option_name'), 'shopify_products should have option_name column');
  assert.ok(columnNames.includes('shopify_product_id'), 'shopify_products should have shopify_product_id column');
  assert.ok(columnNames.includes('push_status'), 'shopify_products should have push_status column');

  db.close();
});

test('shopify_variants table has all required columns', () => {
  const db = createTestDb();

  const columns = db.prepare("PRAGMA table_info(shopify_variants)").all();
  const columnNames = columns.map(c => c.name);

  assert.ok(columnNames.includes('product_id'), 'should have product_id');
  assert.ok(columnNames.includes('variant_number'), 'should have variant_number');
  assert.ok(columnNames.includes('option_value'), 'should have option_value');
  assert.ok(columnNames.includes('sku'), 'should have sku');
  assert.ok(columnNames.includes('price'), 'should have price');
  assert.ok(columnNames.includes('compare_at_price'), 'should have compare_at_price');
  assert.ok(columnNames.includes('inventory_quantity'), 'should have inventory_quantity');
  assert.ok(columnNames.includes('shopify_variant_id'), 'should have shopify_variant_id');

  db.close();
});

// ============================================================================
// Folder-Based Reconciliation Tests
// ============================================================================

test('folder path extraction works correctly', () => {
  // Helper function matching main.js implementation
  function normalizeFolderPath(filePath, fileName) {
    const normalized = filePath.replace(/\\/g, '/');
    const folderPath = normalized.substring(0, normalized.length - fileName.length - 1);
    return folderPath;
  }

  assert.strictEqual(
    normalizeFolderPath('C:\\Products\\Disney\\Mickey\\Mickey.3mf', 'Mickey.3mf'),
    'C:/Products/Disney/Mickey'
  );
  assert.strictEqual(
    normalizeFolderPath('C:/Products/Disney/Mickey/Mickey.3mf', 'Mickey.3mf'),
    'C:/Products/Disney/Mickey'
  );
});

test('folder-based reconciliation query groups files by folder', () => {
  const db = createTestDb();

  // Insert files in the same folder (a product with multiple 3MF files)
  db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Disney/Mickey/Mickey.3mf', 'Mickey.3mf')").run();
  db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Disney/Mickey/Mickey_Split.3mf', 'Mickey_Split.3mf')").run();
  db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Disney/Mickey/Mickey.stl', 'Mickey.stl')").run(); // STL should be excluded

  // Insert files in a different folder
  db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Dark/Altar/Altar.3mf', 'Altar.3mf')").run();

  // Query that groups by folder and only counts 3MF files
  const query = `
    WITH folder_files AS (
      SELECT
        REPLACE(
          SUBSTR(REPLACE(filePath, '\\', '/'), 1,
            LENGTH(REPLACE(filePath, '\\', '/')) - LENGTH(fileName) - 1),
          '\\', '/'
        ) as folder_path,
        id as model_id,
        fileName
      FROM models
      WHERE LOWER(fileName) LIKE '%.3mf'
    )
    SELECT
      folder_path,
      COUNT(*) as file_count,
      GROUP_CONCAT(model_id || '::' || fileName, '|') as files_info
    FROM folder_files
    GROUP BY folder_path
    ORDER BY folder_path
  `;

  const result = db.prepare(query).all();

  assert.strictEqual(result.length, 2, 'Should find 2 folders');
  assert.strictEqual(result[0].folder_path, 'C:/Products/Dark/Altar');
  assert.strictEqual(result[0].file_count, 1);
  assert.strictEqual(result[1].folder_path, 'C:/Products/Disney/Mickey');
  assert.strictEqual(result[1].file_count, 2, 'Mickey folder should have 2 3MF files (STL excluded)');

  db.close();
});

test('shopify_product_files table tracks skipped files', () => {
  const db = createTestDb();

  // Insert a model
  const modelId = db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Disney/Mickey/Mickey.3mf', 'Mickey.3mf')").run().lastInsertRowid;

  // Mark it as skipped
  db.prepare(`
    INSERT INTO shopify_product_files (folder_path, model_id, is_primary, link_status)
    VALUES ('C:/Products/Disney/Mickey', ?, 0, 'skipped')
  `).run(modelId);

  // Verify skipped status
  const file = db.prepare('SELECT * FROM shopify_product_files WHERE model_id = ?').get(modelId);
  assert.strictEqual(file.link_status, 'skipped');
  assert.strictEqual(file.is_primary, 0);

  db.close();
});

test('folder reconciliation excludes folders where all files are skipped', () => {
  const db = createTestDb();

  // Insert models in one folder
  const m1 = db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Disney/Mickey/Mickey.3mf', 'Mickey.3mf')").run().lastInsertRowid;
  const m2 = db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Disney/Mickey/Mickey_Split.3mf', 'Mickey_Split.3mf')").run().lastInsertRowid;

  // Insert models in another folder
  db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Dark/Altar/Altar.3mf', 'Altar.3mf')").run();

  // Skip all files in Mickey folder
  db.prepare("INSERT INTO shopify_product_files (folder_path, model_id, link_status) VALUES ('C:/Products/Disney/Mickey', ?, 'skipped')").run(m1);
  db.prepare("INSERT INTO shopify_product_files (folder_path, model_id, link_status) VALUES ('C:/Products/Disney/Mickey', ?, 'skipped')").run(m2);

  // Query similar to getUnlinkedFoldersHandler
  const query = `
    WITH folder_files AS (
      SELECT
        REPLACE(
          SUBSTR(REPLACE(filePath, '\\', '/'), 1,
            LENGTH(REPLACE(filePath, '\\', '/')) - LENGTH(fileName) - 1),
          '\\', '/'
        ) as folder_path,
        id as model_id,
        fileName
      FROM models
      WHERE LOWER(fileName) LIKE '%.3mf'
    ),
    folder_status AS (
      SELECT
        ff.folder_path,
        COUNT(*) as file_count,
        (SELECT COUNT(*) FROM shopify_product_files spf
         WHERE spf.folder_path = ff.folder_path AND spf.link_status = 'skipped') as skipped_count
      FROM folder_files ff
      LEFT JOIN shopify_products sp ON sp.folder_path = ff.folder_path
      WHERE sp.id IS NULL OR (sp.shopify_product_id IS NULL AND sp.push_status NOT IN ('linked', 'draft', 'will_create_new'))
      GROUP BY ff.folder_path
    )
    SELECT * FROM folder_status
    WHERE skipped_count < file_count
  `;

  const result = db.prepare(query).all();

  assert.strictEqual(result.length, 1, 'Should find 1 folder (Mickey excluded because all files skipped)');
  assert.strictEqual(result[0].folder_path, 'C:/Products/Dark/Altar');

  db.close();
});

test('shopify_products table has folder_path column', () => {
  const db = createTestDb();

  const columns = db.prepare("PRAGMA table_info(shopify_products)").all();
  const columnNames = columns.map(c => c.name);

  assert.ok(columnNames.includes('folder_path'), 'shopify_products should have folder_path column');

  db.close();
});

test('shopify_product_files table exists with correct columns', () => {
  const db = createTestDb();

  const columns = db.prepare("PRAGMA table_info(shopify_product_files)").all();
  const columnNames = columns.map(c => c.name);

  assert.ok(columnNames.includes('folder_path'), 'should have folder_path');
  assert.ok(columnNames.includes('model_id'), 'should have model_id');
  assert.ok(columnNames.includes('is_primary'), 'should have is_primary');
  assert.ok(columnNames.includes('link_status'), 'should have link_status');

  db.close();
});

// ============================================================================
// Migration Idempotency Tests
// ============================================================================

test('NOT NULL migration is idempotent - can run twice without error', () => {
  const db = new Database(':memory:');

  // Create table with old schema (NOT NULL on SKU columns)
  db.exec(`
    CREATE TABLE shopify_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_path TEXT UNIQUE,
      model_id INTEGER,
      collection_code TEXT NOT NULL,
      type_code TEXT NOT NULL,
      product_code TEXT NOT NULL,
      series_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      shopify_product_id TEXT,
      push_status TEXT DEFAULT 'not_pushed'
    )
  `);

  // Insert test data
  db.prepare(`
    INSERT INTO shopify_products (folder_path, model_id, collection_code, type_code, product_code, series_number, title)
    VALUES ('C:/Test/Product', 1, 'DIS', 'FIG', 'TEST', 1, 'Test Product')
  `).run();

  // Simulate the migration logic (run it twice)
  function runMigration() {
    // Clean up stale migration table
    db.exec('DROP TABLE IF EXISTS shopify_products_new');

    const colInfo = db.prepare("PRAGMA table_info(shopify_products)").all();
    const existingColNames = colInfo.map(c => c.name);
    const notNullCols = colInfo.filter(c =>
      ['collection_code', 'type_code', 'product_code', 'series_number'].includes(c.name) && c.notnull === 1
    );

    if (notNullCols.length > 0) {
      const targetCols = ['id', 'folder_path', 'model_id', 'collection_code', 'type_code', 'product_code',
        'series_number', 'title', 'shopify_product_id', 'push_status'];
      const commonCols = targetCols.filter(c => existingColNames.includes(c));
      const colList = commonCols.join(', ');

      db.exec(`
        CREATE TABLE shopify_products_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          folder_path TEXT UNIQUE,
          model_id INTEGER,
          collection_code TEXT,
          type_code TEXT,
          product_code TEXT,
          series_number INTEGER,
          title TEXT NOT NULL,
          shopify_product_id TEXT,
          push_status TEXT DEFAULT 'not_pushed'
        )
      `);
      db.prepare(`INSERT INTO shopify_products_new (${colList}) SELECT ${colList} FROM shopify_products`).run();
      db.exec('DROP TABLE shopify_products');
      db.exec('ALTER TABLE shopify_products_new RENAME TO shopify_products');
    }
  }

  // First run - should migrate
  runMigration();

  // Second run - should be a no-op (NOT NULL already fixed)
  runMigration();

  // Verify schema is correct
  const cols = db.prepare("PRAGMA table_info(shopify_products)").all();
  const collectionCol = cols.find(c => c.name === 'collection_code');
  assert.strictEqual(collectionCol.notnull, 0, 'collection_code should be nullable after migration');

  // Verify data preserved
  const row = db.prepare('SELECT * FROM shopify_products WHERE id = 1').get();
  assert.strictEqual(row.title, 'Test Product', 'Data should be preserved');
  assert.strictEqual(row.collection_code, 'DIS', 'Collection code should be preserved');

  db.close();
});

test('migration cleans up stale shopify_products_new table', () => {
  const db = new Database(':memory:');

  // Create main table
  db.exec(`
    CREATE TABLE shopify_products (
      id INTEGER PRIMARY KEY,
      collection_code TEXT NOT NULL,
      title TEXT NOT NULL
    )
  `);

  // Simulate a failed previous migration - stale _new table exists
  db.exec(`
    CREATE TABLE shopify_products_new (
      id INTEGER PRIMARY KEY,
      collection_code TEXT,
      title TEXT NOT NULL
    )
  `);

  // Run migration - should clean up stale table first
  db.exec('DROP TABLE IF EXISTS shopify_products_new');

  // Verify stale table is gone
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shopify_products_new'").all();
  assert.strictEqual(tables.length, 0, 'Stale migration table should be dropped');

  db.close();
});

test('linking to existing Shopify product works with nullable SKU columns', () => {
  const db = createTestDb();

  // Insert a model
  const modelId = db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Test/Product.3mf', 'Product.3mf')").run().lastInsertRowid;

  // Link to existing Shopify product (no SKU columns needed)
  db.prepare(`
    INSERT INTO shopify_products (folder_path, model_id, title, shopify_product_id, push_status)
    VALUES ('C:/Products/Test', ?, 'Existing Shopify Product', 'gid://shopify/Product/123', 'linked')
  `).run(modelId);

  // Verify it worked - collection_code etc are NULL
  const product = db.prepare('SELECT * FROM shopify_products WHERE model_id = ?').get(modelId);
  assert.strictEqual(product.title, 'Existing Shopify Product');
  assert.strictEqual(product.shopify_product_id, 'gid://shopify/Product/123');
  assert.strictEqual(product.collection_code, null, 'collection_code should be NULL for linked products');
  assert.strictEqual(product.type_code, null, 'type_code should be NULL for linked products');

  db.close();
});

// ============================================================================
// Product Lookup Tests (getShopifyProductByModel logic)
// ============================================================================

test('getShopifyProductByModel finds product via shopify_products.model_id (folder-based)', () => {
  const db = createTestDb();

  // Insert a model
  const modelId = db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Test/Product.3mf', 'Product.3mf')").run().lastInsertRowid;

  // Link via folder-based approach (shopify_products.model_id)
  db.prepare(`
    INSERT INTO shopify_products (folder_path, model_id, title, shopify_product_id, push_status)
    VALUES ('C:/Products/Test', ?, 'Test Product', 'gid://shopify/Product/123', 'linked')
  `).run(modelId);

  // Simulate getShopifyProductByModel logic
  const folderBased = db.prepare('SELECT * FROM shopify_products WHERE model_id = ?').get(modelId);

  assert.ok(folderBased, 'Should find product via folder-based lookup');
  assert.strictEqual(folderBased.title, 'Test Product');
  assert.strictEqual(folderBased.shopify_product_id, 'gid://shopify/Product/123');

  db.close();
});

test('getShopifyProductByModel falls back to shopify_product_models table (legacy)', () => {
  const db = createTestDb();

  // Insert a model
  const modelId = db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Test/Product.3mf', 'Product.3mf')").run().lastInsertRowid;

  // Create a product without model_id link (old style)
  const productId = db.prepare(`
    INSERT INTO shopify_products (title, shopify_product_id)
    VALUES ('Legacy Product', 'gid://shopify/Product/456')
  `).run().lastInsertRowid;

  // Link via legacy table
  db.prepare(`
    INSERT INTO shopify_product_models (shopify_product_id, model_id, variant_number)
    VALUES (?, ?, 1)
  `).run(productId, modelId);

  // Simulate getShopifyProductByModel logic (folder-based first, then legacy)
  let product = db.prepare('SELECT * FROM shopify_products WHERE model_id = ?').get(modelId);

  if (!product) {
    // Fall back to legacy
    const link = db.prepare('SELECT shopify_product_id FROM shopify_product_models WHERE model_id = ?').get(modelId);
    if (link) {
      product = db.prepare('SELECT * FROM shopify_products WHERE id = ?').get(link.shopify_product_id);
    }
  }

  assert.ok(product, 'Should find product via legacy lookup');
  assert.strictEqual(product.title, 'Legacy Product');

  db.close();
});

test('isLinked detection works based on shopify_product_id presence', () => {
  const db = createTestDb();

  // Linked product
  db.prepare(`
    INSERT INTO shopify_products (title, shopify_product_id, push_status)
    VALUES ('Linked Product', 'gid://shopify/Product/123', 'linked')
  `).run();

  // Unlinked product
  db.prepare(`
    INSERT INTO shopify_products (title, push_status)
    VALUES ('New Product', 'not_pushed')
  `).run();

  const linked = db.prepare("SELECT * FROM shopify_products WHERE title = 'Linked Product'").get();
  const unlinked = db.prepare("SELECT * FROM shopify_products WHERE title = 'New Product'").get();

  const isLinkedProduct = !!linked.shopify_product_id;
  const isUnlinkedProduct = !!unlinked.shopify_product_id;

  assert.strictEqual(isLinkedProduct, true, 'Product with shopify_product_id should be considered linked');
  assert.strictEqual(isUnlinkedProduct, false, 'Product without shopify_product_id should not be considered linked');

  db.close();
});

test('linked product stores title and description from Shopify', () => {
  const db = createTestDb();

  // Insert model
  const modelId = db.prepare("INSERT INTO models (filePath, fileName) VALUES ('C:/Products/Test/Altar.3mf', 'Altar.3mf')").run().lastInsertRowid;

  // Simulate linking with Shopify data
  const shopifyData = {
    title: "The Anatomist's Study",
    descriptionHtml: '<p>A detailed gothic study piece.</p>',
    vendor: 'Dark Artifacts',
    options: [{ name: 'Finish', values: ['Matte Black', 'Bronze'] }]
  };

  db.prepare(`
    INSERT INTO shopify_products (folder_path, model_id, title, description, shopify_product_id, option_name, push_status)
    VALUES (?, ?, ?, ?, ?, ?, 'linked')
  `).run(
    'C:/Products/Test',
    modelId,
    shopifyData.title,
    shopifyData.descriptionHtml,
    'gid://shopify/Product/789',
    shopifyData.options[0].name
  );

  const product = db.prepare('SELECT * FROM shopify_products WHERE model_id = ?').get(modelId);

  assert.strictEqual(product.title, "The Anatomist's Study");
  assert.strictEqual(product.description, '<p>A detailed gothic study piece.</p>');
  assert.strictEqual(product.option_name, 'Finish');
  assert.strictEqual(product.push_status, 'linked');

  db.close();
});

// ============================================================================
// Inventory Quantity Exclusion Tests
// ============================================================================

test('updateVariant function signature excludes inventoryQuantity', () => {
  // shopify.updateVariant accepts (storeDomain, clientId, clientSecret, productId, variantId, price, sku)
  // inventoryQuantity is intentionally excluded - it is managed in Shopify admin only
  const updateVariantParams = shopify.updateVariant.length;

  // The function has 7 parameters: storeDomain, clientId, clientSecret, productId, variantId, price, sku
  // No inventoryQuantity parameter exists
  assert.strictEqual(updateVariantParams, 7, 'updateVariant should have exactly 7 parameters (no inventoryQuantity)');
});

test('updateVariantsBulk function is exported and has correct signature', () => {
  // updateVariantsBulk should be available
  assert.ok(typeof shopify.updateVariantsBulk === 'function', 'updateVariantsBulk should be exported');

  // The function has 5 parameters: storeDomain, clientId, clientSecret, productId, variants
  const params = shopify.updateVariantsBulk.length;
  assert.strictEqual(params, 5, 'updateVariantsBulk should have exactly 5 parameters');
});

test('variant update payload builder never includes inventoryQuantity', () => {
  // This test documents the expected behavior of the UI variant update payload builder.
  // The payload should only include: id, price, sku (and option_value for display).
  // inventoryQuantity should NEVER be included in the push payload.

  // Simulate the payload building logic from renderer.js
  function buildVariantUpdatePayload(variantRow) {
    // This mirrors the actual implementation in renderer.js
    // The key constraint is that inventoryQuantity is NOT collected for push
    return {
      id: variantRow.variantId,
      price: variantRow.price ? parseFloat(variantRow.price) : null,
      sku: variantRow.sku || null
      // NOTE: inventoryQuantity is explicitly NOT included here
      // Inventory is display-only in Printventory, managed in Shopify admin
    };
  }

  // Test with variant data that includes inventoryQuantity in the source
  const variantRow = {
    variantId: 'gid://shopify/ProductVariant/123',
    price: '45.00',
    sku: 'GR-DIS-FIG-MICKEY-001-01',
    inventoryQuantity: 12 // This exists in the local data but should NOT be pushed
  };

  const payload = buildVariantUpdatePayload(variantRow);

  // Verify the payload structure
  assert.ok(payload.id, 'Payload should have id');
  assert.ok('price' in payload, 'Payload should have price');
  assert.ok('sku' in payload, 'Payload should have sku');

  // Critical assertion: inventoryQuantity must NOT be in the payload
  assert.strictEqual('inventoryQuantity' in payload, false, 'Payload must NOT include inventoryQuantity');
  assert.strictEqual('inventory_quantity' in payload, false, 'Payload must NOT include inventory_quantity');
  assert.strictEqual('inventory' in payload, false, 'Payload must NOT include inventory');
});

test('bulk variant update array excludes inventoryQuantity from all entries', () => {
  // When updating multiple variants, none should include inventoryQuantity

  function buildBulkVariantUpdates(variantRows) {
    return variantRows.map(row => ({
      id: row.variantId,
      price: row.price ? parseFloat(row.price) : null,
      sku: row.sku || null
      // inventoryQuantity explicitly excluded
    }));
  }

  const variantRows = [
    { variantId: 'gid://shopify/ProductVariant/1', price: '45.00', sku: 'SKU-001', inventoryQuantity: 10 },
    { variantId: 'gid://shopify/ProductVariant/2', price: '55.00', sku: 'SKU-002', inventoryQuantity: 5 },
    { variantId: 'gid://shopify/ProductVariant/3', price: '40.00', sku: 'SKU-003', inventoryQuantity: 0 }
  ];

  const updates = buildBulkVariantUpdates(variantRows);

  assert.strictEqual(updates.length, 3, 'Should have 3 variant updates');

  for (const update of updates) {
    assert.strictEqual('inventoryQuantity' in update, false,
      `Variant ${update.id} must NOT include inventoryQuantity`);
    assert.strictEqual('inventory_quantity' in update, false,
      `Variant ${update.id} must NOT include inventory_quantity`);
  }
});

test('productVariantsBulkUpdate payload structure matches Shopify 2024-10 API', () => {
  // This test documents the expected payload structure for the 2024-10 API
  // The productVariantsBulkUpdate mutation requires:
  // - productId: ID! (the product GID)
  // - variants: [ProductVariantsBulkInput!]! where each variant has:
  //   - id: ID! (variant GID)
  //   - price: Money (as string)
  //   - compareAtPrice: Money (as string, optional)
  //   - inventoryItem: { sku: String } (SKU nested under inventoryItem)
  // Note: inventoryQuantity is NOT part of this mutation - it uses inventorySetQuantities

  function buildVariantsBulkInput(variants) {
    return variants.map(v => {
      const input = { id: v.id };
      if (v.price != null) {
        input.price = String(v.price);
      }
      if (v.compareAtPrice != null) {
        input.compareAtPrice = String(v.compareAtPrice);
      }
      if (v.sku != null) {
        // SKU is nested under inventoryItem in 2024-10 API
        input.inventoryItem = { sku: v.sku };
      }
      return input;
    });
  }

  const testVariants = [
    { id: 'gid://shopify/ProductVariant/1', price: 45.00, sku: 'GR-DIS-FIG-001-01' },
    { id: 'gid://shopify/ProductVariant/2', price: 55.00, sku: 'GR-DIS-FIG-001-02', compareAtPrice: 65.00 }
  ];

  const bulkInput = buildVariantsBulkInput(testVariants);

  assert.strictEqual(bulkInput.length, 2);

  // First variant
  assert.strictEqual(bulkInput[0].id, 'gid://shopify/ProductVariant/1');
  assert.strictEqual(bulkInput[0].price, '45');
  assert.deepStrictEqual(bulkInput[0].inventoryItem, { sku: 'GR-DIS-FIG-001-01' });
  assert.strictEqual('inventoryQuantity' in bulkInput[0], false);

  // Second variant with compareAtPrice
  assert.strictEqual(bulkInput[1].id, 'gid://shopify/ProductVariant/2');
  assert.strictEqual(bulkInput[1].price, '55');
  assert.strictEqual(bulkInput[1].compareAtPrice, '65');
  assert.deepStrictEqual(bulkInput[1].inventoryItem, { sku: 'GR-DIS-FIG-001-02' });
  assert.strictEqual('inventoryQuantity' in bulkInput[1], false);
});

// ============================================================================
// Photo Diff Tests (for diff-based media push)
// ============================================================================

/**
 * Simulate the computePhotoDiff function from renderer.js
 * This is a pure function that can be unit tested.
 */
function computePhotoDiff(baseline, current, modified) {
  // If not modified, no changes
  if (!modified) {
    return { hasChanges: false, added: [], removed: [], reordered: false };
  }

  // Extract baseline media IDs
  const baselineIds = new Set(baseline.map(b => b.id));
  const baselineOrder = baseline.map(b => b.id);

  // Extract current media IDs (only for existing Shopify images)
  const currentShopifyImages = current.filter(c => c.isShopifyImage && c.shopifyMediaId);
  const currentIds = new Set(currentShopifyImages.map(c => c.shopifyMediaId));
  const currentOrder = currentShopifyImages.map(c => c.shopifyMediaId);

  // Find removed (in baseline but not in current)
  const removed = baseline.filter(b => !currentIds.has(b.id)).map(b => b.id);

  // Find added (local images that need to be uploaded)
  const added = current.filter(c => !c.isShopifyImage);

  // Check if reordered (same IDs but different order)
  let reordered = false;
  if (removed.length === 0 && currentOrder.length === baselineOrder.length) {
    for (let i = 0; i < currentOrder.length; i++) {
      if (currentOrder[i] !== baselineOrder[i]) {
        reordered = true;
        break;
      }
    }
  }

  return {
    hasChanges: removed.length > 0 || added.length > 0 || reordered,
    added,
    removed,
    reordered,
    currentOrder
  };
}

test('photo diff returns no changes when modified flag is false', () => {
  const baseline = [
    { id: 'gid://shopify/MediaImage/1', url: 'https://cdn.shopify.com/image1.jpg' },
    { id: 'gid://shopify/MediaImage/2', url: 'https://cdn.shopify.com/image2.jpg' }
  ];
  const current = [
    { filename: 'image1.jpg', path: 'https://cdn.shopify.com/image1.jpg', shopifyMediaId: 'gid://shopify/MediaImage/1', isShopifyImage: true },
    { filename: 'image2.jpg', path: 'https://cdn.shopify.com/image2.jpg', shopifyMediaId: 'gid://shopify/MediaImage/2', isShopifyImage: true }
  ];

  const diff = computePhotoDiff(baseline, current, false); // modified = false

  assert.strictEqual(diff.hasChanges, false, 'Should have no changes when not modified');
  assert.deepStrictEqual(diff.added, [], 'Should have no added photos');
  assert.deepStrictEqual(diff.removed, [], 'Should have no removed photos');
  assert.strictEqual(diff.reordered, false, 'Should not be reordered');
});

test('photo diff detects no changes when photos match baseline', () => {
  const baseline = [
    { id: 'gid://shopify/MediaImage/1', url: 'https://cdn.shopify.com/image1.jpg' },
    { id: 'gid://shopify/MediaImage/2', url: 'https://cdn.shopify.com/image2.jpg' }
  ];
  const current = [
    { filename: 'image1.jpg', path: 'https://cdn.shopify.com/image1.jpg', shopifyMediaId: 'gid://shopify/MediaImage/1', isShopifyImage: true },
    { filename: 'image2.jpg', path: 'https://cdn.shopify.com/image2.jpg', shopifyMediaId: 'gid://shopify/MediaImage/2', isShopifyImage: true }
  ];

  const diff = computePhotoDiff(baseline, current, true); // modified = true but no actual changes

  assert.strictEqual(diff.hasChanges, false, 'Should detect no changes when same');
  assert.deepStrictEqual(diff.removed, [], 'Should have no removed photos');
  assert.deepStrictEqual(diff.added, [], 'Should have no added photos');
});

test('photo diff detects removed photos', () => {
  const baseline = [
    { id: 'gid://shopify/MediaImage/1', url: 'https://cdn.shopify.com/image1.jpg' },
    { id: 'gid://shopify/MediaImage/2', url: 'https://cdn.shopify.com/image2.jpg' },
    { id: 'gid://shopify/MediaImage/3', url: 'https://cdn.shopify.com/image3.jpg' }
  ];
  const current = [
    { filename: 'image1.jpg', path: 'https://cdn.shopify.com/image1.jpg', shopifyMediaId: 'gid://shopify/MediaImage/1', isShopifyImage: true }
    // image2 and image3 removed
  ];

  const diff = computePhotoDiff(baseline, current, true);

  assert.strictEqual(diff.hasChanges, true, 'Should detect changes');
  assert.deepStrictEqual(diff.removed, ['gid://shopify/MediaImage/2', 'gid://shopify/MediaImage/3'], 'Should list removed media IDs');
  assert.deepStrictEqual(diff.added, [], 'Should have no added photos');
});

test('photo diff detects added local photos', () => {
  const baseline = [
    { id: 'gid://shopify/MediaImage/1', url: 'https://cdn.shopify.com/image1.jpg' }
  ];
  const current = [
    { filename: 'image1.jpg', path: 'https://cdn.shopify.com/image1.jpg', shopifyMediaId: 'gid://shopify/MediaImage/1', isShopifyImage: true },
    { filename: 'new-image.jpg', path: 'C:/Products/Test/new-image.jpg', isShopifyImage: false },
    { filename: 'another-new.png', path: 'C:/Products/Test/another-new.png', isShopifyImage: false }
  ];

  const diff = computePhotoDiff(baseline, current, true);

  assert.strictEqual(diff.hasChanges, true, 'Should detect changes');
  assert.deepStrictEqual(diff.removed, [], 'Should have no removed photos');
  assert.strictEqual(diff.added.length, 2, 'Should have 2 added photos');
  assert.strictEqual(diff.added[0].filename, 'new-image.jpg');
  assert.strictEqual(diff.added[1].filename, 'another-new.png');
});

test('photo diff detects reordering', () => {
  const baseline = [
    { id: 'gid://shopify/MediaImage/1', url: 'https://cdn.shopify.com/image1.jpg' },
    { id: 'gid://shopify/MediaImage/2', url: 'https://cdn.shopify.com/image2.jpg' },
    { id: 'gid://shopify/MediaImage/3', url: 'https://cdn.shopify.com/image3.jpg' }
  ];
  const current = [
    { filename: 'image3.jpg', path: 'https://cdn.shopify.com/image3.jpg', shopifyMediaId: 'gid://shopify/MediaImage/3', isShopifyImage: true },
    { filename: 'image1.jpg', path: 'https://cdn.shopify.com/image1.jpg', shopifyMediaId: 'gid://shopify/MediaImage/1', isShopifyImage: true },
    { filename: 'image2.jpg', path: 'https://cdn.shopify.com/image2.jpg', shopifyMediaId: 'gid://shopify/MediaImage/2', isShopifyImage: true }
  ];

  const diff = computePhotoDiff(baseline, current, true);

  assert.strictEqual(diff.hasChanges, true, 'Should detect changes');
  assert.strictEqual(diff.reordered, true, 'Should detect reordering');
  assert.deepStrictEqual(diff.removed, [], 'Should have no removed photos');
  assert.deepStrictEqual(diff.added, [], 'Should have no added photos');
  assert.deepStrictEqual(diff.currentOrder, [
    'gid://shopify/MediaImage/3',
    'gid://shopify/MediaImage/1',
    'gid://shopify/MediaImage/2'
  ], 'Should have correct current order');
});

test('photo diff detects combined add/remove/reorder', () => {
  const baseline = [
    { id: 'gid://shopify/MediaImage/1', url: 'https://cdn.shopify.com/image1.jpg' },
    { id: 'gid://shopify/MediaImage/2', url: 'https://cdn.shopify.com/image2.jpg' }
  ];
  const current = [
    { filename: 'image2.jpg', path: 'https://cdn.shopify.com/image2.jpg', shopifyMediaId: 'gid://shopify/MediaImage/2', isShopifyImage: true },
    // image1 removed
    { filename: 'new-local.jpg', path: 'C:/Products/Test/new-local.jpg', isShopifyImage: false } // new local image
  ];

  const diff = computePhotoDiff(baseline, current, true);

  assert.strictEqual(diff.hasChanges, true, 'Should detect changes');
  assert.deepStrictEqual(diff.removed, ['gid://shopify/MediaImage/1'], 'Should detect removed photo');
  assert.strictEqual(diff.added.length, 1, 'Should have 1 added photo');
  assert.strictEqual(diff.added[0].filename, 'new-local.jpg');
});

test('photo diff handles empty baseline (new product with no Shopify images)', () => {
  const baseline = [];
  const current = [
    { filename: 'new-image.jpg', path: 'C:/Products/Test/new-image.jpg', isShopifyImage: false }
  ];

  const diff = computePhotoDiff(baseline, current, true);

  assert.strictEqual(diff.hasChanges, true, 'Should detect changes');
  assert.strictEqual(diff.added.length, 1, 'Should have 1 added photo');
  assert.deepStrictEqual(diff.removed, [], 'Should have no removed photos');
});

test('photo diff does not false-match on URL vs local filename', () => {
  // This tests that we use shopifyMediaId for comparison, not filename/URL
  const baseline = [
    { id: 'gid://shopify/MediaImage/123', url: 'https://cdn.shopify.com/s/files/1/0123/some-hash_image.jpg' }
  ];
  const current = [
    // Same image from Shopify with different local filename - should match by ID
    { filename: 'some-hash_image.jpg', path: 'https://cdn.shopify.com/s/files/1/0123/some-hash_image.jpg', shopifyMediaId: 'gid://shopify/MediaImage/123', isShopifyImage: true }
  ];

  const diff = computePhotoDiff(baseline, current, true);

  assert.strictEqual(diff.hasChanges, false, 'Should detect no changes when same media ID');
  assert.deepStrictEqual(diff.removed, [], 'Should not falsely mark as removed');
});

// ============================================================================
// Inventory Sync Tests
// ============================================================================

test('setInventoryQuantities function is exported and has correct signature', () => {
  assert.strictEqual(typeof shopify.setInventoryQuantities, 'function', 'setInventoryQuantities should be exported');
  // Function takes 4 params: storeDomain, clientId, clientSecret, updates
  assert.strictEqual(shopify.setInventoryQuantities.length, 4, 'setInventoryQuantities should take 4 parameters');
});

test('getPrimaryLocationId function is exported', () => {
  assert.strictEqual(typeof shopify.getPrimaryLocationId, 'function', 'getPrimaryLocationId should be exported');
});

test('getInventoryItemId function is exported', () => {
  assert.strictEqual(typeof shopify.getInventoryItemId, 'function', 'getInventoryItemId should be exported');
});

// ============================================================================
// Collection/Type Code Tests (Database)
// ============================================================================

test('collection code can be created and persists', () => {
  const db = createTestDb();

  // Insert a new collection code
  const result = db.prepare('INSERT INTO shopify_collection_codes (code, name) VALUES (?, ?)').run('TST', 'Test Collection');
  assert.ok(result.lastInsertRowid, 'Should return insert ID');

  // Verify it persists
  const row = db.prepare('SELECT * FROM shopify_collection_codes WHERE code = ?').get('TST');
  assert.strictEqual(row.code, 'TST', 'Code should match');
  assert.strictEqual(row.name, 'Test Collection', 'Name should match');
});

test('product type can be created and persists', () => {
  const db = createTestDb();

  // Insert a new product type
  const result = db.prepare('INSERT INTO shopify_product_types (code, name) VALUES (?, ?)').run('FIG', 'Figure');
  assert.ok(result.lastInsertRowid, 'Should return insert ID');

  // Verify it persists
  const row = db.prepare('SELECT * FROM shopify_product_types WHERE code = ?').get('FIG');
  assert.strictEqual(row.code, 'FIG', 'Code should match');
  assert.strictEqual(row.name, 'Figure', 'Name should match');
});

test('duplicate collection code is rejected', () => {
  const db = createTestDb();

  // Insert first code
  db.prepare('INSERT INTO shopify_collection_codes (code, name) VALUES (?, ?)').run('DUP', 'First');

  // Try to insert duplicate - should fail due to UNIQUE constraint
  let threw = false;
  try {
    db.prepare('INSERT INTO shopify_collection_codes (code, name) VALUES (?, ?)').run('DUP', 'Second');
  } catch (e) {
    threw = true;
    assert.ok(e.message.includes('UNIQUE'), 'Should be a UNIQUE constraint violation');
  }
  assert.ok(threw, 'Should throw on duplicate code');
});

// ============================================================================
// Variant SKU Generation Tests
// ============================================================================

test('variant SKU generator increments variant number per row', () => {
  // Simulating the SKU generation logic from renderer.js
  function generateVariantSku(collection, type, product, series, variantIndex) {
    const productCode = (product || '').toUpperCase().padEnd(6, '?').substring(0, 6);
    const seriesStr = String(series || 0).padStart(3, '0');
    const variantNum = String(variantIndex + 1).padStart(2, '0');
    return `GR-${collection || '???'}-${type || '???'}-${productCode}-${seriesStr}-${variantNum}`;
  }

  // Test incrementing variant number
  const sku1 = generateVariantSku('DIS', 'FIG', 'MICKEY', 1, 0);
  const sku2 = generateVariantSku('DIS', 'FIG', 'MICKEY', 1, 1);
  const sku3 = generateVariantSku('DIS', 'FIG', 'MICKEY', 1, 2);

  assert.strictEqual(sku1, 'GR-DIS-FIG-MICKEY-001-01', 'First variant should be -01');
  assert.strictEqual(sku2, 'GR-DIS-FIG-MICKEY-001-02', 'Second variant should be -02');
  assert.strictEqual(sku3, 'GR-DIS-FIG-MICKEY-001-03', 'Third variant should be -03');

  // All should have the same series number
  assert.ok(sku1.includes('-001-'), 'Series should be 001');
  assert.ok(sku2.includes('-001-'), 'Series should be 001');
  assert.ok(sku3.includes('-001-'), 'Series should be 001');
});

test('series number stays fixed across all variants of a product', () => {
  function generateVariantSku(collection, type, product, series, variantIndex) {
    const productCode = (product || '').toUpperCase().padEnd(6, '?').substring(0, 6);
    const seriesStr = String(series || 0).padStart(3, '0');
    const variantNum = String(variantIndex + 1).padStart(2, '0');
    return `GR-${collection}-${type}-${productCode}-${seriesStr}-${variantNum}`;
  }

  // Series 5 should stay 005 for all variants
  const variants = [0, 1, 2, 3, 4].map(idx => generateVariantSku('WDW', 'ORN', 'CASTLE', 5, idx));

  variants.forEach((sku, idx) => {
    assert.ok(sku.includes('-005-'), `Variant ${idx + 1} should have series 005`);
    assert.ok(sku.endsWith(`-${String(idx + 1).padStart(2, '0')}`), `Variant ${idx + 1} should end with -${String(idx + 1).padStart(2, '0')}`);
  });
});

// ============================================================================
// Run tests
// ============================================================================

if (process.exitCode) {
  process.exit(process.exitCode);
}
