/**
 * Filters Pane: Power BI-style dockable panel for all filter controls.
 * Now delegates to PaneController for state management and event handling.
 * This module handles filters-pane-specific functionality like the 'F' key shortcut.
 */
(function () {
  'use strict';

  const PANE_ID = 'filters-pane';

  // ============================================
  // Register with PaneController
  // ============================================

  function registerPane() {
    if (!window.PaneController) {
      console.warn('[FiltersPane] PaneController not loaded');
      return;
    }

    window.PaneController.register(PANE_ID, {
      element: '#filters-pane',
      edgeTab: '#filters-pane-edge-tab',
      settingPrefix: 'filtersPane',
      defaultState: window.PaneController.STATE_PINNED,
      defaultWidth: 320,
      minWidth: 280,
      maxWidth: 500,
      order: 2, // Second in stack order (to the right of sidebar when both pinned)
      cssWidthVar: '--filters-pane-width',
      bodyClassPrefix: 'filters-pane',
      ipcChannel: 'filters-pane-state-changed'
    });
  }

  // ============================================
  // Keyboard shortcut ('F' key)
  // ============================================

  function bindKeyboardShortcut() {
    document.addEventListener('keydown', (e) => {
      // 'F' key toggles filters pane (when not typing in an input)
      if (e.key === 'f' || e.key === 'F') {
        const active = document.activeElement;
        const isTyping = active && (
          active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable
        );
        if (!isTyping && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          window.PaneController?.toggle(PANE_ID);
        }
      }
    });
  }

  // ============================================
  // Legacy API compatibility
  // ============================================

  // These functions delegate to PaneController for backwards compatibility
  // with any code that still calls FiltersPane directly

  function getState() {
    return window.PaneController?.getState(PANE_ID) || 'closed';
  }

  function getWidth() {
    return window.PaneController?.getWidth(PANE_ID) || 320;
  }

  function setState(newState) {
    window.PaneController?.setState(PANE_ID, newState);
  }

  function setWidth(px) {
    window.PaneController?.setWidth(PANE_ID, px);
    window.PaneController?.persistWidth(PANE_ID);
  }

  function open() {
    window.PaneController?.open(PANE_ID);
  }

  function close() {
    window.PaneController?.close(PANE_ID);
  }

  function toggle() {
    window.PaneController?.toggle(PANE_ID);
  }

  function show() {
    window.PaneController?.open(PANE_ID);
  }

  function togglePinned() {
    window.PaneController?.togglePinned(PANE_ID);
  }

  function isPinned() {
    return window.PaneController?.isPinned(PANE_ID) || false;
  }

  function isAutoHide() {
    return window.PaneController?.isAutohide(PANE_ID) || false;
  }

  function isClosed() {
    return window.PaneController?.isClosed(PANE_ID) || true;
  }

  // ============================================
  // Initialization
  // ============================================

  function init() {
    registerPane();
    bindKeyboardShortcut();
  }

  // ============================================
  // Public API (backwards compatible)
  // ============================================

  window.FiltersPane = {
    init,
    getState,
    getWidth,
    setState,
    setWidth,
    open,
    close,
    toggle,
    show,
    togglePinned,
    isPinned,
    isAutoHide,
    isClosed,
    // Constants for external use
    _constants: {
      STATE_CLOSED: 'closed',
      STATE_PINNED: 'pinned',
      STATE_AUTOHIDE: 'autohide',
      WIDTH_MIN: 280,
      WIDTH_MAX: 500,
      WIDTH_DEFAULT: 320
    }
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
