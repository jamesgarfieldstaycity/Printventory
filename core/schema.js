// core/schema.js
//
// Phase 4 (core extraction) first increment. This is the Shopify
// integration schema/migration logic, moved verbatim out of main.js
// (where it was `function ensureShopifyTablesExist()` closing over a
// module-scope `db`) and parameterized to accept `db` as an argument
// instead. This was picked as the first thing to extract because it has
// zero Electron dependencies -- no `app.`, `dialog.`, `BrowserWindow`,
// `mainWindow`, `ipcMain`, `event.`, or `require()` of any Electron
// module anywhere in its body, only `db.prepare(...).run()` / `db.exec()`
// calls and `console.log`. That makes it safe to import from both the
// Electron desktop shell and a future Electron-free server runtime
// without pulling in anything Electron-specific.
//
// Body is unchanged from main.js lines 17564-18017 except for the
// function signature (now takes `db` as a parameter) and this header
// comment. See tests/server-mode-schema-completeness.spec.js, which
// asserts the exact set of tables this function must create and is
// unaffected by this move (it inspects the resulting sqlite file, not
// how the tables got there).

/**
 * Create Shopify integration tables for product listing management.
 * Follows the same CREATE TABLE IF NOT EXISTS pattern as other ensure functions.
 */
function ensureShopifyTablesExist(db) {
  try {
    console.log('Ensuring Shopify tables exist...');

    // Product types lookup (user-editable, e.g., FIG=Figure, ORN=Ornament)
    db.prepare(`CREATE TABLE IF NOT EXISTS shopify_product_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();

    // Collection codes (auto-tracked for uniqueness, e.g., DIS=Disney)
    db.prepare(`CREATE TABLE IF NOT EXISTS shopify_collection_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();

    // Main products table - links a folder (product) to Shopify
    // folder_path is the authoritative identity (full path, normalized)
    // model_id is the primary/representative file for this product
    db.prepare(`CREATE TABLE IF NOT EXISTS shopify_products (
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
    )`).run();

    // Variants table - each product has 1+ variants with their own SKU/price
    db.prepare(`CREATE TABLE IF NOT EXISTS shopify_variants (
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
    )`).run();

    // Product files table - tracks which files in a folder are primary/skipped/linked-separately
    // This allows multi-3MF folders to be handled properly
    db.prepare(`CREATE TABLE IF NOT EXISTS shopify_product_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_path TEXT NOT NULL,
        model_id INTEGER NOT NULL,
        is_primary INTEGER DEFAULT 0,
        link_status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE,
        UNIQUE(folder_path, model_id)
    )`).run();

    // Variant <-> file assignment (GR-PLAN-006, 2026-10-05). Separate from
    // shopify_product_files above, which still tracks is_primary/link_status
    // per file in a folder but no longer decides variant assignment. James's
    // hand-painted lines print one sculpt in several finishes from the SAME
    // file (e.g. "Matte Black" / "Bronze & Silver" / "Other (message me)"
    // all from one .3mf) - shopify_product_files's UNIQUE(folder_path,
    // model_id) made that impossible (confirming a second variant against
    // the same file silently overwrote the first variant's assignment,
    // since both lived in the one row keyed on that file). This table is
    // keyed on the VARIANT instead: UNIQUE(folder_path, shopify_variant_id)
    // means a variant always resolves to exactly one file (reassigning
    // replaces it, same as before), but nothing stops several variants
    // pointing at the same model_id.
    db.prepare(`CREATE TABLE IF NOT EXISTS shopify_variant_file_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_path TEXT NOT NULL,
        shopify_variant_id TEXT NOT NULL,
        model_id INTEGER NOT NULL,
        variant_option_value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE,
        UNIQUE(folder_path, shopify_variant_id)
    )`).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_variant_file_links_model ON shopify_variant_file_links(model_id)').run();


    // Series counter (ensures unique series per collection+type combination)
    db.prepare(`CREATE TABLE IF NOT EXISTS shopify_series_counter (
        collection_code TEXT NOT NULL,
        type_code TEXT NOT NULL,
        last_series INTEGER DEFAULT 0,
        PRIMARY KEY(collection_code, type_code)
    )`).run();

    // Migration: Fix NOT NULL constraints on columns that should be nullable
    // (collection_code, type_code, product_code, series_number are only needed for new products, not links)

    // First, clean up any stale migration table from a failed previous run
    const staleTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shopify_products_new'").all();
    if (staleTables.length > 0) {
      console.log('[Shopify] Cleaning up stale migration table shopify_products_new');
      db.exec('DROP TABLE IF EXISTS shopify_products_new');
    }

    // Check current schema
    const colInfo = db.prepare("PRAGMA table_info(shopify_products)").all();
    const existingColNames = colInfo.map(c => c.name);
    const notNullCols = colInfo.filter(c =>
      ['collection_code', 'type_code', 'product_code', 'series_number'].includes(c.name) && c.notnull === 1
    );

    if (notNullCols.length > 0) {
      console.log('[Shopify] Migrating: fixing NOT NULL constraints on:', notNullCols.map(c => c.name).join(', '));

      // SQLite doesn't support ALTER COLUMN, so we need to recreate the table
      // Build column list from existing columns to handle schema differences
      const targetCols = [
        'id', 'folder_path', 'model_id', 'collection_code', 'type_code', 'product_code',
        'series_number', 'title', 'description', 'licensor_collection', 'option_name',
        'needs_measurement_review', 'needs_pricing_review', 'needs_final_photography',
        'not_approved_for_publishing', 'photo_order', 'source_folder', 'shopify_product_id',
        'push_status', 'last_pushed_at', 'last_push_error', 'created_at', 'updated_at'
      ];
      const commonCols = targetCols.filter(c => existingColNames.includes(c));
      const colList = commonCols.join(', ');

      // Create new table with correct schema
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
      `);

      // Copy existing data (only common columns)
      db.prepare(`INSERT INTO shopify_products_new (${colList}) SELECT ${colList} FROM shopify_products`).run();

      // Drop old table and rename new one
      db.exec('DROP TABLE shopify_products');
      db.exec('ALTER TABLE shopify_products_new RENAME TO shopify_products');

      console.log('[Shopify] Migration complete - NOT NULL constraints removed');
    }

    // Migration: Add missing columns for existing installs
    const productCols = db.prepare("PRAGMA table_info(shopify_products)").all();
    const productColNames = productCols.map(c => c.name);
    console.log('[Shopify] Current shopify_products columns:', productColNames.join(', '));

    // Add model_id if missing (critical for reconciliation)
    if (!productColNames.includes('model_id')) {
      console.log('[Shopify] Migrating: adding model_id column...');
      db.prepare('ALTER TABLE shopify_products ADD COLUMN model_id INTEGER').run();
      console.log('[Shopify] Added model_id column');
    }

    // Add folder_path if missing (new folder-based reconciliation)
    if (!productColNames.includes('folder_path')) {
      console.log('[Shopify] Migrating: adding folder_path column...');
      db.prepare('ALTER TABLE shopify_products ADD COLUMN folder_path TEXT').run();
      console.log('[Shopify] Added folder_path column');
      // Backfill folder_path from existing model_id entries
      db.prepare(`
        UPDATE shopify_products
        SET folder_path = (
          SELECT REPLACE(
            SUBSTR(REPLACE(m.filePath, '\\', '/'), 1,
              LENGTH(REPLACE(m.filePath, '\\', '/')) - LENGTH(m.fileName) - 1),
            '\\', '/'
          )
          FROM models m WHERE m.id = shopify_products.model_id
        )
        WHERE model_id IS NOT NULL AND folder_path IS NULL
      `).run();
      console.log('[Shopify] Backfilled folder_path from existing entries');
    }

    // Add option_name if missing
    if (!productColNames.includes('option_name')) {
      console.log('[Shopify] Migrating: adding option_name column...');
      db.prepare("ALTER TABLE shopify_products ADD COLUMN option_name TEXT DEFAULT 'Finish'").run();
      console.log('[Shopify] Added option_name column');
    }

    // Verify critical columns exist after migration
    const verifyColumns = db.prepare("PRAGMA table_info(shopify_products)").all();
    const verifyColNames = verifyColumns.map(c => c.name);
    if (!verifyColNames.includes('model_id')) {
      console.error('[Shopify] CRITICAL: model_id column still missing after migration!');
      throw new Error('Shopify migration failed: model_id column not added');
    }
    if (!verifyColNames.includes('folder_path')) {
      console.error('[Shopify] CRITICAL: folder_path column still missing after migration!');
      throw new Error('Shopify migration failed: folder_path column not added');
    }

    // Indexes for performance
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_products_model ON shopify_products(model_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_products_folder ON shopify_products(folder_path)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_products_shopify_id ON shopify_products(shopify_product_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_products_push_status ON shopify_products(push_status)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_variants_product ON shopify_variants(product_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_variants_sku ON shopify_variants(sku)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_variants_shopify_id ON shopify_variants(shopify_variant_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_product_types_code ON shopify_product_types(code)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_collection_codes_code ON shopify_collection_codes(code)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_product_files_folder ON shopify_product_files(folder_path)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_product_files_model ON shopify_product_files(model_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_product_files_status ON shopify_product_files(link_status)').run();

    // Migration: Add variant mapping columns to shopify_product_files
    const productFilesCols = db.prepare("PRAGMA table_info(shopify_product_files)").all();
    const productFilesColNames = productFilesCols.map(c => c.name);

    if (!productFilesColNames.includes('shopify_variant_id')) {
      console.log('[Shopify] Migrating: adding shopify_variant_id column to shopify_product_files...');
      db.prepare('ALTER TABLE shopify_product_files ADD COLUMN shopify_variant_id TEXT').run();
      console.log('[Shopify] Added shopify_variant_id column');
    }

    if (!productFilesColNames.includes('variant_option_value')) {
      console.log('[Shopify] Migrating: adding variant_option_value column to shopify_product_files...');
      db.prepare('ALTER TABLE shopify_product_files ADD COLUMN variant_option_value TEXT').run();
      console.log('[Shopify] Added variant_option_value column');
    }

    // Index for variant lookups
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_product_files_variant ON shopify_product_files(shopify_variant_id)').run();

    // Moved below the shopify_product_files column migrations (was previously
    // positioned before them, which meant it queried shopify_variant_id /
    // variant_option_value before those columns existed on a fresh DB -
    // crashing ensureShopifyTablesExist() before it ever reached
    // CREATE TABLE shopify_orders.
    // One-time backfill from the old per-file column into the new
    // per-variant table, so assignments already confirmed before this
    // change (e.g. GR-LAD-SET's variants) aren't lost. Guarded on the new
    // table being empty so it only ever runs once - once James reassigns a
    // variant here, the old shopify_product_files.shopify_variant_id value
    // for that row is stale and must not be re-copied over a newer choice.
    const variantLinksCountRow = db.prepare('SELECT COUNT(*) AS n FROM shopify_variant_file_links').get();
    if (!variantLinksCountRow || variantLinksCountRow.n === 0) {
      const legacyAssignments = db.prepare(`
        SELECT folder_path, shopify_variant_id, model_id, variant_option_value
        FROM shopify_product_files
        WHERE shopify_variant_id IS NOT NULL
      `).all();
      if (legacyAssignments.length > 0) {
        console.log(`[Shopify] Backfilling ${legacyAssignments.length} variant->file assignment(s) into shopify_variant_file_links...`);
        const insertLink = db.prepare(`
          INSERT OR IGNORE INTO shopify_variant_file_links (folder_path, shopify_variant_id, model_id, variant_option_value)
          VALUES (?, ?, ?, ?)
        `);
        for (const row of legacyAssignments) {
          insertLink.run(row.folder_path, row.shopify_variant_id, row.model_id, row.variant_option_value);
        }
      }
    }
    // One-time migration: Clear auto-matched variant mappings (filename matching was unreliable)
    // Uses a settings flag to ensure this only runs once
    const variantCleanupDone = db.prepare("SELECT value FROM settings WHERE key = 'variant_mapping_cleanup_v1'").get();
    if (!variantCleanupDone) {
      const countBefore = db.prepare("SELECT COUNT(*) as cnt FROM shopify_product_files WHERE shopify_variant_id IS NOT NULL").get();
      if (countBefore.cnt > 0) {
        console.log(`[Shopify] Clearing ${countBefore.cnt} auto-matched variant mappings (filename matching was unreliable)...`);
        db.prepare("UPDATE shopify_product_files SET shopify_variant_id = NULL, variant_option_value = NULL WHERE shopify_variant_id IS NOT NULL").run();
        console.log('[Shopify] Variant mappings cleared - use manual assignment in editor');
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('variant_mapping_cleanup_v1', '1')").run();
    }

    // Seed default product types if table is empty
    const typeCount = db.prepare('SELECT COUNT(*) as count FROM shopify_product_types').get();
    if (typeCount.count === 0) {
      console.log('Seeding default product types...');
      const defaultTypes = [
        { code: 'FIG', name: 'Figure' },
        { code: 'ORN', name: 'Ornament' },
        { code: 'BOX', name: 'Box / Container' },
        { code: 'ART', name: 'Articulated' },
        { code: 'DEC', name: 'Decoration' },
        { code: 'KEY', name: 'Keychain' },
        { code: 'MAG', name: 'Magnet' },
        { code: 'PLT', name: 'Planter' },
        { code: 'SGN', name: 'Sign / Nameplate' },
        { code: 'TOY', name: 'Toy / Fidget' },
        { code: 'UTL', name: 'Utility / Functional' },
        { code: 'OTH', name: 'Other' }
      ];
      const insertType = db.prepare('INSERT INTO shopify_product_types (code, name) VALUES (?, ?)');
      for (const t of defaultTypes) {
        insertType.run(t.code, t.name);
      }
      console.log(`Seeded ${defaultTypes.length} default product types`);
    }

    // --- GR-PLAN-006: order sync tables ---
    // One row per Shopify order. fulfillment/financial status mirror Shopify's
    // own (read-only, refreshed on every sync); local_status is Printventory's
    // own rollup (new / printing / printed / shipped) and is never written
    // back to Shopify until the Phase C fulfillment push.
    db.prepare(`CREATE TABLE IF NOT EXISTS shopify_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shopify_order_gid TEXT UNIQUE NOT NULL,
        order_name TEXT NOT NULL,
        order_created_at DATETIME,
        customer_name TEXT,
        total_amount REAL,
        total_currency TEXT,
        financial_status TEXT,
        fulfillment_status TEXT,
        local_status TEXT DEFAULT 'new',
        tracking_carrier TEXT,
        tracking_number TEXT,
        tracking_url TEXT,
        fulfilled_at DATETIME,
        last_synced_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();

    // One row per order line item. matched_model_id is set once the SKU is
    // resolved to a Printventory product (auto-matched on sync, or manually
    // linked through the same reconciliation UI as GR-PLAN-004's folder
    // linking). quantity_printed supports partial progress on a
    // quantity > 1 line without a separate row per unit.
    db.prepare(`CREATE TABLE IF NOT EXISTS shopify_order_line_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        shopify_line_item_gid TEXT NOT NULL,
        sku TEXT,
        title TEXT,
        variant_title TEXT,
        unit_price REAL,
        unit_price_currency TEXT,
        shopify_image_url TEXT,
        shopify_product_gid TEXT,
        shopify_variant_gid TEXT,
        quantity_ordered INTEGER NOT NULL DEFAULT 1,
        quantity_printed INTEGER NOT NULL DEFAULT 0,
        matched_model_id INTEGER,
        matched_shopify_product_id INTEGER,
        link_status TEXT DEFAULT 'unmatched',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(order_id) REFERENCES shopify_orders(id) ON DELETE CASCADE,
        FOREIGN KEY(matched_model_id) REFERENCES models(id) ON DELETE SET NULL,
        FOREIGN KEY(matched_shopify_product_id) REFERENCES shopify_products(id) ON DELETE SET NULL,
        UNIQUE(order_id, shopify_line_item_gid)
    )`).run();

    // Migration: columns added after the initial GR-PLAN-006 table (variant
    // detail/price/image for the redesigned Orders pane card, plus the raw
    // Shopify product gid used for the product-level-link fallback match).
    const orderLineItemCols = db.prepare("PRAGMA table_info(shopify_order_line_items)").all();
    const orderLineItemColNames = orderLineItemCols.map(c => c.name);
    const orderLineItemMigrations = [
      ['variant_title', 'TEXT'],
      ['unit_price', 'REAL'],
      ['unit_price_currency', 'TEXT'],
      ['shopify_image_url', 'TEXT'],
      ['shopify_product_gid', 'TEXT'],
      ['shopify_variant_gid', 'TEXT']
    ];
    for (const [colName, colType] of orderLineItemMigrations) {
      if (!orderLineItemColNames.includes(colName)) {
        console.log(`[Shopify] Migrating: adding ${colName} column to shopify_order_line_items...`);
        db.prepare(`ALTER TABLE shopify_order_line_items ADD COLUMN ${colName} ${colType}`).run();
      }
    }

    // GR-PLAN-006: James - "is it logged correctly? ... its critical it
    // works as etsy requires tracking info in order to release its
    // reserve." Before this, the only record of a fulfillment push was a
    // console.log in shopify.js's createFulfillment() - invisible in a
    // packaged build (main-process console.log has nowhere to go once
    // there's no terminal attached), and even in dev mode it only showed
    // what WE sent, never what Shopify actually confirmed back. This table
    // is a permanent, queryable audit trail for every push attempt
    // (success or failure), independent of any log file or dev console.
    db.prepare(`CREATE TABLE IF NOT EXISTS shopify_fulfillment_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        carrier_sent TEXT,
        tracking_number_sent TEXT,
        tracking_url_sent TEXT,
        success INTEGER NOT NULL,
        shopify_fulfillment_gid TEXT,
        confirmed_carrier TEXT,
        confirmed_number TEXT,
        confirmed_url TEXT,
        error_message TEXT,
        FOREIGN KEY(order_id) REFERENCES shopify_orders(id) ON DELETE CASCADE
    )`).run();

    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_orders_gid ON shopify_orders(shopify_order_gid)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_orders_local_status ON shopify_orders(local_status)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_order_line_items_order_id ON shopify_order_line_items(order_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_order_line_items_sku ON shopify_order_line_items(sku)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_order_line_items_link_status ON shopify_order_line_items(link_status)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_shopify_fulfillment_log_order_id ON shopify_fulfillment_log(order_id)').run();

    console.log('Shopify tables ensured');
    return true;
  } catch (error) {
    console.error('Error ensuring Shopify tables exist:', error);
    return false;
  }
}

module.exports = { ensureShopifyTablesExist };
