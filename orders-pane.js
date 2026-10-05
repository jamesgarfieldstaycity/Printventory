/**
 * Orders Pane (GR-PLAN-006): dockable panel showing Shopify orders synced
 * into shopify_orders / shopify_order_line_items, oldest-first (FIFO).
 * Delegates docking/pin/resize/autohide to PaneController, same as
 * Filters and Tools. Phase A: list orders + line items, open a matched
 * line's model file in the configured slicer, and manually link an
 * unmatched line to a model (reconciliation). Phase B (merged 2026-10-05,
 * per James: "can you roll into a single phase"): Mark Printed per line
 * (progress rolls up into the order's local_status) and a per-order
 * fulfillment push (carrier + tracking -> Shopify's fulfillmentCreateV2).
 */
(function () {
  'use strict';

  const PANE_ID = 'orders-pane';

  let modelsCache = null; // lazy-loaded for the manual-link combobox
  let modelsFuse = null; // fuzzy-search index over modelsCache (built once, same data)
  let ordersListLoaded = false;
  let toastTimeout = null;
  let showShipped = false; // "Show shipped" toggle - hidden by default, see getShopifyOrdersHandler
  let allOrdersCache = []; // last full fetch (always includeShipped:true - see renderOrdersList) - showShipped/search filter this in-memory rather than refetching
  let searchQuery = ''; // "find fulfilled orders" (James) - overrides showShipped while non-empty, see getVisibleOrders
  let searchDebounceTimeout = null;

  // Matches Shopify's own fulfillment screen: a dropdown against Shopify's
  // recognized carrier list (so trackingInfo.company matches well enough
  // for Shopify to auto-generate the customer's tracking link), DPD pinned
  // first as James's actual carrier, with a free-text fallback for
  // anything else (see GR-PLAN-006's "Shipping / fulfillment" decision -
  // no carrier API/account integration of any kind).
  const CARRIER_OPTIONS = ['DPD', 'Royal Mail', 'UPS', 'FedEx', 'DHL Express', 'USPS', 'Other'];

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
    try {
      if (typeof window.Fuse !== 'function') throw new Error('window.Fuse is not available');
      modelsFuse = new window.Fuse(models, {
        keys: ['fileName'],
        threshold: 0.4,
        ignoreLocation: true,
        minMatchCharLength: 1
      });
    } catch (e) {
      // Belt-and-braces: if Fuse somehow isn't available (or throws), fall
      // back to a plain case-insensitive substring filter rather than
      // leaving the dropdown silently empty - James still gets a working
      // search, just without fuzzy matching.
      console.error('[OrdersPane] Fuse unavailable, falling back to plain substring search:', e);
      modelsFuse = {
        search: (query, opts) => {
          const q = query.toLowerCase();
          const limit = opts?.limit ?? models.length;
          return models
            .filter((m) => (m.fileName || '').toLowerCase().includes(q))
            .slice(0, limit)
            .map((item) => ({ item }));
        }
      };
    }
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
        ${renderPrintedControl(li)}
      </div>
    `;
  }

  /**
   * Mark Printed - only offered for a line whose own file is actually
   * known (auto-matched/manually-linked), same gating as "Open in Slicer"
   * - a product-linked bundle line is ambiguous at the line level (which
   * variant?) until resolved through the product editor, so no control
   * here for those (see GR-PLAN-006's matching-rule writeup). One click
   * logs one unit printed via the model's existing print lifecycle;
   * quantity > 1 lines show progress and support repeat clicks.
   */
  function renderPrintedControl(li) {
    const isPrintable = li.link_status === 'auto-matched' || li.link_status === 'manually-linked';
    if (!isPrintable) return '';
    const ordered = Number(li.quantity_ordered) || 1;
    const printed = Number(li.quantity_printed) || 0;
    const progressLabel = ordered > 1 ? ` (${printed}/${ordered})` : '';
    if (printed >= ordered) {
      return `<div class="order-line-print-row"><span class="order-line-printed-done">✓ Printed${progressLabel}</span></div>`;
    }
    return `
      <div class="order-line-print-row">
        <button type="button" class="order-line-print-btn" data-action="mark-printed" data-line-id="${li.id}">Mark Printed${progressLabel}</button>
      </div>`;
  }

  function renderLocalStatusPill(status) {
    const s = status || 'new';
    const label = { new: 'New', printing: 'Printing', printed: 'Printed', shipped: 'Shipped' }[s] || s;
    return `<span class="order-local-status-pill order-local-status-${escapeHtml(s)}">${escapeHtml(label)}</span>`;
  }

  /**
   * Once shipped, show the recorded result read-only - a fulfillment push
   * is a one-way, Shopify-confirmed action, not something to re-do from
   * here. Otherwise, a collapsed toggle opens the carrier/tracking form;
   * the tracking URL field only matters for "Other" (Shopify auto-
   * generates it for a recognized carrier like DPD).
   */
  function renderShipSection(order) {
    if (order.local_status === 'shipped') {
      const bits = [order.tracking_carrier, order.tracking_number].filter(Boolean).join(' · ');
      return `<div class="order-ship-section order-ship-shipped">Shipped${bits ? ` — ${escapeHtml(bits)}` : ''}</div>`;
    }
    const carrierOptionsHtml = CARRIER_OPTIONS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    return `
      <div class="order-ship-section" data-order-id="${order.id}">
        <button type="button" class="order-ship-toggle" data-action="toggle-ship">Ship order…</button>
        <div class="order-ship-panel" hidden>
          <select class="order-ship-carrier">${carrierOptionsHtml}</select>
          <input type="text" class="order-ship-tracking-number" placeholder="Tracking number" autocomplete="off">
          <input type="text" class="order-ship-tracking-url" placeholder="Tracking URL (only needed for 'Other')" autocomplete="off" hidden>
          <button type="button" class="order-ship-confirm-btn" data-action="confirm-ship" data-order-id="${order.id}">Mark Shipped</button>
        </div>
      </div>`;
  }

  function renderOrderCard(order) {
    const lines = (order.lineItems || []).map(renderLineItem).join('');
    return `
      <div class="order-card" data-order-id="${order.id}">
        <div class="order-card-header">
          <span class="order-card-name">${escapeHtml(order.order_name)}</span>
          <span class="order-card-customer">${escapeHtml(order.customer_name || '')}</span>
        </div>
        <div class="order-card-meta">
          ${formatOrderDate(order.order_created_at)} · ${escapeHtml(order.financial_status || '')}
          ${renderLocalStatusPill(order.local_status)}
        </div>
        <div class="order-lines">${lines}</div>
        ${renderShipSection(order)}
      </div>
    `;
  }

  function captureListUiState(listEl) {
    const state = { scrollTop: listEl.scrollTop, shipDrafts: {} };
    listEl.querySelectorAll('.order-ship-section[data-order-id]').forEach((section) => {
      const panel = section.querySelector('.order-ship-panel');
      if (!panel || panel.hidden) return;
      state.shipDrafts[section.dataset.orderId] = {
        carrier: section.querySelector('.order-ship-carrier')?.value,
        trackingNumber: section.querySelector('.order-ship-tracking-number')?.value || '',
        trackingUrl: section.querySelector('.order-ship-tracking-url')?.value || ''
      };
    });
    return state;
  }

  /**
   * James: "clicking mark printed causes the pane to jump to the top, its
   * confusing" / "can ship order be collapsed until im ready to complete"
   * - both trace back to the same cause. Mark Printed, Ship, Unlink, a
   * variant assignment and a background sync all share one live-refresh
   * mechanism (the shopify-orders-synced event -> renderOrdersList), which
   * rebuilt #orders-list from scratch - resetting scroll to the top and
   * silently collapsing any "Ship order..." panel James had open and was
   * mid-filling-in. Restoring both after the rebuild keeps a panel he
   * opened open, with whatever he'd already typed, until he actually
   * completes it or collapses it himself - and keeps his place in the list.
   */
  function restoreListUiState(listEl, state) {
    if (!state) return;
    for (const [orderId, draft] of Object.entries(state.shipDrafts)) {
      const section = listEl.querySelector(`.order-ship-section[data-order-id="${orderId}"]`);
      const panel = section?.querySelector('.order-ship-panel');
      if (!panel) continue;
      panel.hidden = false;
      const carrierSelect = section.querySelector('.order-ship-carrier');
      if (carrierSelect && draft.carrier) carrierSelect.value = draft.carrier;
      const numberInput = section.querySelector('.order-ship-tracking-number');
      if (numberInput) numberInput.value = draft.trackingNumber;
      const urlInput = section.querySelector('.order-ship-tracking-url');
      if (urlInput) {
        urlInput.hidden = carrierSelect?.value !== 'Other';
        urlInput.value = draft.trackingUrl;
      }
    }
    listEl.scrollTop = state.scrollTop;
  }

  function orderMatchesSearch(order, q) {
    if ((order.order_name || '').toLowerCase().includes(q)) return true;
    if ((order.customer_name || '').toLowerCase().includes(q)) return true;
    return (order.lineItems || []).some((li) =>
      (li.title || '').toLowerCase().includes(q) ||
      (li.sku || '').toLowerCase().includes(q) ||
      (li.variant_title || '').toLowerCase().includes(q)
    );
  }

  /**
   * James: "it would be good to add a search to this pane as well to find
   * fulfilled orders" - a search deliberately searches across EVERYTHING
   * (open and shipped alike) regardless of the "Show shipped" toggle,
   * since the whole point is finding an order the default view is
   * currently hiding. The toggle only governs what shows when there's no
   * active search.
   */
  function getVisibleOrders() {
    const q = searchQuery.trim().toLowerCase();
    if (q) return allOrdersCache.filter((o) => orderMatchesSearch(o, q));
    return showShipped ? allOrdersCache : allOrdersCache.filter((o) => o.local_status !== 'shipped');
  }

  function renderVisibleOrders() {
    const listEl = document.getElementById('orders-list');
    if (!listEl) return;
    const uiState = captureListUiState(listEl);
    const orders = getVisibleOrders();
    if (!orders.length) {
      if (searchQuery.trim()) {
        listEl.innerHTML = '<div class="orders-empty-state">No orders match your search.</div>';
      } else {
        listEl.innerHTML = showShipped
          ? '<div class="orders-empty-state">No orders yet.</div>'
          : '<div class="orders-empty-state">No open orders. New orders will appear here after the next sync.</div>';
      }
      return;
    }
    listEl.innerHTML = orders.map(renderOrderCard).join('');
    restoreListUiState(listEl, uiState);
  }

  async function renderOrdersList() {
    const listEl = document.getElementById('orders-list');
    if (!listEl) return;
    try {
      // Always fetch the full set (open + shipped) and cache it - the
      // showShipped toggle and the search box both filter this in-memory
      // afterwards (getVisibleOrders) rather than triggering another
      // round trip to the DB. Deliberately doesn't blank the list to a
      // "Loading..." placeholder first: renderVisibleOrders captures/
      // restores scroll + ship-panel state from whatever is currently
      // rendered, so clearing it here first would throw that state away
      // before it can be read.
      allOrdersCache = await window.electron.getShopifyOrders({ includeShipped: true });
      renderVisibleOrders();
    } catch (e) {
      console.error('[OrdersPane] Failed to load orders:', e);
      listEl.innerHTML = '<div class="orders-empty-state">Could not load orders.</div>';
    }
  }

  function bindShowShippedToggle() {
    const checkbox = document.getElementById('orders-show-shipped-checkbox');
    if (!checkbox || checkbox.dataset.bound) return;
    checkbox.dataset.bound = '1';
    checkbox.addEventListener('change', () => {
      showShipped = checkbox.checked;
      if (ordersListLoaded) renderVisibleOrders();
    });
  }

  function bindOrdersSearchInput() {
    const input = document.getElementById('orders-search-input');
    if (!input || input.dataset.bound) return;
    input.dataset.bound = '1';
    input.addEventListener('input', () => {
      searchQuery = input.value;
      clearTimeout(searchDebounceTimeout);
      // Filters the already-cached data in-memory - debounced only to
      // avoid a full re-render (and its restoreListUiState pass) on every
      // single keystroke, not to avoid a network/DB round trip.
      searchDebounceTimeout = setTimeout(() => {
        if (ordersListLoaded) renderVisibleOrders();
      }, 120);
    });
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

  async function handleMarkPrinted(btn) {
    const lineId = btn.dataset.lineId;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Marking…';
    try {
      const result = await window.electron.markOrderLineItemPrinted({ lineItemId: Number(lineId), quantity: 1 });
      if (result && result.error) {
        alert(`Could not mark printed: ${result.error}`);
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      // Don't re-render here - main.js's handler already emitted
      // shopify-orders-synced, which bindSyncedEvent() below turns into a
      // badge refresh + a single list rebuild. Rendering twice was the
      // scroll-jump/collapsed-ship-panel bug.
    } catch (e) {
      alert(`Could not mark printed: ${e.message || e}`);
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  async function handleShipOrder(btn) {
    const orderId = btn.dataset.orderId;
    const panel = btn.closest('.order-ship-panel');
    const carrier = panel?.querySelector('.order-ship-carrier')?.value || '';
    const numberInput = panel?.querySelector('.order-ship-tracking-number');
    const urlInput = panel?.querySelector('.order-ship-tracking-url');
    const trackingNumber = (numberInput?.value || '').trim();
    const trackingUrl = (urlInput?.value || '').trim();

    if (!trackingNumber) {
      alert('Enter a tracking number first.');
      return;
    }
    if (!confirm(`Mark this order shipped via ${carrier} (${trackingNumber})?\n\nThis notifies the customer through Shopify.`)) {
      return;
    }

    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Shipping…';
    try {
      const result = await window.electron.shipShopifyOrder({
        orderId: Number(orderId), carrier, trackingNumber, trackingUrl: trackingUrl || null
      });
      if (result && result.error) {
        alert(`Could not mark shipped: ${result.error}`);
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      // Same as Mark Printed above - the backend's own shopify-orders-synced
      // event already triggers the one refresh this needs.
    } catch (e) {
      alert(`Could not mark shipped: ${e.message || e}`);
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  const COMBOBOX_RESULT_LIMIT = 50;
  const COMBOBOX_BROWSE_CAP = 300; // click-to-browse-all cap; typing narrows below this via fuzzy search
  const HIGHLIGHT_CLASS = 'order-line-combobox-item-active';

  function closeCombobox(container) {
    const resultsEl = container.querySelector('.order-line-combobox-results');
    if (resultsEl) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
    }
  }

  /**
   * Two ways into the same dropdown, per James's feedback: click/focus the
   * (empty) box and scroll a full list, OR type and have that same list
   * filter live. An empty query renders the first COMBOBOX_BROWSE_CAP models
   * (there can be thousands - unbounded would be a DOM-perf problem) with a
   * note if more exist; a non-empty query runs the existing fuzzy search.
   */
  async function showComboboxResults(container, resultsEl, query) {
    if (!resultsEl) return;

    try {
      let matches;
      let moreNote = '';

      if (!query) {
        const models = await ensureModelsCache();
        matches = models.slice(0, COMBOBOX_BROWSE_CAP).map((item) => ({ item }));
        if (models.length > COMBOBOX_BROWSE_CAP) {
          moreNote = `<div class="order-line-combobox-empty">Showing first ${COMBOBOX_BROWSE_CAP} of ${models.length} - type to narrow</div>`;
        }
      } else {
        const fuse = await ensureModelsFuse();
        matches = fuse.search(query, { limit: COMBOBOX_RESULT_LIMIT });
      }

      if (!matches.length) {
        resultsEl.innerHTML = '<div class="order-line-combobox-empty">No matching models</div>';
        resultsEl.hidden = false;
        return;
      }

      resultsEl.innerHTML = matches.map((m) =>
        `<div class="order-line-combobox-item" data-model-id="${m.item.id}">${escapeHtml(m.item.fileName)}</div>`
      ).join('') + moreNote;
      resultsEl.hidden = false;
    } catch (e) {
      console.error('[OrdersPane] Model search failed:', e);
      resultsEl.innerHTML = '<div class="order-line-combobox-empty">Search failed - see console</div>';
      resultsEl.hidden = false;
    }
  }

  async function handleComboboxInput(input) {
    const container = input.closest('.order-line-combobox');
    const resultsEl = container?.querySelector('.order-line-combobox-results');
    await showComboboxResults(container, resultsEl, input.value.trim());
  }

  /**
   * Opens the browse-all (or still-filtered, if there's already text)
   * dropdown on focus/click, rather than requiring a keystroke first.
   * Skipped if results are already showing, so re-focusing a box that's
   * mid-search doesn't flicker or redo the same lookup.
   */
  function handleComboboxActivate(input) {
    const container = input.closest('.order-line-combobox');
    const resultsEl = container?.querySelector('.order-line-combobox-results');
    if (resultsEl && resultsEl.hidden) {
      showComboboxResults(container, resultsEl, input.value.trim());
    }
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
      const linkInput = e.target.closest('[data-action="link-model-input"]');
      if (linkInput) { handleComboboxActivate(linkInput); return; }
      const printBtn = e.target.closest('[data-action="mark-printed"]');
      if (printBtn) { handleMarkPrinted(printBtn); return; }
      const shipToggleBtn = e.target.closest('[data-action="toggle-ship"]');
      if (shipToggleBtn) {
        const panel = shipToggleBtn.nextElementSibling;
        if (panel) panel.hidden = !panel.hidden;
        return;
      }
      const shipConfirmBtn = e.target.closest('[data-action="confirm-ship"]');
      if (shipConfirmBtn) { handleShipOrder(shipConfirmBtn); return; }
    });

    // Shopify auto-generates the tracking link for a recognized carrier
    // (DPD etc.) but not for free text, so the URL field only matters - and
    // only shows - when "Other" is selected.
    listEl.addEventListener('change', (e) => {
      const select = e.target.closest('.order-ship-carrier');
      if (!select) return;
      const urlInput = select.closest('.order-ship-panel')?.querySelector('.order-ship-tracking-url');
      if (urlInput) urlInput.hidden = select.value !== 'Other';
    });

    // Double-clicking anywhere on a line card opens the product manager
    // for it, as a second, consistent way in regardless of which action
    // button the card currently shows (Open in Slicer vs. Open Product
    // Manager) - James: "can double clicking the card open the manage
    // dialog as well?" Skips the manual-link combobox so normal text
    // interactions (e.g. double-click-to-select-a-word) aren't hijacked,
    // and does nothing for a line with no resolved file yet (unmatched).
    listEl.addEventListener('dblclick', (e) => {
      if (e.target.closest('.order-line-combobox')) return;

      const line = e.target.closest('.order-line');
      if (!line) return;

      const pathEl = line.querySelector('[data-path]');
      const path = pathEl?.dataset.path;
      if (!path || typeof window.openShopifyProductEditorForPath !== 'function') return;

      window.openShopifyProductEditorForPath(path);
    });

    listEl.addEventListener('input', (e) => {
      const input = e.target.closest('[data-action="link-model-input"]');
      if (input) handleComboboxInput(input);
    });

    // focusin bubbles (focus doesn't) - open the browse-all dropdown as
    // soon as the box receives focus (tabbing in), not only once typing
    // starts.
    listEl.addEventListener('focusin', (e) => {
      const input = e.target.closest('[data-action="link-model-input"]');
      if (input) handleComboboxActivate(input);
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
    const backfilled = summary?.historicalShipmentsBackfilled || 0;
    const parts = [];
    if (n > 0) parts.push(n === 1 ? '1 new order synced' : `${n} new orders synced`);
    if (backfilled > 0) {
      // GR-PLAN-006: historical orders found to already be genuinely
      // shipped (real tracking info on the Shopify order), backfilled as
      // shipped here rather than needing James to process them by hand.
      parts.push(backfilled === 1
        ? '1 order marked shipped from history'
        : `${backfilled} orders marked shipped from history`);
    }
    if (!parts.length) return;
    toast.textContent = parts.join(' · ');
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
      if (summary && (summary.newOrders > 0 || summary.historicalShipmentsBackfilled > 0)) {
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
    bindShowShippedToggle();
    bindOrdersSearchInput();
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
