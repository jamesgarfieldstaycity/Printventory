/**
 * Toolbar synchronization: keeps toolbar view buttons and other controls
 * in sync with their grid equivalents.
 * Note: Search and quick filters are now in the Filters Pane, not the toolbar.
 */
(function () {
  'use strict';

  // ============================================
  // View button synchronization
  // ============================================

  function setupViewButtonSync() {
    const toolbarButtons = document.querySelectorAll('.toolbar-view-buttons .view-button');

    // Find a function to handle view switching - look for existing handlers
    // The original view buttons dispatch click events that are handled elsewhere

    toolbarButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (!view) return;

        // Find and click the corresponding original button if it exists
        // (The original buttons may have been removed, so we handle it directly)

        // Update active state on toolbar buttons
        toolbarButtons.forEach(b => b.classList.toggle('active', b === btn));

        // Dispatch a custom event for the view switch
        document.dispatchEvent(new CustomEvent('view-mode-change', {
          detail: { view },
          bubbles: true
        }));

        // Also trigger the original view button click if it exists
        const originalBtn = document.querySelector(`.grid-view-selector .view-button[data-view="${view}"]`);
        if (originalBtn && originalBtn !== btn) {
          originalBtn.click();
        } else {
          // If no original button, we need to handle the view switch directly
          // This matches the existing view button behavior in renderer.js
          if (typeof window.setViewMode === 'function') {
            window.setViewMode(view);
          }
        }
      });
    });

    // Listen for view changes from other sources to keep toolbar in sync
    document.addEventListener('view-mode-changed', (e) => {
      const view = e.detail?.view;
      if (view) {
        toolbarButtons.forEach(btn => {
          btn.classList.toggle('active', btn.dataset.view === view);
        });
      }
    });
  }

  // ============================================
  // Preview size switcher synchronization
  // ============================================

  function setupPreviewSizeSync() {
    const toolbarSwitcher = document.getElementById('toolbar-preview-size-switcher');
    const originalSwitcher = document.getElementById('preview-size-switcher');

    if (!toolbarSwitcher) return;

    // Sync visibility
    const syncVisibility = () => {
      if (originalSwitcher) {
        toolbarSwitcher.hidden = originalSwitcher.hidden;
      }
    };

    // Observe visibility changes on original
    if (originalSwitcher) {
      const observer = new MutationObserver(syncVisibility);
      observer.observe(originalSwitcher, { attributes: true, attributeFilter: ['hidden'] });
      syncVisibility();
    }

    // Handle clicks on toolbar size buttons
    toolbarSwitcher.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const size = btn.dataset.previewSize;
        if (!size) return;

        // Click the corresponding original button
        const originalBtn = originalSwitcher?.querySelector(`button[data-preview-size="${size}"]`);
        if (originalBtn) {
          originalBtn.click();
        }

        // Update active state
        toolbarSwitcher.querySelectorAll('button').forEach(b => {
          b.classList.toggle('active', b.dataset.previewSize === size);
        });
      });
    });

    // Sync active state from original
    if (originalSwitcher) {
      const syncActive = () => {
        const activeOriginal = originalSwitcher.querySelector('button.active');
        if (activeOriginal) {
          const size = activeOriginal.dataset.previewSize;
          toolbarSwitcher.querySelectorAll('button').forEach(b => {
            b.classList.toggle('active', b.dataset.previewSize === size);
          });
        }
      };

      const observer = new MutationObserver(syncActive);
      originalSwitcher.querySelectorAll('button').forEach(btn => {
        observer.observe(btn, { attributes: true, attributeFilter: ['class'] });
      });
      syncActive();
    }
  }

  // ============================================
  // Folders toggle synchronization
  // ============================================

  function setupFoldersToggleSync() {
    const toolbarFoldersToggle = document.getElementById('toolbar-folders-toggle');
    const originalFoldersToggle = document.getElementById('folder-rail-toggle');

    if (!toolbarFoldersToggle) return;

    toolbarFoldersToggle.addEventListener('click', () => {
      // Click the original toggle
      if (originalFoldersToggle) {
        originalFoldersToggle.click();
      }
    });

    // Sync active state
    if (originalFoldersToggle) {
      const syncActive = () => {
        toolbarFoldersToggle.classList.toggle('active', originalFoldersToggle.classList.contains('active'));
      };

      const observer = new MutationObserver(syncActive);
      observer.observe(originalFoldersToggle, { attributes: true, attributeFilter: ['class'] });
      syncActive();
    }
  }

  // ============================================
  // List columns button synchronization
  // ============================================

  function setupListColumnsSync() {
    const toolbarColumnsBtn = document.getElementById('toolbar-list-columns-btn');
    const originalColumnsBtn = document.getElementById('list-view-columns-toolbar-btn');

    if (!toolbarColumnsBtn) return;

    // Sync visibility
    const syncVisibility = () => {
      if (originalColumnsBtn) {
        toolbarColumnsBtn.hidden = originalColumnsBtn.hidden;
      }
    };

    if (originalColumnsBtn) {
      const observer = new MutationObserver(syncVisibility);
      observer.observe(originalColumnsBtn, { attributes: true, attributeFilter: ['hidden'] });
      syncVisibility();
    }

    toolbarColumnsBtn.addEventListener('click', () => {
      if (originalColumnsBtn) {
        originalColumnsBtn.click();
      }
    });
  }

  // ============================================
  // Initialize all synchronization
  // ============================================

  function init() {
    // Note: Search and quick filters are now in the Filters Pane, not the toolbar
    setupViewButtonSync();
    setupPreviewSizeSync();
    setupFoldersToggleSync();
    setupListColumnsSync();
  }

  // Export for external use
  window.ToolbarSync = { init };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
