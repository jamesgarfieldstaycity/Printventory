const { contextBridge, ipcRenderer, shell } = require('electron');
const { version } = require('./package.json');

// Track registered channels to prevent duplicates in hidden window
const registeredChannels = new Set();

// Check if we're in server mode (hidden window) - cache the result
let isServerModeCached = null;
let isServerModeCheckPending = false;

async function checkIsServerMode() {
  if (isServerModeCached !== null) {
    return isServerModeCached;
  }
  if (isServerModeCheckPending) {
    // Wait for pending check
    while (isServerModeCheckPending) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return isServerModeCached;
  }
  isServerModeCheckPending = true;
  try {
    isServerModeCached = await ipcRenderer.invoke('is-server-mode');
  } catch (error) {
    console.error('[Preload] Error checking server mode:', error);
    isServerModeCached = false; // Default to false (normal mode)
  }
  isServerModeCheckPending = false;
  return isServerModeCached;
}

// Wrap ipcRenderer.on to prevent preview-model listeners ONLY in server mode hidden window
// Only block if we're CERTAIN we're in server mode (cached = true)
// If not cached yet, allow through (normal mode needs to work immediately)
const originalOn = ipcRenderer.on.bind(ipcRenderer);
const previewModelListenerCount = { count: 0 };
ipcRenderer.on = function(channel, ...args) {
  // Only block preview-model and download-model if we're CERTAIN we're in server mode
  // In normal mode or if not cached yet, allow these listeners to register normally
  if ((channel === 'preview-model' || channel === 'download-model' || channel === 'preview-bundle-models') && isServerModeCached === true) {
    previewModelListenerCount.count++;
    console.warn(`[Preload] BLOCKED ipcRenderer.on('${channel}') call #${previewModelListenerCount.count} in server mode hidden window - events go to WebSocket clients`);
    return ipcRenderer; // Return ipcRenderer to allow chaining
  }
  // If not cached yet, check asynchronously but don't block (normal mode needs to work immediately)
  // The receive() and on() methods will handle the blocking properly for their specific cases
  if ((channel === 'preview-model' || channel === 'download-model' || channel === 'preview-bundle-models') && isServerModeCached === null) {
    checkIsServerMode().then(isServer => {
      if (isServer) {
        console.warn(`[Preload] Note: '${channel}' listener registered via direct ipcRenderer.on() in server mode - consider using receive() method`);
      }
    });
  }
  return originalOn(channel, ...args);
};

contextBridge.exposeInMainWorld('electron', {
  isServerMode: () => ipcRenderer.invoke('is-server-mode'),
  // True only in the Electron hidden window while --server is active (not browser clients).
  isServerThumbnailWorker: () => checkIsServerMode(),
  startServerThumbnailJob: (options) => ipcRenderer.invoke('start-server-thumbnail-job', options || {}),
  cancelServerThumbnailJob: () => ipcRenderer.invoke('cancel-server-thumbnail-job'),
  reportServerThumbnailProgress: (progress) => ipcRenderer.invoke('report-server-thumbnail-progress', progress || {}),
  reportServerThumbnailComplete: (result) => ipcRenderer.invoke('report-server-thumbnail-complete', result || {}),
  reportServerThumbnailError: (errorInfo) => ipcRenderer.invoke('report-server-thumbnail-error', errorInfo || {}),
  getServerThumbnailJobStatus: () => ipcRenderer.invoke('get-server-thumbnail-job-status'),
  loadDirectory: () => ipcRenderer.invoke('load-directory'),
  openFileDialog: (defaultPath) => ipcRenderer.invoke('open-file-dialog', defaultPath),
  saveDirectory: (directoryPath) => ipcRenderer.invoke('save-directory', directoryPath),
  // Library folders management
  getLibraryFolders: () => ipcRenderer.invoke('get-library-folders'),
  addLibraryFolder: (path) => ipcRenderer.invoke('add-library-folder', path),
  updateLibraryFolder: (data) => ipcRenderer.invoke('update-library-folder', data),
  removeLibraryFolder: (id) => ipcRenderer.invoke('remove-library-folder', id),
  updateLibraryFolderScanTime: (id) => ipcRenderer.invoke('update-library-folder-scan-time', id),
  scanDirectory: (directoryPath, options) => ipcRenderer.invoke('scan-directory', directoryPath, options || {}),
  getModel: (filePath) => ipcRenderer.invoke('get-model', filePath),
  getModelsFiltered: (filters) => ipcRenderer.invoke('get-models-filtered', filters),
  getFolderTree: () => ipcRenderer.invoke('get-folder-tree'),
  saveModel: (modelData) => ipcRenderer.invoke('save-model', modelData),
  saveModelFromUpload: (payload) => ipcRenderer.invoke('save-model-from-upload', payload),
  saveModelBatch: (modelDataBatch) => ipcRenderer.invoke('save-model-batch', modelDataBatch),
  updateModelsBatch: (modelDataBatch) => ipcRenderer.invoke('update-models-batch', modelDataBatch),
  saveThumbnail: (filePath, thumbnail) => ipcRenderer.invoke('save-thumbnail', filePath, thumbnail),
  setThumbnailGenerationActive: (active) => ipcRenderer.invoke('set-thumbnail-generation-active', !!active),
  getDesigners: () => ipcRenderer.invoke('get-designers'),
  getLicenses: () => ipcRenderer.invoke('get-licenses'),
  setParentModelBatch: (filePaths, parentModel) => ipcRenderer.invoke('set-parent-model-batch', filePaths, parentModel),
  getModelsByDesigner: (designer) => ipcRenderer.invoke('get-models-by-designer', designer),
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
  openPath: (path) => ipcRenderer.invoke('open-path', path),
  executeClientCommand: (commandData) => ipcRenderer.invoke('execute-client-command', commandData),
  getAllModels: (sortOption, limit) => ipcRenderer.invoke('get-all-models', sortOption, limit),
  getTotalModelCount: () => ipcRenderer.invoke('getTotalModelCount'),
  getParentModels: () => ipcRenderer.invoke('get-parent-models'),
  getAllTags: () => ipcRenderer.invoke('get-all-tags'),
  saveTag: (tagName) => ipcRenderer.invoke('save-tag', tagName),
  renameTag: (tagId, newName) => ipcRenderer.invoke('rename-tag', tagId, newName),
  deleteTag: (tagId) => ipcRenderer.invoke('delete-tag', tagId),
  getTagModelCount: (tagId) => ipcRenderer.invoke('get-tag-model-count', tagId),
  onOpenTagManager: (callback) => ipcRenderer.on('open-tag-manager', callback),
  getAllFilaments: () => ipcRenderer.invoke('get-all-filaments'),
  saveFilament: (filament) => ipcRenderer.invoke('save-filament', filament),
  deleteFilament: (filamentId) => ipcRenderer.invoke('delete-filament', filamentId),
  getModelFilaments: (modelId) => ipcRenderer.invoke('get-model-filaments', modelId),
  getAllParts: () => ipcRenderer.invoke('get-all-parts'),
  savePart: (part) => ipcRenderer.invoke('save-part', part),
  deletePart: (partId) => ipcRenderer.invoke('delete-part', partId),
  getAllPrinters: () => ipcRenderer.invoke('get-all-printers'),
  savePrinter: (printer) => ipcRenderer.invoke('save-printer', printer),
  deletePrinter: (printerId) => ipcRenderer.invoke('delete-printer', printerId),
  getPrinterMaintenanceLogs: (printerId) => ipcRenderer.invoke('get-printer-maintenance-logs', printerId),
  savePrinterMaintenanceLog: (logEntry) => ipcRenderer.invoke('save-printer-maintenance-log', logEntry),
  deletePrinterMaintenanceLog: (logId) => ipcRenderer.invoke('delete-printer-maintenance-log', logId),
  getPrinterReminders: (printerId) => ipcRenderer.invoke('get-printer-reminders', printerId),
  savePrinterReminder: (reminder) => ipcRenderer.invoke('save-printer-reminder', reminder),
  deletePrinterReminder: (reminderId) => ipcRenderer.invoke('delete-printer-reminder', reminderId),
  completePrinterReminder: (payload) => ipcRenderer.invoke('complete-printer-reminder', payload),
  onOpenPrinterManagement: (callback) => ipcRenderer.on('open-printer-management', callback),
  getPrintEvents: (modelId) => ipcRenderer.invoke('get-print-events', modelId),
  logPrintEvent: (payload) => ipcRenderer.invoke('log-print-event', payload),
  logPrintEventsBatch: (payload) => ipcRenderer.invoke('log-print-events-batch', payload),
  deletePrintEvent: (eventId) => ipcRenderer.invoke('delete-print-event', eventId),
  setPrintStatus: (payload) => ipcRenderer.invoke('set-print-status', payload),
  setPrintStatusBatch: (payload) => ipcRenderer.invoke('set-print-status-batch', payload),
  testSpoolmanConnection: (url, token) => ipcRenderer.invoke('test-spoolman-connection', url, token),
  syncSpoolmanFilaments: (url, token) => ipcRenderer.invoke('sync-spoolman-filaments', url, token),
  onOpenFilamentManager: (callback) => ipcRenderer.on('open-filament-manager', callback),
  // Shopify integration
  getShopifySettings: () => ipcRenderer.invoke('get-shopify-settings'),
  saveShopifySettings: (settings) => ipcRenderer.invoke('save-shopify-settings', settings),
  testShopifyConnection: (storeDomain, clientId, clientSecret) => ipcRenderer.invoke('test-shopify-connection', storeDomain, clientId, clientSecret),
  // Shopify product types
  getShopifyProductTypes: () => ipcRenderer.invoke('get-shopify-product-types'),
  saveShopifyProductType: (productType) => ipcRenderer.invoke('save-shopify-product-type', productType),
  deleteShopifyProductType: (typeId) => ipcRenderer.invoke('delete-shopify-product-type', typeId),
  // Shopify collection codes
  getShopifyCollectionCodes: () => ipcRenderer.invoke('get-shopify-collection-codes'),
  suggestShopifyCollectionCode: (folderName) => ipcRenderer.invoke('suggest-shopify-collection-code', folderName),
  saveShopifyCollectionCode: (collectionCode) => ipcRenderer.invoke('save-shopify-collection-code', collectionCode),
  deleteShopifyCollectionCode: (codeId) => ipcRenderer.invoke('delete-shopify-collection-code', codeId),
  // Shopify products
  getShopifyProducts: (filters) => ipcRenderer.invoke('get-shopify-products', filters),
  getShopifyProduct: (productId) => ipcRenderer.invoke('get-shopify-product', productId),
  getShopifyProductByModel: (modelId) => ipcRenderer.invoke('get-shopify-product-by-model', modelId),
  saveShopifyProduct: (productData) => ipcRenderer.invoke('save-shopify-product', productData),
  deleteShopifyProduct: (productId) => ipcRenderer.invoke('delete-shopify-product', productId),
  // SKU generation
  getNextSeriesNumber: (collectionCode, typeCode) => ipcRenderer.invoke('get-next-series-number', collectionCode, typeCode),
  allocateSeriesNumber: (collectionCode, typeCode) => ipcRenderer.invoke('allocate-series-number', collectionCode, typeCode),
  generateProductCode: (productName) => ipcRenderer.invoke('generate-product-code', productName),
  // Photo handling
  getProductFolderImages: (folderPath) => ipcRenderer.invoke('get-product-folder-images', folderPath),
  readImageAsBase64: (imagePath) => ipcRenderer.invoke('read-image-as-base64', imagePath),
  browseForImages: (defaultPath) => ipcRenderer.invoke('browse-for-images', defaultPath),
  showPhotoContextMenu: (payload) => ipcRenderer.invoke('show-photo-context-menu', payload),
  // Shopify push
  pushToShopify: (productId) => ipcRenderer.invoke('push-to-shopify', productId),
  // Shopify live data (for linked products)
  fetchLiveShopifyData: (localProductId) => ipcRenderer.invoke('fetch-live-shopify-data', localProductId),
  updateLinkedShopifyProduct: (localProductId, updates) => ipcRenderer.invoke('update-linked-shopify-product', localProductId, updates),
  // Shopify media operations
  deleteShopifyProductMedia: (shopifyProductId, mediaIds) => ipcRenderer.invoke('delete-shopify-product-media', shopifyProductId, mediaIds),
  uploadShopifyProductImages: (shopifyProductId, images) => ipcRenderer.invoke('upload-shopify-product-images', shopifyProductId, images),
  reorderShopifyProductMedia: (shopifyProductId, moves) => ipcRenderer.invoke('reorder-shopify-product-media', shopifyProductId, moves),
  setShopifyInventory: (updates) => ipcRenderer.invoke('set-shopify-inventory', updates),
  // Shopify reconciliation (folder-based)
  fetchShopifyProducts: () => ipcRenderer.invoke('fetch-shopify-products'),
  debugShopifyDiagnostics: (args) => ipcRenderer.invoke('debug-shopify-diagnostics', args),
  // GR-PLAN-006: order sync
  syncShopifyOrders: (options) => ipcRenderer.invoke('sync-shopify-orders', options),
  getShopifyOrders: (options) => ipcRenderer.invoke('get-shopify-orders', options),
  linkOrderLineItem: (args) => ipcRenderer.invoke('link-order-line-item', args),
  getShopifyOrdersBadgeCount: () => ipcRenderer.invoke('get-shopify-orders-badge-count'),
  onShopifyOrdersSynced: (callback) => ipcRenderer.on('shopify-orders-synced', (event, summary) => callback(summary)),
  getLinkedShopifyProductIds: () => ipcRenderer.invoke('get-linked-shopify-product-ids'),
  getUnlinkedFolders: (includeSkipped) => ipcRenderer.invoke('get-unlinked-folders', includeSkipped),
  getUnlinkedProducts: () => ipcRenderer.invoke('get-unlinked-products'), // Legacy alias
  linkFolderToShopify: (folderPath, primaryModelId, shopifyProductGid) =>
    ipcRenderer.invoke('link-folder-to-shopify', folderPath, primaryModelId, shopifyProductGid),
  linkToShopifyProduct: (modelId, shopifyProductGid) =>
    ipcRenderer.invoke('link-to-shopify-product', modelId, shopifyProductGid), // Legacy
  // Model-level Shopify linking
  unlinkShopifyProduct: (modelId) => ipcRenderer.invoke('unlink-shopify-product', modelId),
  getLinkableShopifyProducts: () => ipcRenderer.invoke('get-linkable-shopify-products'),
  linkModelToShopifyProduct: (modelId, shopifyLocalProductId) =>
    ipcRenderer.invoke('link-model-to-shopify-product', modelId, shopifyLocalProductId),
  markFolderAsNew: (folderPath, primaryModelId) =>
    ipcRenderer.invoke('mark-folder-as-new', folderPath, primaryModelId),
  markAsNewProduct: (modelId) => ipcRenderer.invoke('mark-as-new-product', modelId), // Legacy
  skipFolderFile: (folderPath, modelId) =>
    ipcRenderer.invoke('skip-folder-file', folderPath, modelId),
  unskipFolderFile: (folderPath, modelId) =>
    ipcRenderer.invoke('unskip-folder-file', folderPath, modelId),
  getSkippedFiles: () => ipcRenderer.invoke('get-skipped-files'),
  getFolderFileVariants: (folderPath) => ipcRenderer.invoke('get-folder-file-variants', folderPath),
  assignFileVariant: (folderPath, modelId, variantId, optionValue) =>
    ipcRenderer.invoke('assign-file-variant', folderPath, modelId, variantId, optionValue),
  backfillVariantMappings: () => ipcRenderer.invoke('backfill-variant-mappings'),
  getProductVariantsWithSuggestions: (folderPath) => ipcRenderer.invoke('get-product-variants-with-suggestions', folderPath),
  setPrimaryFile: (folderPath, modelId) => ipcRenderer.invoke('set-primary-file', folderPath, modelId),
  getAllMetadata: () => ipcRenderer.invoke('get-all-metadata'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  renameMetadata: (type, oldName, newName) => ipcRenderer.invoke('rename-metadata', type, oldName, newName),
  deleteMetadata: (type, name) => ipcRenderer.invoke('delete-metadata', type, name),
  onOpenMetadataEditor: (callback) => ipcRenderer.on('open-metadata-editor', callback),
  getModelTags: (modelId) => ipcRenderer.invoke('get-model-tags', modelId),
  getGroupTags: (modelIds) => ipcRenderer.invoke('get-group-tags', modelIds),
  saveModelTags: (modelId, tagIds) => ipcRenderer.invoke('save-model-tags', modelId, tagIds),
  getAdditionalFileTypesCatalog: () => ipcRenderer.invoke('get-additional-file-types-catalog'),
  getModelCountByFileTypeIds: (catalogIds) => ipcRenderer.invoke('get-model-count-by-file-type-ids', catalogIds),
  removeModelsByFileTypeIds: (catalogIds) => ipcRenderer.invoke('remove-models-by-file-type-ids', catalogIds),
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  saveSetting: (key, value) => ipcRenderer.invoke('save-setting', key, value),
  getDefaultAIPrompt: () => ipcRenderer.invoke('get-default-ai-prompt'),
  startExtensionServer: (port) => ipcRenderer.invoke('start-extension-server', port),
  stopExtensionServer: () => ipcRenderer.invoke('stop-extension-server'),
  syncLocalHttpServer: (port) => ipcRenderer.invoke('sync-local-http-server', port),
  importExtensionInbox: () => ipcRenderer.invoke('import-extension-inbox'),
  getDefaultExtensionInboxDirectory: () => ipcRenderer.invoke('get-default-extension-inbox-directory'),
  getMcpConnectionInfo: () => ipcRenderer.invoke('get-mcp-connection-info'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkCollectUsage: () => ipcRenderer.invoke('check-collect-usage'),
  purgeThumbnails: () => ipcRenderer.invoke('purge-thumbnails'),
  onOpenSettings: (callback) => ipcRenderer.on('open-settings', callback),
  onOpenGuide: (callback) => ipcRenderer.on('open-guide', callback),
  trackEvent: (category, action, label, value) => ipcRenderer.invoke('track-event', category, action, label, value),
  onOpenAbout: (callback) => {
    ipcRenderer.on('open-about', async () => {
      await callback();
    });
  },
  onOpenKeyboardShortcuts: (callback) => ipcRenderer.on('open-keyboard-shortcuts', callback),
  onOpenServerModeInfo: (callback) => {
    ipcRenderer.on('open-server-mode-info', async () => {
      await callback();
    });
  },
  onOpenStats: (callback) => {
    ipcRenderer.on('open-stats', async () => {
      await callback();
    });
  },
  onOpenSystemReport: (callback) => {
    ipcRenderer.on('open-system-report', async () => {
      await callback();
    });
  },
  showMessage: (title, message, buttons) => ipcRenderer.invoke('show-message', title, message, buttons),
  showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),
  onOpenBackupRestore: (callback) => ipcRenderer.on('open-backup-restore', callback),
  backupDatabase: () => ipcRenderer.invoke('backup-database'),
  restoreDatabase: () => ipcRenderer.invoke('restore-database'),
  exportLibrary: () => ipcRenderer.invoke('export-library'),
  importLibrary: () => ipcRenderer.invoke('import-library'),
  getDuplicateFiles: () => ipcRenderer.invoke('get-duplicate-files'),
  onOpenDeDup: (callback) => ipcRenderer.on('open-dedup', callback),
  checkFilesExist: (filePaths) => ipcRenderer.invoke('check-files-exist', filePaths),
  deleteFile: (filePath) => {
    console.log('preload: deleteFile called with:', filePath);
    return ipcRenderer.invoke('delete-file', filePath);
  },
  fetchThangsPage: (url) => ipcRenderer.invoke('fetch-thangs-page', url),
  purgeModels: (options) => ipcRenderer.invoke('purge-models', options || {}),
  clearNewFlags: () => ipcRenderer.invoke('clear-new-model-flags'),
  onOpenPurgeModels: (callback) => ipcRenderer.on('open-purge-models', callback),
  onGenerateMissingThumbnails: (callback) => ipcRenderer.on('generate-missing-thumbnails', callback),
  onPingRequest: (callback) => ipcRenderer.on('ping', callback),
  showContextMenu: (filePath) => ipcRenderer.invoke('show-context-menu', filePath),
  executeContextMenuAction: (requestId, itemIndex, subIndex) => ipcRenderer.invoke('execute-context-menu-action', requestId, itemIndex, subIndex),
  onRefreshGrid: (callback) => ipcRenderer.on('refresh-grid', callback),
  onShowParentModelDialog: (callback) => ipcRenderer.on('show-parent-model-dialog', (event, data) => callback(data)),
  onThumbnailAdded: (callback) => ipcRenderer.on('thumbnail-added', (event, data) => callback(data)),
  onOpenThemeSettings: (callback) => ipcRenderer.on('open-theme-settings', callback),
  quitApp: () => ipcRenderer.invoke('quitApp'),
  onOpenPerformanceSettings: (callback) => ipcRenderer.on('open-performance-settings', callback),
  get3MFImages: (filePath, options) => {
    return ipcRenderer.invoke('get3MFImages', filePath, options);
  },
  getLYSImages: (filePath, options) => {
    return ipcRenderer.invoke('getLYSImages', filePath, options);
  },
  getF3DImages: (filePath, options) => {
    return ipcRenderer.invoke('getF3DImages', filePath, options);
  },
  getChituboxImages: (filePath, options) => {
    return ipcRenderer.invoke('getChituboxImages', filePath, options);
  },
  getVoxlImages: (filePath, options) => {
    return ipcRenderer.invoke('getVoxlImages', filePath, options);
  },
  get3MFSTL: (filePath) => {
    console.log('preload: get3MFSTL called with:', filePath);
    return ipcRenderer.invoke('get3MFSTL', filePath);
  },
  extractModelFromZip: (filePath) => ipcRenderer.invoke('extract-model-from-zip', filePath),
  extractZipArchive: (filePath, destinationPath) => ipcRenderer.invoke('extract-zip-archive', filePath, destinationPath),
  deleteTempFile: (filePath) => ipcRenderer.invoke('delete-temp-file', filePath),
  onScanProgress: (callback) => {
    // Avoid stacking duplicate listeners on each scan (would freeze UI / stale progress text)
    ipcRenderer.removeAllListeners('scan-progress');
    ipcRenderer.on('scan-progress', (_, progress) => callback(progress));
  },
  onDbProgress: (callback) => {
    ipcRenderer.removeAllListeners('db-progress');
    ipcRenderer.on('db-progress', (_, progress) => callback(progress));
  },
  onDbCleanup: (callback) => {
    ipcRenderer.on('db-cleanup', callback);
  },
  getDuplicates: (includeZipOrOptions = false) => ipcRenderer.invoke('get-duplicates', includeZipOrOptions),
  isGeneratingHashes: () => ipcRenderer.invoke('is-generating-hashes'),
  getModelsWithoutHash: (filters) => ipcRenderer.invoke('getModelsWithoutHash', filters),
  generateMissingHashes: (filters) => ipcRenderer.invoke('generateMissingHashes', filters),
  calculateFileHash: (filePath) => ipcRenderer.invoke('calculate-file-hash', filePath),
  onHashGenerationProgress: (callback) => {
    ipcRenderer.on('hash-generation-progress', (_, progress) => callback(progress));
  },
  onHashGenerationComplete: (callback) => {
    ipcRenderer.on('hash-generation-complete', (_, result) => callback(result || {}));
  },
  getThumbnail: (filePath) => ipcRenderer.invoke('getThumbnail', filePath),
  getAllThumbnails: (filePath) => ipcRenderer.invoke('get-all-thumbnails', filePath),
  addThumbnail: (filePath, imageDataUrl) => ipcRenderer.invoke('add-thumbnail', filePath, imageDataUrl),
  addMultipleThumbnails: (filePath, imageDataUrls) => ipcRenderer.invoke('add-multiple-thumbnails', filePath, imageDataUrls),
  setDefaultThumbnail: (filePath, index) => ipcRenderer.invoke('set-default-thumbnail', filePath, index),
  deleteThumbnail: (filePath, index) => ipcRenderer.invoke('delete-thumbnail', filePath, index),
  onStartPrintRoulette: (callback) => {
    ipcRenderer.on('start-print-roulette', callback);
  },
  checkForUpdates: (isBeta) => ipcRenderer.invoke('check-for-updates', isBeta),
  openUpdatePage: (isBeta) => ipcRenderer.invoke('open-update-page', isBeta),
  onOpenSTLHome: (callback) => ipcRenderer.on('open-stl-home', callback),
  send: (channel, ...args) => {
    // Optionally add a whitelist of channels if needed for security
    const validChannels = [
      'pong',
      'native-prompt-response',
      'puter-ai-chat-response'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, ...args);
    } else {
      ipcRenderer.send(channel, ...args);
    }
  },
  on: (channel, callback) => {
    // Prevent preview-model and download-model registration ONLY in server mode hidden window
    // In normal mode, allow these to work normally
    if (channel === 'preview-model' || channel === 'download-model' || channel === 'preview-bundle-models') {
      // Check server mode - if true, block; if false/null, allow (normal mode)
      if (isServerModeCached === true) {
        console.warn(`[Preload] Blocking '${channel}' listener registration in server mode hidden window - use receive() method or events go to WebSocket clients`);
        return;
      }
      // If not cached yet, check asynchronously but don't block (normal mode needs to work)
      if (isServerModeCached === null) {
        checkIsServerMode();
      }
    }
    
    const validChannels = [
      'ping',
      'open-about',
      'open-ai-config',
      'open-file-type-settings',
      'open-browser-extension-settings',
      'open-mcp-server-settings',
      'open-https-settings',
      'open-settings',
      'open-guide',
      'open-keyboard-shortcuts',
      'open-server-mode-info',
      'open-stats',
      'open-system-report',
      'open-backup-restore',
      'open-dedup',
      'open-tag-manager',
      'open-filament-manager',
      'open-printer-management',
      'open-parts-stock',
      'open-purge-models',
      'open-shopify-settings',
      'open-metadata-editor',
      'open-theme-settings',
      'open-performance-settings',
      'open-slicer-settings',
      'open-manage-thumbnails',
      'tags-generated',
      'show-progress-dialog',
      'update-progress',
      'close-progress-dialog',
      'start-single-tag-generation',
      'start-batch-tag-generation',
      'batch-tag-generation-complete',
      'hash-generation-progress',
      'hash-generation-complete',
      'show-input-dialog',
      'puter-ai-chat-request',
      'clear-new-flags',
      'regenerate-thumbnails',
      'generate-missing-thumbnails',
      'run-server-thumbnail-job',
      'cancel-server-thumbnail-job',
      'thumbnail-job-progress',
      'thumbnail-job-complete',
      'thumbnail-job-error',
      'thumbnail-deleted',
      'thumbnail-default-changed',
      'manage-thumbnails-request',
      'execute-client-command',
      'download-model',
      'start-print-roulette',
      'toggle-filters-pane',
      'toggle-sidebar',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  invoke: (channel, data) => {
    const validChannels = [
      'show-input-dialog',
      // ... other valid channels ...
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
    return ipcRenderer.invoke(channel, data);
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openSlicerDialog: (title) => ipcRenderer.invoke('open-slicer-dialog', title),
  testAIConfig: (apiKey, baseURL, model, service) => ipcRenderer.invoke('test-ai-config', apiKey, baseURL, model, service),
  generateTags: (filePath) => ipcRenderer.invoke('generate-tags', filePath),
  puterAIChat: (prompt, imageUrl, model) => ipcRenderer.invoke('puter-ai-chat', prompt, imageUrl, model),
  getModelsWithoutThumbnails: () => ipcRenderer.invoke('get-models-without-thumbnails'),
  getModelsWithDefaultThumbnails: () => ipcRenderer.invoke('get-models-with-default-thumbnails'),
  pong: () => ipcRenderer.send('pong'),
  fetchMakerWorldPage: (url) => ipcRenderer.invoke('fetch-makerworld-page', url),
  onOpenSlicerSettings: (callback) => ipcRenderer.on('open-slicer-settings', callback),
  getSlicers: () => ipcRenderer.invoke('get-slicers'),
  detectSlicers: () => ipcRenderer.invoke('detect-slicers'),
  openFileInSlicer: (options) => ipcRenderer.invoke('open-file-in-slicer', options),
  saveSlicer: (slicer) => ipcRenderer.invoke('save-slicer', slicer),
  deleteSlicer: (id) => ipcRenderer.invoke('delete-slicer', id),
  clearAndSaveSlicers: (slicers) => ipcRenderer.invoke('clear-and-save-slicers', slicers),
  getAppVersion: () => version,
  getFileStats: (filePath) => ipcRenderer.invoke('get-file-stats', filePath),
  startTransaction: () => ipcRenderer.invoke('database:start-transaction'),
  commitTransaction: () => ipcRenderer.invoke('database:commit-transaction'),
  rollbackTransaction: () => ipcRenderer.invoke('database:rollback-transaction'),
  getAllModelReferences: () => ipcRenderer.invoke('get-all-model-references'),
  showInputDialog: (options) => ipcRenderer.invoke('show-input-dialog', options),
  pull3MFMetadata: (filePaths) => ipcRenderer.invoke('pull-3mf-metadata', filePaths),
  readModelFile: (filePath) => ipcRenderer.invoke('read-model-file', filePath),
  parse3MFPreview: (filePath, requestId) => ipcRenderer.invoke('parse-3mf-preview', filePath, requestId),
  cancel3MFPreview: (requestId) => ipcRenderer.invoke('cancel-3mf-preview', requestId),
  on3MFPreviewStatus: (callback) => ipcRenderer.on('3mf-preview-status', (event, requestId, message) => callback(requestId, message)),
  getGpuInfo: () => ipcRenderer.invoke('get-gpu-info'),
  benchmarkFilesystem: () => ipcRenderer.invoke('benchmark-filesystem'),
  benchmarkDatabase: () => ipcRenderer.invoke('benchmark-database'),
  receive: (channel, callback) => {
    const validChannels = ['preview-model', 'preview-bundle-models', 'download-model'];
    if (validChannels.includes(channel)) {
      // Prevent duplicate registrations regardless of mode - check FIRST
      if (registeredChannels.has(channel)) {
        console.warn(`[Preload] Duplicate receive() call for '${channel}' - ignoring (already registered)`);
        return;
      }
      
      // Mark as handled immediately to prevent race conditions
      registeredChannels.add(channel);
      
      // Check if we're in server mode (hidden window) - only block in server mode
      // Use async check but handle it properly
      checkIsServerMode().then(isServer => {
        if (isServer) {
          // This is the hidden window in server mode - don't register IPC listeners
          // Events go to browser clients via WebSocket, not to the hidden window
          const location = typeof window !== 'undefined' ? window.location : null;
          console.warn(`[Preload] Skipping IPC listener for '${channel}' in server mode hidden window (protocol: ${location?.protocol}, hostname: ${location?.hostname}) - events go to WebSocket clients`);
          return;
        }
        
        // Normal mode: register the listener
        const location = typeof window !== 'undefined' ? window.location : null;
        console.log(`[Preload] Registering IPC listener for '${channel}' in normal mode (protocol: ${location?.protocol}, hostname: ${location?.hostname})`);
        ipcRenderer.on(channel, (event, ...args) => callback(...args));
      }).catch(error => {
        // If check fails, assume normal mode and register (fail open for normal mode)
        console.warn(`[Preload] Error checking server mode, assuming normal mode:`, error);
        ipcRenderer.on(channel, (event, ...args) => callback(...args));
      });
    }
  }
});

contextBridge.exposeInMainWorld('electronAPI', {
  getDb: () => ipcRenderer.invoke('get-db'),
  // ... other exposed functions
});

