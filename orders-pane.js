/**
 * Orders Pane (GR-PLAN-006): dockable panel showing Shopify orders synced
 * into shopify_orders / shopify_order_line_items, oldest-first (FIFO).
 * Delegates docking/pin/resize/autohide to PaneController, same as
 * Filters and Tools. Phase A scope: list orders + line items, open a
 * matched line's model file in the configured slicer, and manually link
 * an unmatched line to a model (reconciliation). "Mark Printed" and
 * fulfillment are Phase B/C, not here yet.
 */
(function () {
  'use strict';

  const PANE_ID = 'orders-pane';

  let modelsCache = null; // lazy-loaded for the manual-link datalist
  let ordersListLoaded = false;
  let toastTimeout = null;

  // ============================================
  // Register with PaneController
  // ============================================

  function registerPane() {
    if (!window.PaneController) {
      console.warn('[OrdersPane] PaneController not loaded');
      return;
    }

    window.PaneController.register(PANE_ID, {
      element: '#orders-pane',
      edgeTab: '#orders-pane-edge-tab',
      settingPrefix: 'ordersPane',
      defaultState: window.PaneController.STATE_CLOSED,
      defaultWidth: 360,
      minWidth: 320,
      maxWidth: 520,
      order: 3, // Third in stack order (right of sidebar + filters when both pinned)
      cssWidthVar: '--orders-pane-width',
      bodyClassPrefix: 'orders-pane',
      ipcChannel: 'orders-pane-state-changed'
    });
  }

  // ============================================
  // Helpers
  // ============================================

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatOrderDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (_) {
      return '';
    }
  }

  async function ensureModelsCache() {
    if (modelsCache) return modelsCache;
    try {
      modelsCache = (await window.electron?.getAllModels?.('name-asc', 0)) || [];
    } catch (e) {
      console.error('[OrdersPane] Failed to load models for linking:', e);
      modelsCache = [];
    }
    return modelsCache;
  }

  async function ensureModelsDatalist() {
    if (document.getElementById('orders-models-datalist')) return;
    const models = await ensureModelsCache();
    const datalist = document.createElement('datalist');
    datalist.id = 'orders-models-datalist';
    // Cap the list to keep the DOM light; a typed search still narrows the
    // browser's native suggestions against whatever loaded.
    datalist.innerHTML = models.slice(0, 3000).map((m) =>
      `<option value="${escapeHtml(m.fileName)}"></option>`
    ).join('');
    document.body.appendChild(datalist);
  }

  // ============================================
  // Rendering
  // ============================================

  /**
   * Option A card (approved wireframe): thumbnail + full-width title on
   * their own row, a metadata row (variant tag, mono SKU tag, qty x price),
   * then a full-width action button below - mirrors Shopify's own order
   * admin layout instead of cramming title + button into one line (the
   * earlier layout that truncated titles to "The ...").
   *
   * Three link_status outcomes drive the action row differently:
   *  - auto-matched:    this exact variant's own file is known -> "Open in
   *                      Slicer" opens it directly.
   *  - product-linked:  the SKU itself didn't match, but the parent Shopify
   *                      product is linked in Printventory (the common
   *                      bundle case - e.g. Halloween Ghosts' 8-variant
   *                      "complete set" SKU) -> "Open Product Manager" opens
   *                      that product's existing editor dialog, which lists
   *                      every variant with its own "open in slicer" action.
   *                      Enabled only when matched_file_path actually
   *                      resolves (the product's primary model file) -
   *                      disabled with an explanatory label otherwise.
   *  - manually-linked:  same as auto-matched once linked (opens the chosen
   *                      file directly).
   *  - unmatched:        nothing in Printventory claims this line -> show
   *                      the manual-link box, same as before.
   */
  function formatMoney(amount, currency) {
    if (amount === null || amount === undefined || amount === '') return '';
    const n = Number(amount);
    if (Number.isNaN(n)) return '';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(n);
    } catch (_) {
      return `${n.toFixed(2)} ${currency || ''}`.trim();
    }
  }

  function renderLineItem(li) {
    const qtyLabel = li.quantity_ordered > 1 ? `×${li.quantity_ordered}` : '×1';
    const priceLabel = formatMoney(li.unit_price, li.unit_price_currency);
    const qtyPriceLabel = [qtyLabel, priceLabel].filter(Boolean).join(' · ');
    const thumbHtml = li.shopify_image_url
      ? `<img class="order-line-thumb" src="${escapeHtml(li.shopify_image_url)}" alt="">`
      : `<div class="order-line-thumb order-line-thumb-placeholder"></div>`;
    const titleHtml = escapeHtml(li.matched_file_name || li.title);
    const variantTagHtml = li.variant_title
      ? `<span class="order-line-tag order-line-variant-tag">${escapeHtml(li.variant_title)}</span>`
      : '';
    const skuTagHtml = `<span class="order-line-tag order-line-sku-tag">${escapeHtml(li.sku || 'no SKU')}</span>`;

    let actionHtml;
    if (li.link_status === 'auto-matched' || li.link_status === 'manually-linked') {
      actionHtml = `<button type="button" class="order-line-action-btn" data-action="open-slicer" data-path="${escapeHtml(li.matched_file_path || '')}">Open in Slicer</button>`;
    } else if (li.link_status === 'product-linked') {
      if (li.matched_file_path) {
        actionHtml = `<button type="button" class="order-line-action-btn order-line-action-btn-secondary" data-action="open-product-manager" data-path="${escapeHtml(li.matched_file_path)}">Open Product Manager</button>`;
      } else {
        actionHtml = `<button type="button" class="order-line-action-btn" disabled title="Linked product has no primary model file to open">Open Product Manager</button>`;
      }
    } else {
      actionHtml = `<input type="text" class="order-line-link-select" list="orders-models-datalist"
          placeholder="Link to model..." data-action="link-model" data-line-id="${li.id}">`;
    }

    const unmatchedClass = (li.link_status === 'unmatched') ? ' order-line-unmatched' : '';

    return `
      <div class="order-line${unmatchedClass}" data-line-id="${li.id}">
        <div class="order-line-top">
          ${thumbHtml}
          <span class="order-line-title">${titleHtml}</span>
        </div>
        <div class="order-line-meta">
          ${variantTagHtml}
          ${skuTagHtml}
          <span class="order-line-qty-price">${escapeHtml(qtyPriceLabel)}</span>
        </div>
        <div class="order-line-action">${actionHtml}</div>
      </div>
    `;
  }

  function renderOrderCard(order) {
    const lines = (order.lineItems || []).map(renderLineItem).join('');
    return `
      <div class="order-card" data-order-id="${order.id}">
        <div class="order-card-header">
          <span class="order-card-name">${escapeHtml(order.order_name)}</span>
          <span class="order-card-customer">${escapeHtml(order.customer_name || '')}</span>
        </div>
        <div class="order-card-meta">${formatOrderDate(order.order_created_at)} · ${escapeHtml(order.financial_status || '')}</div>
        <div class="order-lines">${lines}</div>
      </div>
    `;
  }

  async function renderOrdersList() {
    const listEl = document.getElementById('orders-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="orders-empty-state">Loading…</div>';
    try {
      const orders = await window.electron.getShopifyOrders();
      if (!orders || !orders.length) {
        listEl.innerHTML = '<div class="orders-empty-state">No open orders. New orders will appear here after the next sync.</div>';
        return;
      }
      listEl.innerHTML = orders.map(renderOrderCard).join('');
    } catch (e) {
      console.error('[OrdersPane] Failed to load orders:', e);
      listEl.innerHTML = '<div class="orders-empty-state">Could not load orders.</div>';
    }
  }

  function loadOrdersIfNeeded() {
    if (ordersListLoaded) return;
    ordersListLoaded = true;
    renderOrdersList();
    ensureModelsDatalist();
  }

  // ============================================
  // Line actions: open in slicer, manual link
  // ============================================

  function handleOpenSlicer(btn) {
    const path = btn.dataset.path;
    if (!path) {
      alert('No file path available for this model.');
      return;
    }
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Opening…';
    window.electron.openFileInSlicer({ filePaths: [path] })
      .then((result) => {
        if (result && result.error) {
          alert(result.error);
        }
      })
      .catch((e) => alert(`Could not open in slicer: ${e.message || e}`))
      .finally(() => {
        btn.disabled = false;
        btn.textContent = originalLabel;
      });
  }

  // Bundle / product-linked fallback (GR-PLAN-006): reuse Printventory's
  // existing Shopify product editor dialog rather than sending James out to
  // Shopify's own site. That dialog already lists every variant on the
  // product (populateVariantAssignments() in renderer.js) with its own
  // "open in slicer" button, so a bundle line like Halloween Ghosts'
  // 8-variant "complete set" SKU gets a real per-variant action instead of
  // a single guessed file.
  function handleOpenProductManager(btn) {
    const path = btn.dataset.path;
    if (!path || typeof window.openShopifyProductEditorForPath !== 'function') {
      alert('Could not open the product manager for this line.');
      return;
    }
    window.openShopifyProductEditorForPath(path);
  }

  async function handleLinkModel(input) {
    const lineId = input.dataset.lineId;
    const typedName = input.value.trim();
    if (!typedName) return;

    const models = await ensureModelsCache();
    const match = models.find((m) => m.fileName === typedName);
    if (!match) {
      input.title = 'No model matches that name exactly — pick one from the list';
      return;
    }

    input.disabled = true;
    try {
      const result = await window.electron.linkOrderLineItem({ lineItemId: Number(lineId), modelId: match.id });
      if (result && result.error) {
        alert(`Could not link: ${result.error}`);
        input.disabled = false;
        return;
      }
      await renderOrdersList();
      await refreshBadge();
    } catch (e) {
      alert(`Could not link: ${e.message || e}`);
      input.disabled = false;
    }
  }

  function bindListEvents() {
    const listEl = document.getElementById('orders-list');
    if (!listEl || listEl.dataset.bound) return;
    listEl.dataset.bound = '1';

    listEl.addEventListener('click', (e) => {
      const slicerBtn = e.target.closest('[data-action="open-slicer"]');
      if (slicerBtn) { handleOpenSlicer(slicerBtn); return; }
      const managerBtn = e.target.closest('[data-action="open-product-manager"]');
      if (managerBtn) { handleOpenProductManager(managerBtn); return; }
    });

    listEl.addEventListener('change', (e) => {
      const input = e.target.closest('[data-action="link-model"]');
      if (input) handleLinkModel(input);
    });
  }

  // ============================================
  // Edge-tab badge ("needs attention" count)
  // ============================================

  async function refreshBadge() {
    const badge = document.getElementById('orders-edge-tab-badge');
    if (!badge) return;
    try {
      const counts = await window.electron.getShopifyOrdersBadgeCount();
      const openOrders = counts?.openOrders || 0;
      const unmatchedLines = counts?.unmatchedLines || 0;
      if (!openOrders) {
        badge.textContent = '';
        badge.classList.add('hidden');
        return;
      }
      badge.textContent = String(openOrders);
      badge.classList.remove('hidden');
      badge.classList.toggle('has-unmatched', unmatchedLines > 0);
      badge.title = unmatchedLines > 0
        ? `${openOrders} open order(s), ${unmatchedLines} line(s) need linking`
        : `${openOrders} open order(s)`;
    } catch (e) {
      console.error('[OrdersPane] Failed to refresh badge:', e);
    }
  }

  // ============================================
  // Sync toast (transient, auto-dismissing)
  // ============================================

  function showSyncToast(summary) {
    const toast = document.getElementById('orders-sync-toast');
    if (!toast) return;
    const n = summary?.newOrders || 0;
    toast.textContent = n === 1 ? '1 new order synced' : `${n} new orders synced`;
    toast.classList.add('visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('visible'), 4000);
  }

  // ============================================
  // Sync now button + last-synced label
  // ============================================

  async function updateLastSyncedLabel() {
    const label = document.getElementById('orders-last-synced');
    if (!label) return;
    try {
      const saved = await window.electron?.getSetting?.('ordersLastSyncedAt');
      if (saved) {
        label.textContent = `Last synced ${new Date(Number(saved)).toLocaleTimeString()}`;
      }
    } catch (_) { /* ignore */ }
  }

  function bindSyncButton() {
    const btn = document.getElementById('orders-sync-now-btn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Syncing…';
      try {
        const result = await window.electron.syncShopifyOrders({});
        if (result && result.error) {
          alert(`Sync failed: ${result.error}`);
        }
      } catch (e) {
        alert(`Sync failed: ${e.message || e}`);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sync now';
      }
    });
  }

  // ============================================
  // React to a sync completing anywhere (manual button, interval watcher,
  // or another window) - badge + toast always; re-render the list only if
  // it's actually been opened this session, so a background sync in an
  // unopened pane doesn't do pointless work.
  // ============================================

  function bindSyncedEvent() {
    window.electron?.onShopifyOrdersSynced?.((summary) => {
      refreshBadge();
      window.electron?.saveSetting?.('ordersLastSyncedAt', String(Date.now()));
      updateLastSyncedLabel();
      if (summary && summary.newOrders > 0) {
        showSyncToast(summary);
      }
      if (ordersListLoaded) {
        renderOrdersList();
      }
    });
  }

  // ============================================
  // Lazy-load the list the first time the pane is actually shown
  // ============================================

  function bindPaneOpenRefresh() {
    document.addEventListener('pane-layout-changed', (e) => {
      const pinned = e.detail?.pinnedPanes || [];
      if (pinned.includes(PANE_ID)) loadOrdersIfNeeded();
    });

    const edgeTab = document.getElementById('orders-pane-edge-tab');
    if (edgeTab) {
      edgeTab.addEventListener('mouseenter', loadOrdersIfNeeded, { once: true });
      edgeTab.addEventListener('click', loadOrdersIfNeeded, { once: true });
    }
  }

  // ============================================
  // Initialization
  // ============================================

  /**
   * If the pane was left pinned open from a previous session, load its
   * content immediately rather than waiting for a hover/click that won't
   * come (the pane already LOOKS open on restart).
   *
   * Can't just check PaneController.isPinned(PANE_ID) synchronously right
   * after registerPane(): PaneController restores persisted state via an
   * async settings read it never awaits from register(), so isPinned()
   * still reports the pre-restore default (closed) at this exact point even
   * though the pane visually ends up pinned a moment later. Reading the
   * same persisted setting directly here sidesteps that timing gap.
   */
  async function loadIfPersistedOpen() {
    try {
      const saved = await window.electron?.getSetting?.('ordersPaneState');
      if (saved === 'pinned') {
        loadOrdersIfNeeded();
      }
    } catch (_) { /* ignore */ }
  }

  function init() {
    registerPane();
    bindListEvents();
    bindSyncButton();
    bindSyncedEvent();
    bindPaneOpenRefresh();
    refreshBadge();
    updateLastSyncedLabel();
    loadIfPersistedOpen();
  }

  window.OrdersPane = { refreshBadge, renderOrdersList };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
