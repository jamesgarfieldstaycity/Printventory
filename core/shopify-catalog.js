// core/shopify-catalog.js
//
// GR-PLAN-007 Phase 2: the Shopify catalog-side IPC handler logic (settings,
// product types, collection codes, product listings, media, inventory, push,
// fetch) moved out of main.js. The bodies are moved verbatim; the only edits
// are mechanical:
//   - `db` is an explicit first parameter. main.js reassigns its module-level
//     `db` on backup/restore/purge, so its wrappers read `db` at call time and
//     pass the current handle in.
//   - there are no Electron globals here (no ipcMain, mainWindow, event,
//     global.sendEvent). main.js keeps the ipcMain.handle(...) registrations
//     and the thin wrappers that call into this module.
//   - the `...Handler` suffix is dropped from the exported names.
// shopify.js (the GraphQL client) is untouched; this module just requires it.
//
// Dependency direction (acyclic): shopify-catalog <- shopify-orders <-
// shopify-reconciliation.

const fs = require('fs');
const path = require('path');

const shopifyApi = require('../shopify');

/**
 * Read Shopify settings from database, with optional overrides.
 */
function readShopifySettings(db, overrides = {}) {
  const domainRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('shopifyStoreDomain');
  const clientIdRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('shopifyClientId');
  const clientSecretRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('shopifyClientSecret');
  const versionRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('shopifyApiVersion');
  return {
    storeDomain: (overrides.storeDomain ?? domainRow?.value ?? '').trim(),
    clientId: (overrides.clientId ?? clientIdRow?.value ?? '').trim(),
    clientSecret: (overrides.clientSecret ?? clientSecretRow?.value ?? '').trim(),
    apiVersion: overrides.apiVersion ?? (versionRow?.value || '2024-10')
  };
}

/**
 * Get all Shopify settings (without exposing the client secret).
 */
async function getShopifySettings(db) {
  try {
    const settings = readShopifySettings(db, db);
    return {
      storeDomain: settings.storeDomain,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret ? '********' : '', // Mask the secret
      apiVersion: settings.apiVersion,
      hasCredentials: !!(settings.clientId && settings.clientSecret)
    };
  } catch (error) {
    console.error('Error getting Shopify settings:', error);
    throw error;
  }
}

/**
 * Save Shopify settings.
 */
async function saveShopifySettings(db, settings) {
  try {
    const { storeDomain, clientId, clientSecret, apiVersion } = settings;

    if (storeDomain !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run('shopifyStoreDomain', String(storeDomain || '').trim());
    }
    if (clientId !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run('shopifyClientId', String(clientId || '').trim());
    }
    // Only update client secret if a new value is provided (not the masked value)
    if (clientSecret !== undefined && clientSecret !== '********') {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run('shopifyClientSecret', String(clientSecret || '').trim());
    }
    if (apiVersion !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run('shopifyApiVersion', String(apiVersion || '2024-10').trim());
    }

    // Clear the token cache when credentials change
    const domain = storeDomain || db.prepare('SELECT value FROM settings WHERE key = ?').get('shopifyStoreDomain')?.value || '';
    const id = clientId || db.prepare('SELECT value FROM settings WHERE key = ?').get('shopifyClientId')?.value || '';
    if (domain && id) {
      shopifyApi.clearTokenCache(domain, id);
    }

    return { success: true };
  } catch (error) {
    console.error('Error saving Shopify settings:', error);
    throw error;
  }
}

/**
 * Test Shopify API connection using Client Credentials Grant.
 */
async function testShopifyConnection(db, storeDomain, clientId, clientSecret) {
  try {
    // Use provided values or fall back to stored settings
    const settings = readShopifySettings(db, { storeDomain, clientId, clientSecret });

    if (!settings.storeDomain) {
      throw new Error('Store domain is required (must be *.myshopify.com domain)');
    }
    if (!settings.clientId) {
      throw new Error('Client ID is required');
    }
    if (!settings.clientSecret) {
      throw new Error('Client Secret is required');
    }

    // Validate the domain format
    if (!settings.storeDomain.endsWith('.myshopify.com')) {
      throw new Error(`Store domain must be a *.myshopify.com domain, got: ${settings.storeDomain}`);
    }

    console.log('[Shopify Test] Testing connection with Client Credentials Grant...');
    console.log('[Shopify Test] Store domain:', settings.storeDomain);
    console.log('[Shopify Test] Client ID:', settings.clientId);

    // Use the shopify.js module which handles Client Credentials Grant
    const result = await shopifyApi.testConnection(
      settings.storeDomain,
      settings.clientId,
      settings.clientSecret
    );

    return {
      success: true,
      shopName: result.shopName,
      currency: result.currency
    };
  } catch (error) {
    console.error('Error testing Shopify connection:', error);
    throw error;
  }
}

/**
 * Get all product types.
 */
async function getShopifyProductTypes(db) {
  try {
    const types = db.prepare('SELECT id, code, name, created_at FROM shopify_product_types ORDER BY name').all();
    return types;
  } catch (error) {
    console.error('Error getting Shopify product types:', error);
    throw error;
  }
}

/**
 * Save (create or update) a product type.
 */
async function saveShopifyProductType(db, productType) {
  try {
    const { id, code, name } = productType;
    const codeUpper = (code || '').toUpperCase().trim();
    const nameTrimmed = (name || '').trim();

    if (!codeUpper || !nameTrimmed) {
      throw new Error('Code and name are required');
    }

    if (id) {
      // Update existing
      db.prepare('UPDATE shopify_product_types SET code = ?, name = ? WHERE id = ?')
        .run(codeUpper, nameTrimmed, id);
      return { id, code: codeUpper, name: nameTrimmed };
    } else {
      // Create new
      const result = db.prepare('INSERT INTO shopify_product_types (code, name) VALUES (?, ?)')
        .run(codeUpper, nameTrimmed);
      return { id: result.lastInsertRowid, code: codeUpper, name: nameTrimmed };
    }
  } catch (error) {
    console.error('Error saving Shopify product type:', error);
    throw error;
  }
}

/**
 * Delete a product type (if not in use).
 */
async function deleteShopifyProductType(db, typeId) {
  try {
    // Check if in use
    const inUse = db.prepare('SELECT COUNT(*) as count FROM shopify_products WHERE type_code = (SELECT code FROM shopify_product_types WHERE id = ?)')
      .get(typeId);
    if (inUse && inUse.count > 0) {
      throw new Error('Cannot delete product type that is in use');
    }
    db.prepare('DELETE FROM shopify_product_types WHERE id = ?').run(typeId);
    return { success: true };
  } catch (error) {
    console.error('Error deleting Shopify product type:', error);
    throw error;
  }
}

/**
 * Get all collection codes.
 */
async function getShopifyCollectionCodes(db) {
  try {
    const codes = db.prepare('SELECT id, code, name, created_at FROM shopify_collection_codes ORDER BY name').all();
    return codes;
  } catch (error) {
    console.error('Error getting Shopify collection codes:', error);
    throw error;
  }
}

/**
 * Suggest a collection code based on folder name.
 * Returns a suggested 3-letter code and validates uniqueness.
 */
async function suggestShopifyCollectionCode(db, folderName) {
  try {
    const name = (folderName || '').trim();
    if (!name) {
      return { suggestedCode: '', isUnique: false };
    }

    // Generate a 3-letter code from the folder name
    // First try first 3 letters
    let suggestedCode = name.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, '');

    // If we don't have 3 letters, try to extract consonants or pad with X
    if (suggestedCode.length < 3) {
      const consonants = name.toUpperCase().replace(/[^BCDFGHJKLMNPQRSTVWXYZ]/g, '');
      const vowels = name.toUpperCase().replace(/[^AEIOU]/g, '');
      suggestedCode = (consonants + vowels + 'XXX').substring(0, 3);
    }

    // Check if this code is unique
    const existing = db.prepare('SELECT code FROM shopify_collection_codes WHERE code = ?').get(suggestedCode);
    const isUnique = !existing;

    return { suggestedCode, isUnique, name };
  } catch (error) {
    console.error('Error suggesting collection code:', error);
    throw error;
  }
}

/**
 * Save (create or update) a collection code.
 */
async function saveShopifyCollectionCode(db, collectionCode) {
  try {
    const { id, code, name } = collectionCode;
    const codeUpper = (code || '').toUpperCase().trim();
    const nameTrimmed = (name || '').trim();

    if (!codeUpper || !nameTrimmed) {
      throw new Error('Code and name are required');
    }

    if (id) {
      // Update existing
      db.prepare('UPDATE shopify_collection_codes SET code = ?, name = ? WHERE id = ?')
        .run(codeUpper, nameTrimmed, id);
      return { id, code: codeUpper, name: nameTrimmed };
    } else {
      // Create new
      const result = db.prepare('INSERT INTO shopify_collection_codes (code, name) VALUES (?, ?)')
        .run(codeUpper, nameTrimmed);
      return { id: result.lastInsertRowid, code: codeUpper, name: nameTrimmed };
    }
  } catch (error) {
    console.error('Error saving Shopify collection code:', error);
    throw error;
  }
}

/**
 * Delete a collection code (if not in use).
 */
async function deleteShopifyCollectionCode(db, codeId) {
  try {
    // Check if in use
    const inUse = db.prepare('SELECT COUNT(*) as count FROM shopify_products WHERE collection_code = (SELECT code FROM shopify_collection_codes WHERE id = ?)')
      .get(codeId);
    if (inUse && inUse.count > 0) {
      throw new Error('Cannot delete collection code that is in use');
    }
    db.prepare('DELETE FROM shopify_collection_codes WHERE id = ?').run(codeId);
    return { success: true };
  } catch (error) {
    console.error('Error deleting Shopify collection code:', error);
    throw error;
  }
}

// Private copy of main.js getSettingValueOr, with `db` passed in. Semantics are
// identical (swallows errors, returns the fallback for a missing or empty value,
// does not trim) and deliberately differ from readShopifySettings.
function getSettingValueOr(db, key, fallback) {
  try {
    if (!db) return fallback;
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value != null && row.value !== '') return row.value;
  } catch (_) { /* ignore */ }
  return fallback;
}

/**
 * Get all Shopify products with optional filters.
 */
async function getShopifyProducts(db, filters = {}) {
  try {
    let query = `SELECT sp.* FROM shopify_products sp`;
    const params = [];
    const conditions = [];

    if (filters.push_status) {
      conditions.push('sp.push_status = ?');
      params.push(filters.push_status);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY sp.created_at DESC';

    const products = db.prepare(query).all(...params);
    return products.map(p => ({
      ...p,
      model_ids: p.model_id ? [p.model_id] : []
    }));
  } catch (error) {
    console.error('Error getting Shopify products:', error);
    throw error;
  }
}

/**
 * Get a single Shopify product by ID.
 */
async function getShopifyProduct(db, productId) {
  try {
    const product = db.prepare(`SELECT * FROM shopify_products WHERE id = ?`).get(productId);

    if (!product) return null;

    return {
      ...product,
      model_ids: product.model_id ? [product.model_id] : []
    };
  } catch (error) {
    console.error('Error getting Shopify product:', error);
    throw error;
  }
}

/**
 * Get Shopify product by linked model ID.
 * Checks both shopify_products.model_id (primary file) and shopify_product_files (all files).
 */
async function getShopifyProductByModel(db, modelId) {
  try {
    // First check if this is the primary model
    let product = db.prepare(`SELECT * FROM shopify_products WHERE model_id = ?`).get(modelId);
    if (product) return product;

    // Check if this model is linked via shopify_product_files
    const fileEntry = db.prepare(`
      SELECT spf.folder_path, spf.link_status
      FROM shopify_product_files spf
      WHERE spf.model_id = ? AND spf.link_status = 'linked'
    `).get(modelId);

    if (fileEntry) {
      // Find the shopify_products entry for this folder
      product = db.prepare(`SELECT * FROM shopify_products WHERE folder_path = ?`).get(fileEntry.folder_path);
      return product || null;
    }

    return null;
  } catch (error) {
    console.error('Error getting Shopify product by model:', error);
    throw error;
  }
}

/**
 * Fetch live Shopify data for a linked product.
 * Returns current Shopify data including title, description, tags, price, and all variants.
 */
async function fetchLiveShopifyData(db, localProductId) {
  try {
    const product = db.prepare('SELECT * FROM shopify_products WHERE id = ?').get(localProductId);
    if (!product) {
      throw new Error('Local product not found');
    }

    if (!product.shopify_product_id) {
      throw new Error('Product is not linked to Shopify');
    }

    const settings = readShopifySettings(db, db);
    if (!settings.storeDomain || !settings.clientId || !settings.clientSecret) {
      throw new Error('Shopify credentials not configured');
    }

    console.log('[Shopify] Fetching live data for product:', product.shopify_product_id);
    const shopifyData = await shopifyApi.fetchProductWithVariants(
      settings.storeDomain,
      settings.clientId,
      settings.clientSecret,
      product.shopify_product_id
    );

    // Keep the local shopify_variants mirror in sync with live Shopify
    // data on every refresh, not just at initial link time. The plain
    // Variants table renders straight from shopifyData.variants (always
    // fresh), but the Variant Assignments dialog reads this local table -
    // so a rename or a newly added variant done directly in the Shopify
    // admin (the recommended path for that today) never reached that
    // dialog until some separate backfill ran. Same delete+reinsert
    // pattern used at initial-link and in the manual backfill tool - safe
    // because shopify_variant_file_links keys on the Shopify variant gid
    // string, not this table's local row id, so re-inserting doesn't
    // disturb any existing file assignments.
    try {
      db.prepare('DELETE FROM shopify_variants WHERE product_id = ?').run(product.id);
      const insertVariant = db.prepare(`
        INSERT INTO shopify_variants (product_id, variant_number, option_value, sku, price, compare_at_price, inventory_quantity, shopify_variant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let variantNum = 1;
      for (const variant of (shopifyData.variants || [])) {
        insertVariant.run(
          product.id,
          variantNum++,
          variant.optionValue || variant.title || `Variant ${variantNum}`,
          variant.sku || null,
          variant.price ? parseFloat(variant.price) : null,
          variant.compareAtPrice ? parseFloat(variant.compareAtPrice) : null,
          variant.inventoryQuantity ?? null,
          variant.id
        );
      }
    } catch (syncError) {
      // Never let the local mirror sync break the live data view itself.
      console.error('Error syncing shopify_variants from live data:', syncError);
    }

    return {
      localProduct: product,
      shopifyData: shopifyData
    };
  } catch (error) {
    console.error('Error fetching live Shopify data:', error);
    throw error;
  }
}

/**
 * Update a linked Shopify product with new data.
 * Pushes changes to title, description, and variant prices/SKUs back to Shopify.
 */
async function updateLinkedShopifyProduct(db, localProductId, updates) {
  try {
    const product = db.prepare('SELECT * FROM shopify_products WHERE id = ?').get(localProductId);
    if (!product) {
      throw new Error('Local product not found');
    }

    if (!product.shopify_product_id) {
      throw new Error('Product is not linked to Shopify');
    }

    const settings = readShopifySettings(db, db);
    if (!settings.storeDomain || !settings.clientId || !settings.clientSecret) {
      throw new Error('Shopify credentials not configured');
    }

    console.log('[Shopify] Updating linked product:', product.shopify_product_id);

    // Update the product (title, description, tags, SEO)
    await shopifyApi.updateProduct(
      settings.storeDomain,
      settings.clientId,
      settings.clientSecret,
      product.shopify_product_id,
      {
        title: updates.title,
        description: updates.description,
        licensor_collection: updates.vendor,
        tags: updates.tags || [],
        seo: updates.seo || null
      }
    );

    // Update variants if provided (using bulk update API)
    if (updates.variants && Array.isArray(updates.variants)) {
      const variantsToUpdate = updates.variants
        .filter(v => v.id)
        .map(v => ({
          id: v.id,
          price: v.price,
          sku: v.sku
        }));

      if (variantsToUpdate.length > 0) {
        await shopifyApi.updateVariantsBulk(
          settings.storeDomain,
          settings.clientId,
          settings.clientSecret,
          product.shopify_product_id,
          variantsToUpdate
        );
      }
    }

    // Update local record with new title/description
    db.prepare(`
      UPDATE shopify_products SET
        title = ?,
        description = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(updates.title, updates.description, localProductId);

    return { success: true };
  } catch (error) {
    console.error('Error updating linked Shopify product:', error);
    throw error;
  }
}

/**
 * Delete media from a Shopify product.
 */
async function deleteShopifyProductMedia(db, shopifyProductId, mediaIds) {
  try {
    const settings = readShopifySettings(db, db);
    if (!settings.storeDomain || !settings.clientId || !settings.clientSecret) {
      throw new Error('Shopify credentials not configured');
    }

    console.log('[Shopify] Deleting media from product:', shopifyProductId);
    const result = await shopifyApi.deleteProductMedia(
      settings.storeDomain,
      settings.clientId,
      settings.clientSecret,
      shopifyProductId,
      mediaIds
    );

    return result;
  } catch (error) {
    console.error('Error deleting Shopify media:', error);
    throw error;
  }
}

/**
 * Upload images to a Shopify product.
 */
async function uploadShopifyProductImages(db, shopifyProductId, images) {
  try {
    const settings = readShopifySettings(db, db);
    if (!settings.storeDomain || !settings.clientId || !settings.clientSecret) {
      throw new Error('Shopify credentials not configured');
    }

    console.log('[Shopify] Uploading images to product:', shopifyProductId);

    // Read image data from paths
    const imageData = [];
    for (const img of images) {
      const fs = require('fs');
      const path = require('path');
      const data = fs.readFileSync(img.path);
      const ext = path.extname(img.filename).toLowerCase();
      const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
      };
      imageData.push({
        filename: img.filename,
        data: data,
        mimeType: mimeTypes[ext] || 'image/jpeg',
        alt: img.alt || ''
      });
    }

    const result = await shopifyApi.uploadProductImages(
      settings.storeDomain,
      settings.clientId,
      settings.clientSecret,
      shopifyProductId,
      imageData
    );

    return result;
  } catch (error) {
    console.error('Error uploading Shopify images:', error);
    throw error;
  }
}

/**
 * Reorder media on a Shopify product.
 */
async function reorderShopifyProductMedia(db, shopifyProductId, moves) {
  try {
    const settings = readShopifySettings(db, db);
    if (!settings.storeDomain || !settings.clientId || !settings.clientSecret) {
      throw new Error('Shopify credentials not configured');
    }

    console.log('[Shopify] Reordering media on product:', shopifyProductId);
    const result = await shopifyApi.reorderProductMedia(
      settings.storeDomain,
      settings.clientId,
      settings.clientSecret,
      shopifyProductId,
      moves
    );

    return result;
  } catch (error) {
    console.error('Error reordering Shopify media:', error);
    throw error;
  }
}

/**
 * Set inventory quantities for Shopify variants.
 * Uses inventorySetQuantities mutation (2024-10 API).
 */
async function setShopifyInventory(db, updates) {
  try {
    const storeDomain = getSettingValueOr(db, 'shopifyStoreDomain', '');
    const clientId = getSettingValueOr(db, 'shopifyClientId', '');
    const clientSecret = getSettingValueOr(db, 'shopifyClientSecret', '');

    if (!storeDomain || !clientId || !clientSecret) {
      throw new Error('Shopify API credentials not configured');
    }

    // updates is an array of { variantId, quantity }
    const result = await shopifyApi.setInventoryQuantities(storeDomain, clientId, clientSecret, updates);

    return result;
  } catch (error) {
    console.error('[Shopify] Error setting inventory:', error);
    throw error;
  }
}

/**
 * Save (create or update) a Shopify product.
 */
async function saveShopifyProduct(db, productData) {
  try {
    const {
      id,
      collection_code,
      type_code,
      product_code,
      series_number,
      variant_number,
      title,
      description,
      price,
      licensor_collection,
      needs_measurement_review,
      needs_pricing_review,
      needs_final_photography,
      not_approved_for_publishing,
      photo_order,
      source_folder,
      model_id
    } = productData;

    // Build SKU
    const sku = `GR-${collection_code}-${type_code}-${product_code}-${String(series_number).padStart(3, '0')}-${String(variant_number || 1).padStart(2, '0')}`;

    if (id) {
      // Update existing
      db.prepare(`
        UPDATE shopify_products SET
          collection_code = ?,
          type_code = ?,
          product_code = ?,
          series_number = ?,
          variant_number = ?,
          sku = ?,
          title = ?,
          description = ?,
          price = ?,
          licensor_collection = ?,
          needs_measurement_review = ?,
          needs_pricing_review = ?,
          needs_final_photography = ?,
          not_approved_for_publishing = ?,
          photo_order = ?,
          source_folder = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        collection_code, type_code, product_code, series_number, variant_number || 1, sku,
        title, description, price, licensor_collection,
        needs_measurement_review ? 1 : 0,
        needs_pricing_review ? 1 : 0,
        needs_final_photography ? 1 : 0,
        not_approved_for_publishing ? 1 : 0,
        photo_order ? JSON.stringify(photo_order) : null,
        source_folder,
        id
      );
      return { id, sku };
    } else {
      // Create new
      const result = db.prepare(`
        INSERT INTO shopify_products (
          collection_code, type_code, product_code, series_number, variant_number, sku,
          title, description, price, licensor_collection,
          needs_measurement_review, needs_pricing_review, needs_final_photography, not_approved_for_publishing,
          photo_order, source_folder
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        collection_code, type_code, product_code, series_number, variant_number || 1, sku,
        title, description, price, licensor_collection,
        needs_measurement_review ? 1 : 0,
        needs_pricing_review ? 1 : 0,
        needs_final_photography ? 1 : 0,
        not_approved_for_publishing ? 1 : 0,
        photo_order ? JSON.stringify(photo_order) : null,
        source_folder
      );

      const newId = result.lastInsertRowid;

      // Link to model if provided (update model_id on the product)
      if (model_id) {
        db.prepare('UPDATE shopify_products SET model_id = ? WHERE id = ?').run(model_id, newId);
      }

      return { id: newId, sku };
    }
  } catch (error) {
    console.error('Error saving Shopify product:', error);
    throw error;
  }
}

/**
 * Delete a Shopify product (local only).
 */
async function deleteShopifyProduct(db, productId) {
  try {
    db.prepare('DELETE FROM shopify_products WHERE id = ?').run(productId);
    return { success: true };
  } catch (error) {
    console.error('Error deleting Shopify product:', error);
    throw error;
  }
}

/**
 * Unlink a model from its Shopify product.
 * This removes the model_id reference but keeps the Shopify product record.
 */
async function unlinkShopifyProduct(db, modelId) {
  try {
    if (!modelId) throw new Error('modelId is required');

    // Clear model_id from shopify_products
    db.prepare('UPDATE shopify_products SET model_id = NULL WHERE model_id = ?').run(modelId);

    console.log(`[Shopify] Unlinked model ${modelId} from Shopify product`);
    return { success: true };
  } catch (error) {
    console.error('Error unlinking Shopify product:', error);
    throw error;
  }
}

/**
 * Get Shopify products that can be linked to a model.
 * Returns products that have a shopify_product_id (are pushed to Shopify).
 */
async function getLinkableShopifyProducts(db, excludeModelId) {
  try {
    const products = db.prepare(`
      SELECT
        sp.id,
        sp.title,
        sp.shopify_product_id,
        sp.folder_path,
        sp.push_status,
        (SELECT GROUP_CONCAT(sv.sku, ', ') FROM shopify_variants sv WHERE sv.product_id = sp.id) as skus
      FROM shopify_products sp
      WHERE sp.shopify_product_id IS NOT NULL
        AND sp.shopify_product_id != ''
      ORDER BY sp.title
    `).all();

    return products;
  } catch (error) {
    console.error('Error getting linkable Shopify products:', error);
    throw error;
  }
}

/**
 * Link a model to an existing Shopify product.
 */
async function linkModelToShopifyProduct(db, modelId, shopifyLocalProductId) {
  try {
    if (!modelId) throw new Error('modelId is required');
    if (!shopifyLocalProductId) throw new Error('shopifyLocalProductId is required');

    // Update the shopify_products record to link to this model
    db.prepare('UPDATE shopify_products SET model_id = ? WHERE id = ?').run(modelId, shopifyLocalProductId);

    console.log(`[Shopify] Linked model ${modelId} to local Shopify product ${shopifyLocalProductId}`);
    return { success: true };
  } catch (error) {
    console.error('Error linking model to Shopify product:', error);
    throw error;
  }
}

/**
 * Get the next series number for a collection+type combination.
 */
async function getNextSeriesNumber(db, collectionCode, typeCode) {
  try {
    const row = db.prepare(`
      SELECT last_series FROM shopify_series_counter
      WHERE collection_code = ? AND type_code = ?
    `).get(collectionCode, typeCode);

    const nextSeries = (row?.last_series || 0) + 1;
    return { nextSeries };
  } catch (error) {
    console.error('Error getting next series number:', error);
    throw error;
  }
}

/**
 * Allocate and reserve a series number.
 */
async function allocateSeriesNumber(db, collectionCode, typeCode) {
  try {
    const row = db.prepare(`
      SELECT last_series FROM shopify_series_counter
      WHERE collection_code = ? AND type_code = ?
    `).get(collectionCode, typeCode);

    const nextSeries = (row?.last_series || 0) + 1;

    db.prepare(`
      INSERT INTO shopify_series_counter (collection_code, type_code, last_series)
      VALUES (?, ?, ?)
      ON CONFLICT(collection_code, type_code) DO UPDATE SET last_series = excluded.last_series
    `).run(collectionCode, typeCode, nextSeries);

    return { series: nextSeries };
  } catch (error) {
    console.error('Error allocating series number:', error);
    throw error;
  }
}

/**
 * Generate a product code from the product name.
 */
async function generateProductCode(db, productName) {
  try {
    // Extract alphanumeric characters and limit to 6 characters
    const code = (productName || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .substring(0, 6);
    return { code: code || 'PROD' };
  } catch (error) {
    console.error('Error generating product code:', error);
    throw error;
  }
}

/**
 * Get images from a folder.
 */
async function getProductFolderImages(db, folderPath) {
  try {
    if (!folderPath || !fs.existsSync(folderPath)) {
      return [];
    }

    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const files = fs.readdirSync(folderPath);

    const images = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return imageExtensions.includes(ext);
      })
      .map(file => {
        const filePath = path.join(folderPath, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          path: filePath,
          size: stats.size,
          modifiedTime: stats.mtime.toISOString()
        };
      })
      .sort((a, b) => a.filename.localeCompare(b.filename));

    return images;
  } catch (error) {
    console.error('Error getting product folder images:', error);
    throw error;
  }
}

/**
 * Read an image as base64.
 */
async function readImageAsBase64(db, imagePath) {
  try {
    if (!imagePath || !fs.existsSync(imagePath)) {
      return null;
    }

    const data = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif'
    };
    const mimeType = mimeTypes[ext] || 'image/jpeg';

    return `data:${mimeType};base64,${data.toString('base64')}`;
  } catch (error) {
    console.error('Error reading image as base64:', error);
    throw error;
  }
}

module.exports = {
  readShopifySettings,
  getShopifySettings,
  saveShopifySettings,
  testShopifyConnection,
  getShopifyProductTypes,
  saveShopifyProductType,
  deleteShopifyProductType,
  getShopifyCollectionCodes,
  suggestShopifyCollectionCode,
  saveShopifyCollectionCode,
  deleteShopifyCollectionCode,
  getSettingValueOr,
  getShopifyProducts,
  getShopifyProduct,
  getShopifyProductByModel,
  fetchLiveShopifyData,
  updateLinkedShopifyProduct,
  deleteShopifyProductMedia,
  uploadShopifyProductImages,
  reorderShopifyProductMedia,
  setShopifyInventory,
  saveShopifyProduct,
  deleteShopifyProduct,
  unlinkShopifyProduct,
  getLinkableShopifyProducts,
  linkModelToShopifyProduct,
  getNextSeriesNumber,
  allocateSeriesNumber,
  generateProductCode,
  getProductFolderImages,
  readImageAsBase64
};
