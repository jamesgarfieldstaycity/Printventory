// core/shopify-reconciliation.js
//
// GR-PLAN-007 Phase 2: the Shopify <-> local folder/file reconciliation IPC
// handler logic (unlinked folders, linking, skip lists, file<->variant
// assignment, suggestions, backfill, mark-as-new) moved out of main.js. Bodies
// are moved verbatim; the only edits are mechanical:
//   - `db` is an explicit first parameter (main.js reassigns its module-level
//     `db` on backup/restore/purge, so its wrappers pass the current handle).
//   - assign-file-variant / unassign-file-variant used to call
//     `global.sendEvent(event, 'shopify-orders-synced', ...)`; they now take a
//     `notify(channel, ...args)` callback right after `db`. main.js builds it
//     from global.sendEvent at call time, so behaviour is unchanged.
//   - no Electron globals here.
// shopify.js is untouched. Depends on shopify-catalog (readShopifySettings) and
// shopify-orders (matchOrderLineItem).
//
// matchModelToVariant is dead code in main.js (never called); it is moved along
// with its neighbours unchanged rather than silently dropped.

const shopifyApi = require('../shopify');
const { readShopifySettings } = require('./shopify-catalog');
const { matchOrderLineItem } = require('./shopify-orders');

/**
 * Helper: Normalize a file path to use forward slashes and extract folder path
 */
function normalizeFolderPath(filePath, fileName) {
  const normalized = filePath.replace(/\\/g, '/');
  // Remove the filename from the end to get folder path
  const folderPath = normalized.substring(0, normalized.length - fileName.length - 1);
  return folderPath;
}

/**
 * Helper: Extract folder name (leaf) from full path
 */
function getFolderName(folderPath) {
  const parts = folderPath.split('/').filter(p => p);
  return parts[parts.length - 1] || folderPath;
}

/**
 * Helper: Attempt to match a model filename to a Shopify variant.
 * Returns { variantId, optionValue } if matched, null otherwise.
 *
 * Matching strategy (in priority order):
 * 1. Exact match: filename (without extension) equals optionValue
 * 2. Contains match: filename contains optionValue (case-insensitive)
 * 3. Spaceless match: filename without spaces contains optionValue without spaces
 * 4. SKU suffix match: filename contains variant number from SKU (e.g., "-04")
 */
function matchModelToVariant(fileName, variants) {
  if (!fileName || !variants || variants.length === 0) return null;

  // Remove extension and normalize
  const baseName = fileName.replace(/\.(3mf|stl)$/i, '');
  const baseNameLower = baseName.toLowerCase().replace(/[_-]/g, ' ').trim();
  const baseNameNoSpaces = baseNameLower.replace(/\s+/g, '');

  // Strategy 1: Exact match (case-insensitive, ignoring separators)
  for (const variant of variants) {
    const optionLower = (variant.optionValue || '').toLowerCase().replace(/[_-]/g, ' ').trim();
    if (baseNameLower === optionLower) {
      return { variantId: variant.id, optionValue: variant.optionValue };
    }
  }

  // Strategy 2: Filename contains optionValue (longest match first to avoid false positives)
  const sortedByLength = [...variants].sort((a, b) =>
    (b.optionValue || '').length - (a.optionValue || '').length
  );
  for (const variant of sortedByLength) {
    const optionLower = (variant.optionValue || '').toLowerCase().replace(/[_-]/g, ' ').trim();
    if (optionLower.length >= 3 && baseNameLower.includes(optionLower)) {
      return { variantId: variant.id, optionValue: variant.optionValue };
    }
  }

  // Strategy 3: Spaceless match (e.g., "ChristmasTreeGhost" contains "christmastree")
  for (const variant of sortedByLength) {
    const optionNoSpaces = (variant.optionValue || '').toLowerCase().replace(/[\s_-]/g, '');
    if (optionNoSpaces.length >= 3 && baseNameNoSpaces.includes(optionNoSpaces)) {
      return { variantId: variant.id, optionValue: variant.optionValue };
    }
  }

  // Strategy 4: SKU suffix match (e.g., "CookieGhost" matches SKU ending in "-04" if variant number is 4)
  // Extract potential variant number from filename (last digits before extension)
  const numMatch = baseName.match(/[-_]?(\d{1,3})$/);
  if (numMatch) {
    const fileNum = parseInt(numMatch[1], 10);
    for (const variant of variants) {
      if (variant.sku) {
        const skuMatch = variant.sku.match(/-(\d{1,3})$/);
        if (skuMatch && parseInt(skuMatch[1], 10) === fileNum) {
          return { variantId: variant.id, optionValue: variant.optionValue };
        }
      }
    }
  }

  return null;
}

/**
 * Get folders (products) that need reconciliation.
 * A folder is a "product" if it contains at least one 3MF file.
 * STL files are excluded from being top-level candidates.
 * Returns folder-level aggregations, not individual files.
 *
 * @param {boolean} includeSkipped - If true, include folders where all files are skipped
 */
async function getUnlinkedFolders(db, includeSkipped = false) {
  try {
    // First, get all 3MF files grouped by folder
    // A folder needs reconciliation if:
    // 1. It has at least one 3MF file
    // 2. It doesn't have a linked shopify_products entry
    // 3. Not all its 3MF files are marked as 'skipped' (unless includeSkipped)

    const folders = db.prepare(`
      WITH folder_files AS (
        SELECT
          REPLACE(
            SUBSTR(REPLACE(filePath, '\\', '/'), 1,
              LENGTH(REPLACE(filePath, '\\', '/')) - LENGTH(fileName) - 1),
            '\\', '/'
          ) as folder_path,
          id as model_id,
          fileName,
          filePath,
          designer,
          parentModel
        FROM models
        WHERE LOWER(fileName) LIKE '%.3mf'
      ),
      folder_status AS (
        SELECT
          ff.folder_path,
          COUNT(*) as file_count,
          GROUP_CONCAT(ff.model_id || '::' || ff.fileName, '|') as files_info,
          MAX(ff.designer) as designer,
          MAX(ff.parentModel) as parentModel,
          -- Check if folder is already linked to Shopify
          sp.id as local_product_id,
          sp.shopify_product_id,
          sp.push_status,
          sp.title as shopify_title,
          -- Count skipped files in this folder
          (SELECT COUNT(*) FROM shopify_product_files spf
           WHERE spf.folder_path = ff.folder_path AND spf.link_status = 'skipped') as skipped_count,
          -- Count files explicitly marked primary in this folder
          (SELECT COUNT(*) FROM shopify_product_files spf
           WHERE spf.folder_path = ff.folder_path AND spf.is_primary = 1) as primary_count
        FROM folder_files ff
        LEFT JOIN shopify_products sp ON sp.folder_path = ff.folder_path
        GROUP BY ff.folder_path
      )
      SELECT
        folder_path,
        file_count,
        files_info,
        designer,
        parentModel,
        local_product_id,
        shopify_product_id,
        push_status,
        shopify_title,
        skipped_count,
        primary_count
      FROM folder_status
      WHERE
        -- Not yet linked to Shopify
        (shopify_product_id IS NULL OR shopify_product_id = '')
        AND (push_status IS NULL OR push_status NOT IN ('linked', 'draft', 'will_create_new'))
        -- Not all files skipped (unless showing skipped) -- but if every file got
        -- skipped and none was ever promoted to primary, the folder was never
        -- actually resolved (no product was linked or created), so it still
        -- needs attention regardless of the skip count.
        AND (${includeSkipped ? '1=1' : "skipped_count < file_count OR primary_count = 0"})
      ORDER BY folder_path
    `).all();

    // Parse the files_info into structured data and add folder_name
    return folders.map(folder => {
      const files = folder.files_info ? folder.files_info.split('|').map(f => {
        const [modelId, fileName] = f.split('::');
        // Check if this specific file is skipped
        const fileStatus = db.prepare(
          'SELECT link_status, is_primary FROM shopify_product_files WHERE folder_path = ? AND model_id = ?'
        ).get(folder.folder_path, parseInt(modelId));

        return {
          model_id: parseInt(modelId),
          fileName,
          link_status: fileStatus?.link_status || 'pending',
          is_primary: fileStatus?.is_primary || 0
        };
      }) : [];

      return {
        folder_path: folder.folder_path,
        folder_name: getFolderName(folder.folder_path),
        file_count: folder.file_count,
        files,
        designer: folder.designer,
        parentModel: folder.parentModel,
        local_product_id: folder.local_product_id,
        shopify_product_id: folder.shopify_product_id,
        push_status: folder.push_status,
        shopify_title: folder.shopify_title,
        skipped_count: folder.skipped_count
      };
    });
  } catch (error) {
    console.error('Error getting unlinked folders:', error);
    throw error;
  }
}

// Keep old handler as alias for backwards compatibility
async function getUnlinkedProducts(db) {
  return getUnlinkedFolders(db, false);
}

/**
 * Helper: Auto-populate parentModel for files in a folder if not already set.
 * Uses the folder name as the parentModel value.
 */
function autoPopulateParentModel(db, folderPath) {
  const folderName = getFolderName(folderPath);
  // Only update files that don't have a parentModel set
  const result = db.prepare(`
    UPDATE models
    SET parentModel = ?
    WHERE parentModel IS NULL OR parentModel = ''
    AND REPLACE(
      SUBSTR(REPLACE(filePath, '\\', '/'), 1,
        LENGTH(REPLACE(filePath, '\\', '/')) - LENGTH(fileName) - 1),
      '\\', '/'
    ) = ?
  `).run(folderName, folderPath);
  console.log(`[Shopify] Auto-populated parentModel for ${result.changes} files in ${folderPath}`);
  return result.changes;
}

/**
 * Link a folder (product) to an existing Shopify product.
 * Creates shopify_products entry, fetches Shopify product details with variants.
 * Marks the specified primary file and auto-populates parentModel.
 *
 * @param {string} folderPath - Full path to the product folder
 * @param {number} primaryModelId - ID of the primary 3MF file for this product
 * @param {string} shopifyProductGid - Shopify product GID to link to
 */
async function linkFolderToShopify(db, folderPath, primaryModelId, shopifyProductGid) {
  try {
    const settings = readShopifySettings(db);
    if (!settings.storeDomain || !settings.clientId || !settings.clientSecret) {
      throw new Error('Shopify credentials not configured');
    }

    // Get the primary model info
    const model = db.prepare('SELECT id, fileName, filePath, designer FROM models WHERE id = ?').get(primaryModelId);
    if (!model) {
      throw new Error('Primary model not found');
    }

    // Fetch full Shopify product details including variants
    console.log('[Shopify] Fetching product details for:', shopifyProductGid);
    const shopifyProduct = await shopifyApi.fetchProductWithVariants(
      settings.storeDomain,
      settings.clientId,
      settings.clientSecret,
      shopifyProductGid
    );

    // Check if we already have a shopify_products entry for this folder
    let localProduct = db.prepare('SELECT id FROM shopify_products WHERE folder_path = ?').get(folderPath);

    if (!localProduct) {
      // Create new shopify_products entry
      const result = db.prepare(`
        INSERT INTO shopify_products (folder_path, model_id, title, description, source_folder, shopify_product_id, option_name, push_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'linked')
      `).run(
        folderPath,
        primaryModelId,
        shopifyProduct.title,
        shopifyProduct.descriptionHtml || '',
        model.filePath,
        shopifyProductGid,
        shopifyProduct.options?.[0]?.name || 'Finish'
      );
      localProduct = { id: result.lastInsertRowid };
    } else {
      // Update existing entry
      db.prepare(`
        UPDATE shopify_products SET
          model_id = ?,
          title = ?,
          description = ?,
          shopify_product_id = ?,
          option_name = ?,
          push_status = 'linked',
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        primaryModelId,
        shopifyProduct.title,
        shopifyProduct.descriptionHtml || '',
        shopifyProductGid,
        shopifyProduct.options?.[0]?.name || 'Finish',
        localProduct.id
      );
    }

    // Mark the primary file in shopify_product_files
    db.prepare(`
      INSERT INTO shopify_product_files (folder_path, model_id, is_primary, link_status)
      VALUES (?, ?, 1, 'linked')
      ON CONFLICT(folder_path, model_id) DO UPDATE SET is_primary = 1, link_status = 'linked', updated_at = datetime('now')
    `).run(folderPath, primaryModelId);

    // Clear existing variants and insert new ones from Shopify
    db.prepare('DELETE FROM shopify_variants WHERE product_id = ?').run(localProduct.id);

    const insertVariant = db.prepare(`
      INSERT INTO shopify_variants (product_id, variant_number, option_value, sku, price, compare_at_price, inventory_quantity, shopify_variant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let variantNum = 1;
    for (const variant of (shopifyProduct.variants || [])) {
      insertVariant.run(
        localProduct.id,
        variantNum++,
        variant.optionValue || variant.title || `Variant ${variantNum}`,
        variant.sku || null,  // Preserve existing Shopify SKU
        variant.price ? parseFloat(variant.price) : null,
        variant.compareAtPrice ? parseFloat(variant.compareAtPrice) : null,
        variant.inventoryQuantity ?? null,
        variant.id
      );
    }

    // Get ALL model files in this folder and create shopify_product_files entries
    // Variant assignment is manual via the editor UI - no auto-matching
    const folderFiles = db.prepare(`
      SELECT id, fileName, filePath FROM models
      WHERE REPLACE(filePath, CHAR(92), '/') LIKE ? || '/%'
        AND (LOWER(fileName) LIKE '%.3mf' OR LOWER(fileName) LIKE '%.stl')
    `).all(folderPath);

    const upsertFile = db.prepare(`
      INSERT INTO shopify_product_files (folder_path, model_id, is_primary, link_status)
      VALUES (?, ?, ?, 'linked')
      ON CONFLICT(folder_path, model_id) DO UPDATE SET
        link_status = CASE WHEN link_status = 'skipped' THEN 'skipped' ELSE 'linked' END,
        updated_at = datetime('now')
    `);

    for (const file of folderFiles) {
      const isPrimary = file.id === primaryModelId ? 1 : 0;
      upsertFile.run(folderPath, file.id, isPrimary);
    }

    console.log(`[Shopify] Created ${folderFiles.length} file entries (variant assignment is manual)`);

    // Auto-populate parentModel for files in this folder (if not already set)
    autoPopulateParentModel(db, folderPath);

    console.log(`[Shopify] Linked folder ${folderPath} to Shopify product, imported ${variantNum - 1} variants`);
    return { success: true, variantCount: variantNum - 1, title: shopifyProduct.title };
  } catch (error) {
    console.error('Error linking folder to Shopify product:', error);
    throw error;
  }
}

/**
 * Legacy handler: Link a single model to Shopify.
 * Now delegates to folder-based linking using the model's folder.
 */
async function linkToShopifyProduct(db, modelId, shopifyProductGid) {
  const model = db.prepare('SELECT id, fileName, filePath FROM models WHERE id = ?').get(modelId);
  if (!model) {
    throw new Error('Model not found');
  }
  const folderPath = normalizeFolderPath(model.filePath, model.fileName);
  return linkFolderToShopify(db, folderPath, modelId, shopifyProductGid);
}

/**
 * Skip a file in reconciliation - it won't appear as needing action.
 * Persisted so it doesn't reappear on re-runs.
 */
async function skipFolderFile(db, folderPath, modelId) {
  try {
    db.prepare(`
      INSERT INTO shopify_product_files (folder_path, model_id, is_primary, link_status)
      VALUES (?, ?, 0, 'skipped')
      ON CONFLICT(folder_path, model_id) DO UPDATE SET link_status = 'skipped', updated_at = datetime('now')
    `).run(folderPath, modelId);
    console.log(`[Shopify] Skipped file ${modelId} in folder ${folderPath}`);
    return { success: true };
  } catch (error) {
    console.error('Error skipping file:', error);
    throw error;
  }
}

/**
 * Unskip a file - restore it to pending status for reconciliation.
 */
async function unskipFolderFile(db, folderPath, modelId) {
  try {
    db.prepare(`
      UPDATE shopify_product_files SET link_status = 'pending', updated_at = datetime('now')
      WHERE folder_path = ? AND model_id = ?
    `).run(folderPath, modelId);
    console.log(`[Shopify] Unskipped file ${modelId} in folder ${folderPath}`);
    return { success: true };
  } catch (error) {
    console.error('Error unskipping file:', error);
    throw error;
  }
}

/**
 * Get all skipped files for the "show skipped" view.
 */
async function getSkippedFiles(db) {
  try {
    const skipped = db.prepare(`
      SELECT spf.folder_path, spf.model_id, m.fileName, m.filePath
      FROM shopify_product_files spf
      JOIN models m ON m.id = spf.model_id
      WHERE spf.link_status = 'skipped'
      ORDER BY spf.folder_path, m.fileName
    `).all();
    return skipped;
  } catch (error) {
    console.error('Error getting skipped files:', error);
    throw error;
  }
}

/**
 * Get all files in a folder with their variant assignments.
 * Used by the Shopify editor to show file-to-variant mapping UI.
 */
async function getFolderFileVariants(db, folderPath) {
  try {
    // Get the shopify_products entry for this folder
    const product = db.prepare(`
      SELECT sp.id, sp.title, sp.shopify_product_id, sp.option_name
      FROM shopify_products sp
      WHERE sp.folder_path = ?
    `).get(folderPath);

    if (!product) {
      return { files: [], variants: [], product: null };
    }

    // Get all variants for this product
    const variants = db.prepare(`
      SELECT sv.shopify_variant_id as id, sv.option_value as optionValue, sv.sku
      FROM shopify_variants sv
      WHERE sv.product_id = ?
      ORDER BY sv.variant_number
    `).all(product.id);

    // Get all model files in this folder with their variant assignments
    const files = db.prepare(`
      SELECT
        m.id,
        m.fileName,
        m.filePath,
        spf.is_primary as isPrimary,
        spf.link_status as linkStatus,
        spf.shopify_variant_id as variantId,
        spf.variant_option_value as variantOptionValue
      FROM models m
      LEFT JOIN shopify_product_files spf ON spf.model_id = m.id AND spf.folder_path = ?
      WHERE REPLACE(m.filePath, CHAR(92), '/') LIKE ? || '/%'
        AND (LOWER(m.fileName) LIKE '%.3mf' OR LOWER(m.fileName) LIKE '%.stl')
      ORDER BY m.fileName
    `).all(folderPath, folderPath);

    return {
      files,
      variants,
      product: {
        id: product.id,
        title: product.title,
        shopifyProductId: product.shopify_product_id,
        optionName: product.option_name
      }
    };
  } catch (error) {
    console.error('Error getting folder file variants:', error);
    throw error;
  }
}

/**
 * Manually assign a Shopify variant to a model file.
 * Used when auto-matching fails or user wants to override.
 * Clears any existing assignment to this variant from other models first.
 */
async function assignFileVariant(db, notify, folderPath, modelId, variantId, optionValue) {
  try {
    // One variant always resolves to exactly one file - reassigning a
    // variant to a different file replaces its row, same as before. But a
    // file CAN serve more than one variant now (hand-painted lines reuse
    // one sculpt across several finishes), so this is keyed on the
    // variant, not the file: shopify_variant_file_links.UNIQUE(folder_path,
    // shopify_variant_id) is what enforces "one file per variant," and
    // there is deliberately nothing stopping the same model_id appearing
    // in several of these rows.
    db.prepare(`
      INSERT INTO shopify_variant_file_links (folder_path, shopify_variant_id, model_id, variant_option_value, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(folder_path, shopify_variant_id) DO UPDATE SET
        model_id = excluded.model_id,
        variant_option_value = excluded.variant_option_value,
        updated_at = datetime('now')
    `).run(folderPath, variantId, modelId, optionValue);

    // Still register the file in shopify_product_files so the rest of the
    // app sees it as part of this product (is_primary/link_status) - that
    // table no longer decides variant assignment (see above) but other
    // code still reads it for "is this file linked to this product at all."
    db.prepare(`
      INSERT INTO shopify_product_files (folder_path, model_id, is_primary, link_status)
      VALUES (?, ?, 0, 'linked')
      ON CONFLICT(folder_path, model_id) DO UPDATE SET
        link_status = 'linked',
        updated_at = datetime('now')
    `).run(folderPath, modelId);

    console.log(`[Shopify] Assigned variant ${optionValue || variantId} to model ${modelId}`);

    // A variant's file assignment just changed, but any already-synced
    // order lines for this variant still carry whatever link_status/
    // matched_model_id they got from the last full Shopify sync -
    // nothing re-runs matchOrderLineItem() locally otherwise, so the
    // Orders pane's "Open Product Manager" / "Open in Slicer" button
    // stays stale until the next remote sync. Re-match affected lines now
    // and tell the renderer, the same way syncShopifyOrdersHandler does.
    let reMatchedLines = 0;
    try {
      const affectedLines = db.prepare(`
        SELECT id, sku, shopify_product_gid, shopify_variant_gid
        FROM shopify_order_line_items
        WHERE shopify_variant_gid = ? AND link_status != 'manually-linked'
      `).all(variantId);

      if (affectedLines.length > 0) {
        const updateLine = db.prepare(`
          UPDATE shopify_order_line_items
          SET matched_model_id = ?, matched_shopify_product_id = ?, link_status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `);
        for (const line of affectedLines) {
          const { matchedModelId, matchedShopifyProductId, linkStatus } =
            matchOrderLineItem(db, line.sku, line.shopify_product_gid, line.shopify_variant_gid);
          updateLine.run(matchedModelId ?? null, matchedShopifyProductId ?? null, linkStatus, line.id);
          reMatchedLines++;
        }

        if (reMatchedLines > 0) {
          notify('shopify-orders-synced', {
            ordersSynced: 0,
            newOrders: 0,
            newlyMatchedLines: reMatchedLines,
            unmatchedLines: 0
          });
        }
      }
    } catch (reMatchError) {
      // Never let order-line re-matching break the variant assignment itself.
      console.error('Error re-matching order lines after variant assignment:', reMatchError);
    }

    return { success: true };
  } catch (error) {
    console.error('Error assigning file variant:', error);
    throw error;
  }
}

/**
 * Remove a variant's confirmed file assignment entirely (not a replace -
 * the variant goes back to unassigned/suggested, same as it was before
 * ever being confirmed). James: "I should be able to unlink files
 * completely as well as replace."
 */
async function unassignFileVariant(db, notify, folderPath, variantId) {
  try {
    db.prepare(`
      DELETE FROM shopify_variant_file_links WHERE folder_path = ? AND shopify_variant_id = ?
    `).run(folderPath, variantId);

    console.log(`[Shopify] Unlinked variant ${variantId} from its file`);

    // Same order-line re-match/live-refresh as assignFileVariantHandler,
    // so a line that was auto-matched via this assignment falls back
    // correctly instead of continuing to point at a file that's no longer
    // this variant's confirmed assignment.
    let reMatchedLines = 0;
    try {
      const affectedLines = db.prepare(`
        SELECT id, sku, shopify_product_gid, shopify_variant_gid
        FROM shopify_order_line_items
        WHERE shopify_variant_gid = ? AND link_status != 'manually-linked'
      `).all(variantId);

      if (affectedLines.length > 0) {
        const updateLine = db.prepare(`
          UPDATE shopify_order_line_items
          SET matched_model_id = ?, matched_shopify_product_id = ?, link_status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `);
        for (const line of affectedLines) {
          const { matchedModelId, matchedShopifyProductId, linkStatus } =
            matchOrderLineItem(db, line.sku, line.shopify_product_gid, line.shopify_variant_gid);
          updateLine.run(matchedModelId ?? null, matchedShopifyProductId ?? null, linkStatus, line.id);
          reMatchedLines++;
        }

        if (reMatchedLines > 0) {
          notify('shopify-orders-synced', {
            ordersSynced: 0,
            newOrders: 0,
            newlyMatchedLines: reMatchedLines,
            unmatchedLines: 0
          });
        }
      }
    } catch (reMatchError) {
      console.error('Error re-matching order lines after variant unlink:', reMatchError);
    }

    return { success: true };
  } catch (error) {
    console.error('Error unassigning file variant:', error);
    throw error;
  }
}

/**
 * Get product variants with file suggestions (variant-first approach).
 * For each variant, returns current assignment or suggested file match.
 * Suggestions require explicit user confirmation - never auto-applied.
 */
async function getProductVariantsWithSuggestions(db, folderPath) {
  try {
    // Get the shopify_products entry for this folder
    const product = db.prepare(`
      SELECT sp.id, sp.title, sp.shopify_product_id, sp.option_name, sp.model_id as primaryModelId
      FROM shopify_products sp
      WHERE sp.folder_path = ?
    `).get(folderPath);

    if (!product || !product.shopify_product_id) {
      return { product: null, variants: [], files: [] };
    }

    // Get all variants for this product
    const variants = db.prepare(`
      SELECT sv.id as localId, sv.shopify_variant_id, sv.option_value, sv.sku
      FROM shopify_variants sv
      WHERE sv.product_id = ?
      ORDER BY sv.variant_number
    `).all(product.id);

    // Get all model files in this folder, with every variant currently
    // assigned to each one (a file can back more than one variant - see
    // shopify_variant_file_links above) and its own suggestion label.
    const files = db.prepare(`
      SELECT
        m.id,
        m.fileName,
        m.filePath,
        m.thumbnail,
        COALESCE(spf.is_primary, 0) as isPrimary
      FROM models m
      LEFT JOIN shopify_product_files spf ON spf.model_id = m.id AND spf.folder_path = ?
      WHERE REPLACE(m.filePath, CHAR(92), '/') LIKE ? || '/%'
        AND (LOWER(m.fileName) LIKE '%.3mf' OR LOWER(m.fileName) LIKE '%.stl')
      ORDER BY m.fileName
    `).all(folderPath, folderPath);

    // variant -> assigned file, from the junction table (looked up per
    // variant rather than per file, since one file may now serve several).
    const variantLinks = db.prepare(`
      SELECT shopify_variant_id, model_id FROM shopify_variant_file_links WHERE folder_path = ?
    `).all(folderPath);
    const modelIdByVariantId = new Map(variantLinks.map(l => [l.shopify_variant_id, l.model_id]));
    const filesById = new Map(files.map(f => [f.id, f]));

    // file -> every option_value it's currently assigned to, for the file
    // picker's "already used for: ..." note (renderer.js) - informational,
    // not a conflict, now that reuse across variants is expected.
    const variantIdsByModelId = new Map();
    for (const link of variantLinks) {
      if (!variantIdsByModelId.has(link.model_id)) variantIdsByModelId.set(link.model_id, []);
      variantIdsByModelId.get(link.model_id).push(link.shopify_variant_id);
    }
    const variantById = new Map(variants.map(v => [v.shopify_variant_id, v]));
    for (const file of files) {
      const usedByIds = variantIdsByModelId.get(file.id) || [];
      file.usedByOptionValues = usedByIds
        .map(vid => variantById.get(vid)?.option_value)
        .filter(Boolean);
    }

    // Build result with assignments and suggestions
    const variantsWithSuggestions = variants.map(variant => {
      const assignedModelId = modelIdByVariantId.get(variant.shopify_variant_id);
      const assignedFile = assignedModelId ? (filesById.get(assignedModelId) || null) : null;

      // Compute suggestion if not assigned (using simple word matching).
      // Deliberately does NOT skip files already assigned to another
      // variant - James's hand-painted lines print several finish variants
      // from the one file, so "already used elsewhere" isn't disqualifying
      // the way it would be for a product whose variants are genuinely
      // different sculpts/files. Still never auto-applied - confirmation
      // is always required (see "Confirm" button in the caller).
      let suggestion = null;
      if (!assignedFile) {
        let bestMatch = null;
        let bestScore = 0;

        for (const file of files) {
          const score = calculateMatchScoreSimple(file.fileName, variant.option_value);
          if (score > bestScore && score >= 0.3) {
            bestScore = score;
            bestMatch = { file, score };
          }
        }
        suggestion = bestMatch;
      }

      return {
        ...variant,
        assignedFile: assignedFile || null,
        suggestion
      };
    });

    return {
      product: {
        id: product.id,
        title: product.title,
        shopifyProductId: product.shopify_product_id,
        optionName: product.option_name,
        primaryModelId: product.primaryModelId
      },
      variants: variantsWithSuggestions,
      files
    };
  } catch (error) {
    console.error('Error getting product variants with suggestions:', error);
    throw error;
  }
}

/** Match score calculation for filename to variant matching */
function calculateMatchScoreSimple(fileName, optionValue) {
  if (!fileName || !optionValue) return 0;

  // Remove extension and normalize (keep both spaced and spaceless versions)
  const baseName = fileName.replace(/\.(3mf|stl)$/i, '').toLowerCase().replace(/[_-]/g, ' ').trim();
  const baseNameNoSpaces = baseName.replace(/\s+/g, '');
  const option = optionValue.toLowerCase().replace(/[_-]/g, ' ').trim();
  const optionNoSpaces = option.replace(/\s+/g, '');

  // Strategy 1: Exact match (case-insensitive)
  if (baseName === option || baseNameNoSpaces === optionNoSpaces) return 1;

  // Strategy 2: Contains match (spaced)
  if (baseName.includes(option) || option.includes(baseName)) return 0.9;

  // Strategy 3: Contains match (spaceless) - handles "BlackCatGhost" containing "blackcat"
  if (optionNoSpaces.length >= 3 && baseNameNoSpaces.includes(optionNoSpaces)) return 0.85;
  if (baseNameNoSpaces.length >= 3 && optionNoSpaces.includes(baseNameNoSpaces)) return 0.85;

  // Strategy 4: Word-based similarity (check if option words appear in filename)
  const optionWords = option.split(/\s+/).filter(w => w.length >= 3);
  if (optionWords.length > 0) {
    // Count how many option words appear in the spaceless filename
    const matchingWords = optionWords.filter(w => baseNameNoSpaces.includes(w));
    if (matchingWords.length >= 2) {
      // Good match if 2+ words match
      return 0.7 + (0.1 * Math.min(matchingWords.length - 2, 2)); // 0.7 to 0.9
    }
    if (matchingWords.length === 1) {
      return 0.4; // Weak match with single word
    }
  }

  // Strategy 5: SKU suffix match (e.g., "ghost-04" matches variant with SKU ending "-04")
  const numMatch = baseName.match(/[-_\s]?(\d{1,3})$/);
  if (numMatch) {
    const fileNum = parseInt(numMatch[1], 10);
    // This would need SKU passed in, so just return low score
    // SKU matching is handled separately if needed
  }

  return 0;
}

/**
 * Set the primary/default file for a Shopify product.
 * Clears is_primary on all other files for this product.
 */
async function setPrimaryFile(db, folderPath, modelId) {
  try {
    // Clear existing primary
    db.prepare('UPDATE shopify_product_files SET is_primary = 0 WHERE folder_path = ?').run(folderPath);

    // Set new primary
    db.prepare(`
      INSERT INTO shopify_product_files (folder_path, model_id, is_primary, link_status)
      VALUES (?, ?, 1, 'linked')
      ON CONFLICT(folder_path, model_id) DO UPDATE SET is_primary = 1, updated_at = datetime('now')
    `).run(folderPath, modelId);

    // Also update shopify_products.model_id
    db.prepare('UPDATE shopify_products SET model_id = ? WHERE folder_path = ?').run(modelId, folderPath);

    console.log(`[Shopify] Set primary file to model ${modelId} for ${folderPath}`);
    return { success: true };
  } catch (error) {
    console.error('Error setting primary file:', error);
    throw error;
  }
}

/**
 * Backfill variant mappings for already-linked Shopify products.
 * Fetches variants from Shopify API and attempts to match local files to variants.
 * Returns { processed, matched, errors }.
 */
async function backfillVariantMappings(db) {
  const settings = readShopifySettings(db);
  if (!settings.storeDomain || !settings.clientId || !settings.clientSecret) {
    throw new Error('Shopify credentials not configured');
  }

  // Get all linked products (those with shopify_product_id set)
  const linkedProducts = db.prepare(`
    SELECT id, folder_path, shopify_product_id, title
    FROM shopify_products
    WHERE shopify_product_id IS NOT NULL AND push_status = 'linked'
  `).all();

  console.log(`[Shopify] Backfilling variant mappings for ${linkedProducts.length} linked products...`);

  let processed = 0;
  let filesRegistered = 0;
  const errors = [];

  for (const product of linkedProducts) {
    try {
      // Fetch variants from Shopify API
      const shopifyProduct = await shopifyApi.fetchProductWithVariants(
        settings.storeDomain,
        settings.clientId,
        settings.clientSecret,
        product.shopify_product_id
      );

      if (!shopifyProduct || !shopifyProduct.variants) {
        errors.push({ folder: product.folder_path, error: 'No variants found' });
        continue;
      }

      // Clear and re-import variants
      db.prepare('DELETE FROM shopify_variants WHERE product_id = ?').run(product.id);

      const insertVariant = db.prepare(`
        INSERT INTO shopify_variants (product_id, variant_number, option_value, sku, price, compare_at_price, inventory_quantity, shopify_variant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let variantNum = 1;
      for (const variant of shopifyProduct.variants) {
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

      // Get all model files in this folder
      const folderFiles = db.prepare(`
        SELECT id, fileName, filePath FROM models
        WHERE REPLACE(filePath, CHAR(92), '/') LIKE ? || '/%'
          AND (LOWER(fileName) LIKE '%.3mf' OR LOWER(fileName) LIKE '%.stl')
      `).all(product.folder_path);

      // Ensure all files are registered in shopify_product_files (no auto-matching)
      // Variant assignment is manual-only to avoid false positives
      const upsertFile = db.prepare(`
        INSERT INTO shopify_product_files (folder_path, model_id, is_primary, link_status)
        VALUES (?, ?, 0, 'linked')
        ON CONFLICT(folder_path, model_id) DO UPDATE SET
          link_status = CASE WHEN link_status = 'skipped' THEN 'skipped' ELSE 'linked' END,
          updated_at = datetime('now')
      `);

      for (const file of folderFiles) {
        upsertFile.run(product.folder_path, file.id);
        filesRegistered++;
      }

      console.log(`[Shopify] Backfilled ${product.folder_path}: ${folderFiles.length} files registered, variants cached (manual assignment required)`);
      processed++;
    } catch (error) {
      console.error(`[Shopify] Error backfilling ${product.folder_path}:`, error.message);
      errors.push({ folder: product.folder_path, error: error.message });
    }
  }

  console.log(`[Shopify] Backfill complete: ${processed} products processed, ${filesRegistered} files registered (manual variant assignment required), ${errors.length} errors`);
  return { processed, filesRegistered, errors };
}

/**
 * Mark a folder as "no match - will create new Shopify product".
 * Creates a shopify_products entry if needed.
 *
 * @param {string} folderPath - Full path to the product folder
 * @param {number} primaryModelId - ID of the primary 3MF file for this product
 */
async function markFolderAsNew(db, folderPath, primaryModelId) {
  try {
    // Get the primary model info
    const model = db.prepare('SELECT id, fileName, filePath FROM models WHERE id = ?').get(primaryModelId);
    if (!model) {
      throw new Error('Primary model not found');
    }

    const folderName = getFolderName(folderPath);

    // Check if we already have a shopify_products entry for this folder
    const existing = db.prepare('SELECT id FROM shopify_products WHERE folder_path = ?').get(folderPath);

    if (existing) {
      // Update existing entry
      db.prepare(`
        UPDATE shopify_products SET
          model_id = ?,
          shopify_product_id = NULL,
          push_status = 'will_create_new',
          updated_at = datetime('now')
        WHERE id = ?
      `).run(primaryModelId, existing.id);
    } else {
      // Create new entry - use folder name as title
      db.prepare(`
        INSERT INTO shopify_products (folder_path, model_id, title, source_folder, push_status)
        VALUES (?, ?, ?, ?, 'will_create_new')
      `).run(folderPath, primaryModelId, folderName, model.filePath);
    }

    // Mark the primary file in shopify_product_files
    db.prepare(`
      INSERT INTO shopify_product_files (folder_path, model_id, is_primary, link_status)
      VALUES (?, ?, 1, 'will_create_new')
      ON CONFLICT(folder_path, model_id) DO UPDATE SET is_primary = 1, link_status = 'will_create_new', updated_at = datetime('now')
    `).run(folderPath, primaryModelId);

    // Auto-populate parentModel for files in this folder (if not already set)
    autoPopulateParentModel(db, folderPath);

    return { success: true };
  } catch (error) {
    console.error('Error marking folder as new product:', error);
    throw error;
  }
}

/**
 * Legacy handler: Mark a single model as "will create new".
 * Now delegates to folder-based marking using the model's folder.
 */
async function markAsNewProduct(db, modelId) {
  const model = db.prepare('SELECT id, fileName, filePath FROM models WHERE id = ?').get(modelId);
  if (!model) {
    throw new Error('Model not found');
  }
  const folderPath = normalizeFolderPath(model.filePath, model.fileName);
  return markFolderAsNew(db, folderPath, modelId);
}

module.exports = {
  normalizeFolderPath,
  getFolderName,
  matchModelToVariant,
  getUnlinkedFolders,
  getUnlinkedProducts,
  autoPopulateParentModel,
  linkFolderToShopify,
  linkToShopifyProduct,
  skipFolderFile,
  unskipFolderFile,
  getSkippedFiles,
  getFolderFileVariants,
  assignFileVariant,
  unassignFileVariant,
  getProductVariantsWithSuggestions,
  calculateMatchScoreSimple,
  setPrimaryFile,
  backfillVariantMappings,
  markFolderAsNew,
  markAsNewProduct
};
