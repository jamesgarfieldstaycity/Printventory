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
  deleteShopifyCollectionCode
};
