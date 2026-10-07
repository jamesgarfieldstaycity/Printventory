// core/shopify-orders.js
//
// GR-PLAN-007 Phase 2: the Shopify order sync / fulfilment IPC handler logic
// (GR-PLAN-006) moved out of main.js. Bodies are moved verbatim; the only
// edits are mechanical:
//   - `db` is an explicit first parameter (main.js reassigns its module-level
//     `db` on backup/restore/purge, so its wrappers pass the current handle).
//   - the three functions that used to call `global.sendEvent(event, channel,
//     ...)` (sync, mark-printed, ship) now take a `notify(channel, ...args)`
//     callback right after `db`. main.js builds it from global.sendEvent at
//     call time, so behaviour is unchanged.
//   - no Electron globals here; the background sync timer
//     (startShopifyOrderSyncWatcher) stays in main.js and calls the wrapper.
// shopify.js is untouched. Depends on shopify-catalog (readShopifySettings).
//
// matchOrderLineItem is exported because the file-variant reconciliation
// handlers (shopify-reconciliation) also use it.

const shopifyApi = require('../shopify');
const printEvents = require('../print-events');
const { readShopifySettings } = require('./shopify-catalog');

/**
 * Resolve a line item to a Printventory product. Checked in order, most
 * specific (and safest to open directly) first:
 *
 *  1. A confirmed per-variant file assignment, keyed on the Shopify
 *     variant's own gid, via shopify_product_files.shopify_variant_id -
 *     exactly what the product editor's variant picker
 *     (populateVariantAssignments() in renderer.js) writes when a specific
 *     variant is linked to a specific file. When this exists it's *the*
 *     file for this exact line, whatever else is true about the product -
 *     "auto-matched", opens directly in the slicer.
 *
 *  2. A SKU match via shopify_variants -> shopify_products, but only
 *     trusted as "safe to open directly" when the product has a single
 *     variant. A multi-variant product's shopify_products.model_id is
 *     just its primary/representative model (e.g. the photo used for the
 *     listing) - for a bundle or "complete set" SKU that was never given
 *     its own per-variant file (caught by #1 when it was), opening that
 *     representative file directly would silently print the wrong design.
 *     James's own example: Halloween Ghosts has 8 individual-ghost SKUs
 *     plus a 9th SKU covering the complete set of 8 - the set SKU matches
 *     a shopify_variants row, but there's no single correct file for it.
 *     So: single-variant product -> "auto-matched" (open directly).
 *         multi-variant product   -> "product-linked" (open product manager).
 *
 *  3. No SKU match, but the parent Shopify product gid resolves in
 *     shopify_products - "product-linked" as well (the original bundle
 *     fallback: the line's own SKU was never imported as a variant at all).
 *
 *  4. Nothing resolves - "unmatched", falls to the manual-link box.
 *
 * Returns { matchedModelId, matchedShopifyProductId, linkStatus }.
 */
function matchOrderLineItem(db, sku, productGid, variantGid) {
  const cleanSku = sku && String(sku).trim();
  const cleanGid = productGid && String(productGid).trim();
  const cleanVariantGid = variantGid && String(variantGid).trim();

  // Resolve the parent product up front - used both to judge whether a bare
  // SKU match is safe to open directly, and as the final fallback itself.
  let productRow = null;
  if (cleanSku) {
    productRow = db.prepare(`
      SELECT sp.id AS shopify_product_id, sp.model_id AS model_id
      FROM shopify_variants sv
      JOIN shopify_products sp ON sp.id = sv.product_id
      WHERE sv.sku = ?
      LIMIT 1
    `).get(cleanSku);
  }
  if (!productRow && cleanGid) {
    productRow = db.prepare(`
      SELECT id AS shopify_product_id, model_id
      FROM shopify_products
      WHERE shopify_product_id = ?
      LIMIT 1
    `).get(cleanGid);
  }

  if (cleanVariantGid) {
    const assigned = db.prepare(`
      SELECT m.id AS model_id
      FROM shopify_variant_file_links svfl
      JOIN models m ON m.id = svfl.model_id
      WHERE svfl.shopify_variant_id = ?
      LIMIT 1
    `).get(cleanVariantGid);
    if (assigned) {
      return {
        matchedModelId: assigned.model_id,
        matchedShopifyProductId: productRow ? productRow.shopify_product_id : null,
        linkStatus: 'auto-matched'
      };
    }
  }

  if (productRow) {
    const variantCountRow = db.prepare(`
      SELECT COUNT(*) AS n FROM shopify_variants WHERE product_id = ?
    `).get(productRow.shopify_product_id);
    const variantCount = variantCountRow ? variantCountRow.n : 0;

    return {
      matchedModelId: productRow.model_id || null,
      matchedShopifyProductId: productRow.shopify_product_id,
      linkStatus: variantCount <= 1 ? 'auto-matched' : 'product-linked'
    };
  }

  return { matchedModelId: null, matchedShopifyProductId: null, linkStatus: 'unmatched' };
}

/**
 * GR-PLAN-006: James asked to backfill historical orders that were already
 * shipped outside Printventory (shipped via Etsy/QuickSync before
 * Printventory existed, or via any other path) - "pull the historical
 * tracking info and remove the need to do anything."
 *
 * Round 1 of this trusted only a real tracking NUMBER on one of the
 * order's Shopify fulfillments, deliberately not Shopify's own
 * fulfillment_status alone. James then confirmed (screenshots of his real
 * order list) that a whole subset of genuinely-shipped Etsy orders have no
 * tracking info in Shopify at all - a QuickSync sync issue, not evidence
 * they weren't shipped - so the tracking-only signal was too conservative
 * and left real shipped orders cluttering the default view. Shopify's own
 * displayFulfillmentStatus = 'FULFILLED' is trusted directly now (confirmed
 * against his real data: every FULFILLED order in his list was a genuine
 * past shipment). Still prefers real tracking info when a fulfillment has
 * it - just doesn't require it.
 */
function pickHistoricalShipment(order) {
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];

  // Prefer the most recent fulfillment that carries a real tracking number -
  // lets the backfill record the actual carrier/tracking data when Shopify
  // has it.
  let bestWithTracking = null;
  for (const f of fulfillments) {
    const tracking = Array.isArray(f.tracking) ? f.tracking : [];
    const withNumber = tracking.find((t) => t && t.number);
    if (!withNumber) continue;
    if (!bestWithTracking || new Date(f.createdAt) > new Date(bestWithTracking.createdAt)) {
      bestWithTracking = {
        createdAt: f.createdAt || null,
        carrier: withNumber.company || null,
        number: withNumber.number,
        url: withNumber.url || null
      };
    }
  }
  if (bestWithTracking) return bestWithTracking;

  // No tracking info anywhere, but Shopify itself says this order is fully
  // fulfilled - trust that directly (not partial/unfulfilled/other states).
  // Use the latest fulfillment's own date if one exists, so fulfilled_at
  // reflects the real historical shipment date rather than "now".
  if (order.fulfillmentStatus === 'FULFILLED') {
    const latestFulfillment = fulfillments.reduce((latest, f) => {
      if (!f.createdAt) return latest;
      return (!latest || new Date(f.createdAt) > new Date(latest.createdAt)) ? f : latest;
    }, null);
    return {
      createdAt: latestFulfillment?.createdAt || null,
      carrier: null,
      number: null,
      url: null
    };
  }

  return null;
}

/**
 * Sync orders from Shopify into shopify_orders / shopify_order_line_items.
 * Upserts by shopify_order_gid / shopify_line_item_gid so a re-sync is safe
 * to run repeatedly (manual "Sync now" button, or the interval watcher).
 * Never writes anything back to Shopify - read-only until the Phase C
 * fulfillment push.
 */
async function syncShopifyOrders(db, notify, options = {}) {
  const settings = readShopifySettings(db, db);
  if (!settings.storeDomain || !settings.clientId || !settings.clientSecret) {
    return { error: 'Shopify credentials not configured', ordersSynced: 0 };
  }

  let orders;
  try {
    orders = await shopifyApi.fetchOrders(settings.storeDomain, settings.clientId, settings.clientSecret, options);
  } catch (error) {
    // Most likely cause early on: the custom app is missing the read_orders
    // scope (see GR-PLAN-006 prerequisites) - surface the raw message rather
    // than guessing, so it's actionable from the error alone.
    console.error('[Shopify orders] fetch failed:', error);
    return { error: error.message || String(error), ordersSynced: 0 };
  }

  const upsertOrder = db.prepare(`
    INSERT INTO shopify_orders (
      shopify_order_gid, order_name, order_created_at, customer_name,
      total_amount, total_currency, financial_status, fulfillment_status,
      last_synced_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(shopify_order_gid) DO UPDATE SET
      order_name = excluded.order_name,
      customer_name = excluded.customer_name,
      total_amount = excluded.total_amount,
      total_currency = excluded.total_currency,
      financial_status = excluded.financial_status,
      fulfillment_status = excluded.fulfillment_status,
      last_synced_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `);
  const getOrderId = db.prepare('SELECT id FROM shopify_orders WHERE shopify_order_gid = ?');

  // GR-PLAN-006: historical-shipment backfill (see pickHistoricalShipment
  // above). Deliberately does NOT touch quantity_printed on the order's
  // lines - there's no real record of what was actually printed for an
  // order shipped before Printventory existed, and inventing one would
  // violate the project's own "never invent a product fact" rule. Only the
  // order's own shipped/tracking state is backfilled.
  const backfillShipped = db.prepare(`
    UPDATE shopify_orders
    SET local_status = 'shipped',
        tracking_carrier = ?,
        tracking_number = ?,
        tracking_url = ?,
        fulfilled_at = COALESCE(?, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND local_status != 'shipped'
  `);

  const upsertLineItem = db.prepare(`
    INSERT INTO shopify_order_line_items (
      order_id, shopify_line_item_gid, sku, title, variant_title,
      unit_price, unit_price_currency, shopify_image_url, shopify_product_gid,
      shopify_variant_gid, quantity_ordered, matched_model_id,
      matched_shopify_product_id, link_status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(order_id, shopify_line_item_gid) DO UPDATE SET
      sku = excluded.sku,
      title = excluded.title,
      variant_title = excluded.variant_title,
      unit_price = excluded.unit_price,
      unit_price_currency = excluded.unit_price_currency,
      shopify_image_url = excluded.shopify_image_url,
      shopify_product_gid = excluded.shopify_product_gid,
      shopify_variant_gid = excluded.shopify_variant_gid,
      quantity_ordered = excluded.quantity_ordered,
      -- Never downgrade a manual link back to auto-matched/product-linked/unmatched
      -- on re-sync; only fill in a match if this line doesn't already have one.
      matched_model_id = CASE WHEN shopify_order_line_items.link_status = 'manually-linked'
        THEN shopify_order_line_items.matched_model_id ELSE excluded.matched_model_id END,
      matched_shopify_product_id = CASE WHEN shopify_order_line_items.link_status = 'manually-linked'
        THEN shopify_order_line_items.matched_shopify_product_id ELSE excluded.matched_shopify_product_id END,
      link_status = CASE WHEN shopify_order_line_items.link_status = 'manually-linked'
        THEN 'manually-linked' ELSE excluded.link_status END,
      updated_at = CURRENT_TIMESTAMP
  `);

  let newOrders = 0;
  let newlyMatchedLines = 0;
  let unmatchedLines = 0;
  let historicalShipmentsBackfilled = 0;

  const runSync = db.transaction((fetchedOrders) => {
    for (const order of fetchedOrders) {
      const existed = getOrderId.get(order.id);
      upsertOrder.run(
        order.id, order.name, order.createdAt, order.customerName ?? null,
        order.totalAmount, order.totalCurrency, order.financialStatus, order.fulfillmentStatus
      );
      if (!existed) newOrders++;
      const orderRow = getOrderId.get(order.id);

      const historicalShipment = pickHistoricalShipment(order);
      if (historicalShipment) {
        const result = backfillShipped.run(
          historicalShipment.carrier, historicalShipment.number, historicalShipment.url,
          historicalShipment.createdAt, orderRow.id
        );
        if (result.changes > 0) historicalShipmentsBackfilled++;
      }

      for (const li of order.lineItems) {
        const { matchedModelId, matchedShopifyProductId, linkStatus } =
          matchOrderLineItem(db, li.sku, li.productGid, li.variantId);
        if (linkStatus === 'auto-matched') newlyMatchedLines++; else unmatchedLines++;
        upsertLineItem.run(
          orderRow.id, li.id, li.sku, li.title, li.variantTitle,
          li.unitPrice, li.unitPriceCurrency, li.imageUrl, li.productGid,
          li.variantId, li.quantity, matchedModelId, matchedShopifyProductId, linkStatus
        );
      }
    }
  });
  runSync(orders);

  console.log(
    `[Shopify orders] synced ${orders.length} order(s) ` +
    `(${newOrders} new, ${newlyMatchedLines} line(s) matched, ${unmatchedLines} unmatched, ` +
    `${historicalShipmentsBackfilled} historical shipment(s) backfilled)`
  );

  const summary = {
    ordersSynced: orders.length,
    newOrders,
    newlyMatchedLines,
    unmatchedLines,
    historicalShipmentsBackfilled
  };

  // Notify the renderer (Orders pane badge + sync toast) - fire-and-forget,
  // never blocks the IPC response the caller is waiting on.
  notify('shopify-orders-synced', summary);

  return summary;
}

/**
 * Read synced orders + line items for the Orders pane (renderer-facing,
 * read-only - the renderer never queries shopify_orders directly).
 *
 * Hidden by default: orders where Printventory's own local_status is
 * 'shipped' - deliberately NOT Shopify's own fulfillment_status, since an
 * order can be fulfilled directly in Shopify (as happened during
 * development/testing) without actually being printed or shipped yet.
 * Pass { includeShipped: true } (the Orders pane's "Show shipped" toggle)
 * to see them too.
 */
async function getShopifyOrders(db, options = {}) {
  try {
    const includeShipped = !!(options && options.includeShipped);
    const orders = db.prepare(`
      SELECT * FROM shopify_orders
      ${includeShipped ? '' : "WHERE local_status != 'shipped'"}
      ORDER BY order_created_at ASC
    `).all();
    const lineItemsStmt = db.prepare(`
      SELECT li.*, m.filePath AS matched_file_path, m.fileName AS matched_file_name
      FROM shopify_order_line_items li
      LEFT JOIN models m ON m.id = li.matched_model_id
      WHERE li.order_id = ?
    `);
    for (const order of orders) {
      order.lineItems = lineItemsStmt.all(order.id);
    }
    return orders;
  } catch (error) {
    console.error('Error getting Shopify orders:', error);
    throw error;
  }
}

/**
 * Cheap count query for the Orders pane's edge-tab badge - avoids pulling
 * every order + line item (getShopifyOrdersHandler) just to show a number.
 * "Needs attention" = any order not yet marked shipped through
 * Printventory itself (local_status != 'shipped') - a fully-printed order
 * still counts as open, since it still needs the fulfillment push; only a
 * confirmed Printventory shipment clears it - plus a separate
 * unmatched-line count so the badge can flag reconciliation work
 * distinctly from "ready to print".
 */
async function getShopifyOrdersBadgeCount(db) {
  try {
    const openOrders = db.prepare(`
      SELECT COUNT(*) AS c FROM shopify_orders
      WHERE local_status != 'shipped'
    `).get().c;
    const unmatchedLines = db.prepare(`
      SELECT COUNT(*) AS c FROM shopify_order_line_items
      WHERE link_status = 'unmatched'
    `).get().c;
    return { openOrders, unmatchedLines };
  } catch (error) {
    console.error('Error getting Shopify orders badge count:', error);
    return { openOrders: 0, unmatchedLines: 0 };
  }
}

/**
 * Manually link (or re-link) an order line item to a Printventory model,
 * for lines that didn't auto-match by SKU. Marking it 'manually-linked'
 * also protects it from being overwritten by a later auto-match on re-sync
 * (see syncShopifyOrdersHandler's upsertLineItem CASE logic).
 */
async function linkOrderLineItem(db, { lineItemId, modelId }) {
  try {
    const model = db.prepare('SELECT id FROM models WHERE id = ?').get(modelId);
    if (!model) return { error: 'Model not found' };
    const shopifyProductRow = db.prepare(`
      SELECT sp.id FROM shopify_products sp WHERE sp.model_id = ?
      UNION
      SELECT sp.id FROM shopify_products sp
      JOIN models m ON REPLACE(m.filePath, CHAR(92), '/') LIKE sp.folder_path || '/%'
      WHERE m.id = ? AND sp.folder_path IS NOT NULL AND sp.folder_path != ''
      LIMIT 1
    `).get(modelId, modelId);
    db.prepare(`
      UPDATE shopify_order_line_items
      SET matched_model_id = ?, matched_shopify_product_id = ?, link_status = 'manually-linked', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(modelId, shopifyProductRow?.id || null, lineItemId);
    return { success: true };
  } catch (error) {
    console.error('Error linking order line item:', error);
    return { error: error.message || String(error) };
  }
}

/**
 * Roll up an order's local_status from its line items' print progress
 * (new -> printing -> printed), Printventory-side only - never written
 * back to Shopify before the fulfillment push (see GR-PLAN-006's "Shipping
 * / fulfillment" decision). Never downgrades out of 'shipped': once the
 * fulfillment push succeeds that's a one-way, Shopify-confirmed state.
 */
function recomputeOrderLocalStatus(db, orderId) {
  const order = db.prepare('SELECT local_status FROM shopify_orders WHERE id = ?').get(orderId);
  if (!order || order.local_status === 'shipped') return order ? order.local_status : null;

  const lines = db.prepare(`
    SELECT quantity_ordered, quantity_printed FROM shopify_order_line_items WHERE order_id = ?
  `).all(orderId);

  let status = 'new';
  if (lines.length) {
    const allPrinted = lines.every((l) => (Number(l.quantity_printed) || 0) >= (Number(l.quantity_ordered) || 1));
    const anyPrinted = lines.some((l) => (Number(l.quantity_printed) || 0) > 0);
    status = allPrinted ? 'printed' : (anyPrinted ? 'printing' : 'new');
  }

  db.prepare('UPDATE shopify_orders SET local_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, orderId);
  return status;
}

/**
 * "Mark Printed" - logs a real print_events row against the line's linked
 * model, reusing the model's existing print lifecycle (print_status /
 * print_count / last_printed_at via printEvents.logPrintEvent) rather than
 * a second, parallel status field - then advances the line's own
 * quantity_printed (supports partial progress on a quantity > 1 line, one
 * click per unit printed) and recomputes the order's local_status rollup.
 * Never touches Shopify - printing progress stays Printventory-only until
 * the fulfillment push below marks the order shipped.
 */
async function markOrderLineItemPrinted(db, notify, { lineItemId, quantity, durationSeconds, notes } = {}) {
  try {
    const li = db.prepare(`
      SELECT id, order_id, matched_model_id, quantity_ordered, quantity_printed
      FROM shopify_order_line_items WHERE id = ?
    `).get(lineItemId);
    if (!li) return { error: 'Order line not found' };
    if (!li.matched_model_id) return { error: 'This line has no linked model to print yet' };

    const ordered = Number(li.quantity_ordered) || 1;
    const alreadyPrinted = Number(li.quantity_printed) || 0;
    const requested = Math.max(1, Number(quantity) || 1);
    const newPrinted = Math.min(ordered, alreadyPrinted + requested);
    const actuallyLogged = newPrinted - alreadyPrinted;
    if (actuallyLogged <= 0) return { error: 'Already fully printed' };

    const result = db.transaction(() => {
      printEvents.logPrintEvent(db, {
        modelId: li.matched_model_id,
        outcome: 'printed',
        quantity: actuallyLogged,
        printedAt: new Date().toISOString(),
        durationSeconds,
        notes
      });
      db.prepare(`
        UPDATE shopify_order_line_items SET quantity_printed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(newPrinted, lineItemId);
      const localStatus = recomputeOrderLocalStatus(db, li.order_id);
      return { quantityPrinted: newPrinted, localStatus };
    })();

    // Reuse the same event the Orders pane already listens to for a sync
    // (see "Order-line staleness" decision in GR-PLAN-006) so the pane
    // refreshes live with no new listener needed - the sync-count fields
    // are meaningless here and ignored by the renderer either way.
    notify('shopify-orders-synced', {
      ordersSynced: 0, newOrders: 0, newlyMatchedLines: 0, unmatchedLines: 0
    });

    return { success: true, ...result };
  } catch (error) {
    console.error('Error marking order line item printed:', error);
    return { error: error.message || String(error) };
  }
}

/**
 * Fulfillment push - separate action from Mark Printed, matching James's
 * own described workflow ("shipping generated separately... adds the
 * shipping info to the order, marks it fulfilled"). Calls Shopify's
 * FulfillmentOrder-based flow (fulfillmentCreateV2). No carrier API
 * integration of any kind - trackingCompany is just matched against
 * Shopify's own internal carrier list to auto-generate the customer's
 * tracking link; label generation stays James's separate existing process
 * (see GR-PLAN-006's "Shipping / fulfillment" and "out of scope" sections).
 * A failed call leaves local_status/tracking fields untouched so James can
 * just retry - nothing is recorded locally until Shopify confirms it.
 */
async function shipShopifyOrder(db, notify, { orderId, carrier, trackingNumber, trackingUrl } = {}) {
  const logAttempt = db.prepare(`
    INSERT INTO shopify_fulfillment_log
      (order_id, carrier_sent, tracking_number_sent, tracking_url_sent, success,
       shopify_fulfillment_gid, confirmed_carrier, confirmed_number, confirmed_url, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    const order = db.prepare('SELECT id, shopify_order_gid, local_status FROM shopify_orders WHERE id = ?').get(orderId);
    if (!order) return { error: 'Order not found' };
    if (order.local_status === 'shipped') return { error: 'This order is already marked shipped' };
    if (!trackingNumber) return { error: 'Enter a tracking number first' };

    const settings = readShopifySettings(db, db);
    if (!settings.storeDomain || !settings.clientId || !settings.clientSecret) {
      return { error: 'Shopify credentials not configured' };
    }

    let fulfillment;
    try {
      const fulfillmentOrderId = await shopifyApi.fetchFulfillmentOrderForOrder(
        settings.storeDomain, settings.clientId, settings.clientSecret, order.shopify_order_gid
      );
      fulfillment = await shopifyApi.createFulfillment(
        settings.storeDomain, settings.clientId, settings.clientSecret,
        {
          fulfillmentOrderId,
          trackingNumber,
          trackingCompany: carrier || null,
          trackingUrl: trackingUrl || null,
          notifyCustomer: true
        }
      );
    } catch (apiError) {
      // Logged even on failure, so a silent/rejected push is never invisible -
      // see GR-PLAN-006 "Fulfillment audit trail" decision (confirmed vs. sent
      // tracking info, for the Etsy-reserve question).
      logAttempt.run(
        orderId, carrier || null, trackingNumber, trackingUrl || null, 0,
        null, null, null, null, apiError.message || String(apiError)
      );
      throw apiError;
    }

    // Use Shopify's own CONFIRMED trackingInfo from the mutation response,
    // not the raw values we sent - if Shopify silently dropped or altered
    // part of what we asked for, the local record should reflect what
    // actually happened, not what we requested.
    const confirmedTracking = (fulfillment && fulfillment.trackingInfo && fulfillment.trackingInfo[0]) || {};
    const confirmedCarrier = confirmedTracking.company || null;
    const confirmedNumber = confirmedTracking.number || null;
    const confirmedUrl = confirmedTracking.url || null;

    logAttempt.run(
      orderId, carrier || null, trackingNumber, trackingUrl || null, 1,
      (fulfillment && fulfillment.id) || null, confirmedCarrier, confirmedNumber, confirmedUrl, null
    );

    db.prepare(`
      UPDATE shopify_orders
      SET local_status = 'shipped', tracking_carrier = ?, tracking_number = ?, tracking_url = ?,
          fulfilled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(confirmedCarrier || carrier || null, confirmedNumber || trackingNumber, confirmedUrl || trackingUrl || null, orderId);

    notify('shopify-orders-synced', {
      ordersSynced: 0, newOrders: 0, newlyMatchedLines: 0, unmatchedLines: 0
    });

    return { success: true };
  } catch (error) {
    console.error('Error shipping Shopify order:', error);
    return { error: error.message || String(error) };
  }
}

module.exports = {
  matchOrderLineItem,
  pickHistoricalShipment,
  syncShopifyOrders,
  getShopifyOrders,
  getShopifyOrdersBadgeCount,
  linkOrderLineItem,
  recomputeOrderLocalStatus,
  markOrderLineItemPrinted,
  shipShopifyOrder
};
