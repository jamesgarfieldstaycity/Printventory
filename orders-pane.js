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

  let modelsCache = null; // lazy-loaded for the manual-link combobox
  let modelsFuse = null; // fuzzy-search index over modelsCache (built once, same data)
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

  /**
   * Native <datalist> was the first cut of the manual-link control, but
   * James reported it two ways: the browser's own suggestion popup doesn't
   * scroll reliably with a few thousand models in it, and matching is
   * prefix-only, not "recognize characters" (substring/fuzzy) search. Fuse
   * is already vendored and loaded globally (vendor/fuse.min.js) for
   * exactly this kind of search elsewhere in the app, just unused here
   * until now - reuse it instead of hand-rolling matching, and render
   * results into our own scrollable dropdown instead of a native popup.
   */
  async function ensureModelsFuse() {
    if (modelsFuse) return modelsFuse;
    const models = await ensureModelsCache();
    modelsFuse = new window.Fuse(models, {
      keys: ['fileName'],
      threshold: 0.4,
      ignoreLocation: true,
      minMatchCharLength: 1
    });
    return modelsFuse;
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
      actionHtml = `
        <div class="order-line-combobox" data-line-id="${li.id}">
          <input type="text" class="order-line-link-input" placeholder="Link to model..."
            data-action="link-model-input" data-line-id="${li.id}" autocomplete="off" spellcheck="false">
          <div class="order-line-combobox-results" hidden></div>
        </div>`;
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

  const COMBOBOX_RESULT_LIMIT = 50;
  const HIGHLIGHT_CLASS = 'order-line-combobox-item-active';

  function closeCombobox(container) {
    const resultsEl = container.querySelector('.order-line-combobox-results');
    if (resultsEl) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
    }
  }

  async function handleComboboxInput(input) {
    const container = input.closest('.order-line-combobox');
    const resultsEl = container?.querySelector('.order-line-combobox-results');
    if (!resultsEl) return;

    const query = input.value.trim();
    if (!query) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      return;
    }

    const fuse = await ensureModelsFuse();
    const matches = fuse.search(query, { limit: COMBOBOX_RESULT_LIMIT });

    if (!matches.length) {
      resultsEl.innerHTML = '<div class="order-line-combobox-empty">No matching models</div>';
      resultsEl.hidden = false;
      return;
    }

    resultsEl.innerHTML = matches.map((m) =>
      `<div class="order-line-combobox-item" data-model-id="${m.item.id}">${escapeHtml(m.item.fileName)}</div>`
    ).join('');
    resultsEl.hidden = false;
  }

  function moveComboboxHighlight(container, direction) {
    const resultsEl = container.querySelector('.order-line-combobox-results');
    if (!resultsEl || resultsEl.hidden) return;
    const items = Array.from(resultsEl.querySelectorAll('.order-line-combobox-item'));
    if (!items.length) return;
    const currentIndex = items.findIndex((el) => el.classList.contains(HIGHLIGHT_CLASS));
    let nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = items.length - 1;
    if (nextIndex >= items.length) nextIndex = 0;
    items.forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
    items[nextIndex].classList.add(HIGHLIGHT_CLASS);
    items[nextIndex].scrollIntoView({ block: 'nearest' });
  }

  async function selectModelForLine(container, modelId) {
    const lineId = container.dataset.lineId;
    const input = container.querySelector('.order-line-link-input');
    closeCombobox(container);
    if (input) {
      input.disabled = true;
      input.value = 'Linking…';
    }
    try {
      const result = await window.electron.linkOrderLineItem({ lineItemId: Number(lineId), modelId: Number(modelId) });
      if (result && result.error) {
        alert(`Could not link: ${result.error}`);
        if (input) { input.disabled = false; input.value = ''; }
        return;
      }
      await renderOrdersList();
      await refreshBadge();
    } catch (e) {
      alert(`Could not link: ${e.message || e}`);
      if (input) { input.disabled = false; input.value = ''; }
    }
  }

  function handleComboboxKeydown(e, input) {
    const container = input.closest('.order-line-combobox');
    if (!container) return;
    if (e.key === 'Escape') {
      closeCombobox(container);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveComboboxHighlight(container, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveComboboxHighlight(container, -1);
    } else if (e.key === 'Enter') {
      const resultsEl = container.querySelector('.order-line-combobox-results');
      const active = resultsEl?.querySelector(`.${HIGHLIGHT_CLASS}`) || resultsEl?.querySelector('.order-line-combobox-item');
      if (active) {
        e.preventDefault();
        selectModelForLine(container, active.dataset.modelId);
      }
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

    listEl.addEventListener('input', (e) => {
      const input = e.target.closest('[data-action="link-model-input"]');
      if (input) handleComboboxInput(input);
    });

    listEl.addEventListener('keydown', (e) => {
      const input = e.target.closest('[data-action="link-model-input"]');
      if (input) handleComboboxKeydown(e, input);
    });

    // mousedown (not click) fires before the input's blur/focusout, so the
    // selection is read before the dropdown would otherwise get torn down.
    listEl.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.order-line-combobox-item');
      if (!item) return;
      e.preventDefault();
      const container = item.closest('.order-line-combobox');
      if (container) selectModelForLine(container, item.dataset.modelId);
    });

    // focusout bubbles (blur doesn't) - close the dropdown once focus
    // actually leaves the combobox, with a short delay so a mousedown
    // selection above still lands first.
    listEl.addEventListener('focusout', (e) => {
      const container = e.target.closest('.order-line-combobox');
      if (!container) return;
      setTimeout(() => {
        if (!container.contains(document.activeElement)) closeCombobox(container);
      }, 150);
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
