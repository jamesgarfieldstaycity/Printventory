/**
 * Unified Pane Controller
 * Manages all collapsible/dockable panes with shared state coordination.
 * Supports three states: closed, pinned, autohide.
 * Provides mutual exclusion for auto-hide reveals (only one at a time).
 * Allows multiple panes to be pinned simultaneously (stacked left to right).
 */
(function () {
  'use strict';

  // ============================================
  // Constants
  // ============================================
  const STATE_CLOSED = 'closed';
  const STATE_PINNED = 'pinned';
  const STATE_AUTOHIDE = 'autohide';

  const VALID_STATES = [STATE_CLOSED, STATE_PINNED, STATE_AUTOHIDE];

  const AUTOHIDE_DELAY = 500; // ms before auto-hiding after mouse leaves (enough time to reach pin button)

  // ============================================
  // State
  // ============================================
  const panes = new Map(); // paneId -> pane config and state
  let revealedPaneId = null; // Track which auto-hide pane is currently revealed
  let initialized = false;

  // ============================================
  // Utility functions
  // ============================================
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function parseWidth(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  // ============================================
  // Pane class
  // ============================================
  class Pane {
    constructor(id, config) {
      this.id = id;
      this.elementSelector = config.element;
      this.edgeTabSelector = config.edgeTab;
      this.settingKeyState = config.settingPrefix + 'State';
      this.settingKeyWidth = config.settingPrefix + 'Width';
      this.defaultState = config.defaultState || STATE_PINNED;
      this.defaultWidth = config.defaultWidth || 320;
      this.minWidth = config.minWidth || 280;
      this.maxWidth = config.maxWidth || 500;
      this.order = config.order || 1;
      this.cssWidthVar = config.cssWidthVar || `--${id}-width`;
      this.bodyClassPrefix = config.bodyClassPrefix || id;
      this.ipcChannel = config.ipcChannel || null;

      // Runtime state
      this.state = this.defaultState;
      this.width = this.defaultWidth;
      this.isHovering = false;
      this.autoHideTimeout = null;
      this.bound = false;
    }

    getElement() {
      return document.querySelector(this.elementSelector);
    }

    getEdgeTab() {
      return document.querySelector(this.edgeTabSelector);
    }
  }

  // ============================================
  // Core functions
  // ============================================

  /**
   * Register a pane with the controller
   */
  function register(paneId, config) {
    if (panes.has(paneId)) {
      console.warn(`[PaneController] Pane "${paneId}" already registered`);
      return;
    }

    const pane = new Pane(paneId, config);
    panes.set(paneId, pane);

    // If already initialized, bind this pane immediately
    if (initialized) {
      bindPane(pane);
      loadPaneState(pane);
    }
  }

  /**
   * Set the state of a pane
   */
  function setState(paneId, newState) {
    const pane = panes.get(paneId);
    if (!pane) {
      console.warn(`[PaneController] Unknown pane "${paneId}"`);
      return;
    }

    if (!VALID_STATES.includes(newState)) {
      console.warn(`[PaneController] Invalid state "${newState}"`);
      return;
    }

    if (pane.state === newState) return;

    // If this pane was revealed and we're changing state, unreveal it first
    if (revealedPaneId === paneId) {
      unrevealInternal(pane);
    }

    pane.state = newState;
    applyPaneState(pane);
    persistPaneState(pane);
    notifyMenuState(pane);
    updateLayout();
  }

  /**
   * Toggle between pinned and autohide states
   */
  function togglePinned(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;

    if (pane.state === STATE_PINNED) {
      setState(paneId, STATE_AUTOHIDE);
    } else {
      setState(paneId, STATE_PINNED);
    }
  }

  /**
   * Close a pane
   */
  function close(paneId) {
    setState(paneId, STATE_CLOSED);
  }

  /**
   * Open a pane (sets to pinned if closed)
   */
  function open(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;

    if (pane.state === STATE_CLOSED) {
      setState(paneId, STATE_PINNED);
    }
  }

  /**
   * Toggle between closed and pinned
   */
  function toggle(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;

    if (pane.state === STATE_CLOSED) {
      setState(paneId, STATE_PINNED);
    } else {
      setState(paneId, STATE_CLOSED);
    }
  }

  /**
   * Reveal an auto-hide pane (with mutual exclusion)
   */
  function reveal(paneId) {
    const pane = panes.get(paneId);
    if (!pane || pane.state !== STATE_AUTOHIDE) return;

    // MUTUAL EXCLUSION: Unreveal any other revealed pane first
    if (revealedPaneId && revealedPaneId !== paneId) {
      const otherPane = panes.get(revealedPaneId);
      if (otherPane) {
        unrevealInternal(otherPane);
      }
    }

    revealedPaneId = paneId;
    const el = pane.getElement();
    const edgeTab = pane.getEdgeTab();

    if (el) {
      el.classList.add('pane-revealed');
      el.setAttribute('aria-hidden', 'false');
    }
    if (edgeTab) {
      edgeTab.classList.add('active');
    }
  }

  /**
   * Unreveal an auto-hide pane
   */
  function unreveal(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;
    unrevealInternal(pane);
  }

  function unrevealInternal(pane) {
    if (revealedPaneId === pane.id) {
      revealedPaneId = null;
    }

    const el = pane.getElement();
    const edgeTab = pane.getEdgeTab();

    if (el) {
      el.classList.remove('pane-revealed');
      if (pane.state !== STATE_PINNED) {
        el.setAttribute('aria-hidden', 'true');
      }
    }
    if (edgeTab) {
      edgeTab.classList.remove('active');
    }
  }

  /**
   * Set pane width
   */
  function setWidth(paneId, px) {
    const pane = panes.get(paneId);
    if (!pane) return;

    pane.width = clamp(Math.round(px), pane.minWidth, pane.maxWidth);
    document.documentElement.style.setProperty(pane.cssWidthVar, `${pane.width}px`);
  }

  /**
   * Persist pane width
   */
  function persistWidth(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;

    try {
      window.electron?.saveSetting?.(pane.settingKeyWidth, String(pane.width));
    } catch (_) { /* ignore */ }
  }

  // ============================================
  // Query functions
  // ============================================

  function getState(paneId) {
    const pane = panes.get(paneId);
    return pane ? pane.state : null;
  }

  function getWidth(paneId) {
    const pane = panes.get(paneId);
    return pane ? pane.width : null;
  }

  function isPinned(paneId) {
    const pane = panes.get(paneId);
    return pane ? pane.state === STATE_PINNED : false;
  }

  function isAutohide(paneId) {
    const pane = panes.get(paneId);
    return pane ? pane.state === STATE_AUTOHIDE : false;
  }

  function isClosed(paneId) {
    const pane = panes.get(paneId);
    return pane ? pane.state === STATE_CLOSED : true;
  }

  function isRevealed(paneId) {
    return revealedPaneId === paneId;
  }

  /**
   * Get all pinned panes sorted by order
   */
  function getPinnedPanes() {
    return Array.from(panes.values())
      .filter(p => p.state === STATE_PINNED)
      .sort((a, b) => a.order - b.order)
      .map(p => p.id);
  }

  // ============================================
  // DOM state application
  // ============================================

  function applyPaneState(pane) {
    const el = pane.getElement();
    const edgeTab = pane.getEdgeTab();
    const body = document.body;

    if (!el) return;

    // Remove all state classes
    el.classList.remove('pane-closed', 'pane-pinned', 'pane-autohide', 'pane-revealed');

    // Remove body classes
    body.classList.remove(
      `${pane.bodyClassPrefix}-pinned`,
      `${pane.bodyClassPrefix}-autohide`,
      `${pane.bodyClassPrefix}-closed`
    );

    // Apply current state
    switch (pane.state) {
      case STATE_CLOSED:
        el.classList.add('pane-closed');
        body.classList.add(`${pane.bodyClassPrefix}-closed`);
        el.setAttribute('aria-hidden', 'true');
        if (edgeTab) edgeTab.classList.remove('hidden');
        break;

      case STATE_PINNED:
        el.classList.add('pane-pinned');
        body.classList.add(`${pane.bodyClassPrefix}-pinned`);
        el.setAttribute('aria-hidden', 'false');
        if (edgeTab) edgeTab.classList.add('hidden');
        break;

      case STATE_AUTOHIDE:
        el.classList.add('pane-autohide');
        body.classList.add(`${pane.bodyClassPrefix}-autohide`);
        el.setAttribute('aria-hidden', 'true');
        if (edgeTab) edgeTab.classList.remove('hidden');
        break;
    }

    // Update pin button state
    updatePinButton(pane);

    // Apply width CSS variable
    document.documentElement.style.setProperty(pane.cssWidthVar, `${pane.width}px`);
  }

  function updatePinButton(pane) {
    const el = pane.getElement();
    if (!el) return;

    // Support both naming conventions: .pane-pin-btn and .sidebar-pin-btn
    const pinBtn = el.querySelector('.pane-pin-btn, .sidebar-pin-btn');
    if (pinBtn) {
      pinBtn.classList.toggle('active', pane.state === STATE_PINNED);
      pinBtn.setAttribute('aria-pressed', pane.state === STATE_PINNED ? 'true' : 'false');
      pinBtn.title = pane.state === STATE_PINNED ? 'Unpin (auto-hide)' : 'Pin open';
    }
  }

  /**
   * Update layout based on which panes are pinned
   * This triggers CSS recalculation for proper stacking
   */
  function updateLayout() {
    // Dispatch event for any listeners that need to know about layout changes
    document.dispatchEvent(new CustomEvent('pane-layout-changed', {
      detail: {
        pinnedPanes: getPinnedPanes(),
        revealedPane: revealedPaneId
      }
    }));

    // Trigger grid reflow if needed
    const grid = document.querySelector('.file-grid');
    if (grid) {
      requestAnimationFrame(() => {
        if (typeof grid.renderVisibleItemsFn === 'function') {
          grid.renderVisibleItemsFn();
        }
      });
    }
  }

  // ============================================
  // Persistence
  // ============================================

  function persistPaneState(pane) {
    try {
      window.electron?.saveSetting?.(pane.settingKeyState, pane.state);
    } catch (_) { /* ignore */ }
  }

  async function loadPaneState(pane) {
    try {
      const savedState = await window.electron?.getSetting?.(pane.settingKeyState);
      if (savedState && VALID_STATES.includes(savedState)) {
        pane.state = savedState;
      }
    } catch (_) { /* ignore */ }

    try {
      const savedWidth = await window.electron?.getSetting?.(pane.settingKeyWidth);
      if (savedWidth) {
        pane.width = parseWidth(savedWidth, pane.defaultWidth);
      }
    } catch (_) { /* ignore */ }

    applyPaneState(pane);
  }

  // ============================================
  // Menu integration
  // ============================================

  function notifyMenuState(pane) {
    if (!pane.ipcChannel) return;
    try {
      window.electron?.send?.(pane.ipcChannel, pane.state !== STATE_CLOSED);
    } catch (_) { /* ignore */ }
  }

  // ============================================
  // Event binding
  // ============================================

  function bindPane(pane) {
    if (pane.bound) return;
    pane.bound = true;

    const el = pane.getElement();
    const edgeTab = pane.getEdgeTab();

    if (!el) {
      console.warn(`[PaneController] Element not found for pane "${pane.id}"`);
      return;
    }

    // Pin button - support both naming conventions
    const pinBtn = el.querySelector('.pane-pin-btn, .sidebar-pin-btn');
    if (pinBtn && !pinBtn.dataset.pcBound) {
      pinBtn.dataset.pcBound = '1';
      pinBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePinned(pane.id);
      });
    }

    // Close button - support both naming conventions
    const closeBtn = el.querySelector('.pane-close-btn, .sidebar-close-btn');
    if (closeBtn && !closeBtn.dataset.pcBound) {
      closeBtn.dataset.pcBound = '1';
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        close(pane.id);
      });
    }

    // Pane hover events (for auto-hide timeout management)
    if (!el.dataset.pcHoverBound) {
      el.dataset.pcHoverBound = '1';
      el.addEventListener('mouseenter', () => {
        pane.isHovering = true;
        clearTimeout(pane.autoHideTimeout);
      });
      el.addEventListener('mouseleave', (e) => {
        pane.isHovering = false;
        if (pane.state === STATE_AUTOHIDE && revealedPaneId === pane.id) {
          // Don't hide if moving to edge tab
          if (edgeTab && e.relatedTarget && edgeTab.contains(e.relatedTarget)) {
            return;
          }
          scheduleAutoHide(pane);
        }
      });
    }

    // Edge tab events
    if (edgeTab && !edgeTab.dataset.pcBound) {
      edgeTab.dataset.pcBound = '1';

      edgeTab.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Verify this is the correct edge tab
        if (!edgeTab.contains(e.target)) return;

        if (pane.state === STATE_CLOSED) {
          setState(pane.id, STATE_PINNED);
        } else if (pane.state === STATE_AUTOHIDE) {
          // Click on edge tab while in autohide: pin it
          setState(pane.id, STATE_PINNED);
        }
      });

      edgeTab.addEventListener('mouseenter', (e) => {
        e.stopPropagation();
        // CRITICAL: Verify this is the correct edge tab for this pane
        if (!edgeTab.contains(e.target)) return;

        clearTimeout(pane.autoHideTimeout);
        if (pane.state === STATE_AUTOHIDE) {
          reveal(pane.id);
        }
      });

      edgeTab.addEventListener('mouseleave', (e) => {
        e.stopPropagation();
        if (pane.state === STATE_AUTOHIDE && revealedPaneId === pane.id) {
          // Don't hide if moving to the pane itself
          if (el.contains(e.relatedTarget)) {
            return;
          }
          scheduleAutoHide(pane);
        }
      });
    }

    // Resize handle
    const resizeHandle = el.querySelector('.panel-resize-handle, .pane-resize-handle');
    if (resizeHandle && !resizeHandle.dataset.pcBound) {
      resizeHandle.dataset.pcBound = '1';
      bindResizeHandle(pane, resizeHandle);
    }
  }

  function scheduleAutoHide(pane) {
    clearTimeout(pane.autoHideTimeout);
    pane.autoHideTimeout = setTimeout(() => {
      if (!pane.isHovering && pane.state === STATE_AUTOHIDE) {
        unreveal(pane.id);
      }
    }, AUTOHIDE_DELAY);
  }

  function bindResizeHandle(pane, handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startWidth = pane.width;

      handle.classList.add('is-active');
      document.body.classList.add('is-panel-resizing');

      function onMouseMove(ev) {
        const newWidth = startWidth + (ev.clientX - startX);
        setWidth(pane.id, newWidth);
        updateLayout();
      }

      function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        handle.classList.remove('is-active');
        document.body.classList.remove('is-panel-resizing');
        persistWidth(pane.id);
        updateLayout();
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // ============================================
  // Global event handlers
  // ============================================

  function bindGlobalEvents() {
    // Escape key closes revealed auto-hide panes
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && revealedPaneId) {
        const pane = panes.get(revealedPaneId);
        if (pane && pane.state === STATE_AUTOHIDE) {
          unreveal(revealedPaneId);
        }
      }
    });

    // Click outside closes revealed auto-hide panes
    document.addEventListener('click', (e) => {
      if (!revealedPaneId) return;

      const pane = panes.get(revealedPaneId);
      if (!pane || pane.state !== STATE_AUTOHIDE) return;

      const el = pane.getElement();
      const edgeTab = pane.getEdgeTab();

      if (!el) return;

      const clickedInPane = el.contains(e.target);
      const clickedOnTab = edgeTab && edgeTab.contains(e.target);

      if (!clickedInPane && !clickedOnTab) {
        unreveal(revealedPaneId);
      }
    });
  }

  // ============================================
  // IPC handlers for View menu integration
  // ============================================

  function setupIpcHandlers() {
    // Listen for toggle commands from View menu
    window.electron?.on?.('toggle-filters-pane', () => {
      toggle('filters-pane');
    });

    window.electron?.on?.('toggle-sidebar', () => {
      toggle('sidebar');
    });
  }

  // ============================================
  // Initialization
  // ============================================

  async function init() {
    if (initialized) return;
    initialized = true;

    // Bind all registered panes
    for (const pane of panes.values()) {
      bindPane(pane);
    }

    // Load persisted states
    for (const pane of panes.values()) {
      await loadPaneState(pane);
    }

    bindGlobalEvents();
    setupIpcHandlers();
    updateLayout();
  }

  // ============================================
  // Public API
  // ============================================

  window.PaneController = {
    // Registration
    register,

    // State management
    setState,
    togglePinned,
    close,
    open,
    toggle,
    reveal,
    unreveal,

    // Width management
    setWidth,
    persistWidth,

    // Queries
    getState,
    getWidth,
    isPinned,
    isAutohide,
    isClosed,
    isRevealed,
    getPinnedPanes,

    // Initialization
    init,

    // Constants (for external use)
    STATE_CLOSED,
    STATE_PINNED,
    STATE_AUTOHIDE
  };

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
