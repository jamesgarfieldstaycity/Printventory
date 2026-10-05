#!/usr/bin/env node
'use strict';

/**
 * Unit tests for Shopify variant mapping feature.
 * Tests the file-to-variant matching logic and schema changes.
 *
 * Run with: node variant-mapping.test.js
 */

const assert = require('assert');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

// ============================================
// Test: matchModelToVariant logic
// ============================================

/**
 * Extracted from main.js - the matchModelToVariant function
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

  // Strategy 2: Filename contains optionValue (longest match first)
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

  // Strategy 4: SKU suffix match
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

// Sample variants like the Christmas Ghost Collection
const christmasGhostVariants = [
  { id: 'gid://shopify/ProductVariant/1', optionValue: 'Carol Singer', sku: 'GR-XMS-FIG-GHOST-003-01' },
  { id: 'gid://shopify/ProductVariant/2', optionValue: 'Christmas Tree', sku: 'GR-XMS-FIG-GHOST-003-02' },
  { id: 'gid://shopify/ProductVariant/3', optionValue: 'Cocoa', sku: 'GR-XMS-FIG-GHOST-003-03' },
  { id: 'gid://shopify/ProductVariant/4', optionValue: 'Cookie', sku: 'GR-XMS-FIG-GHOST-003-04' },
  { id: 'gid://shopify/ProductVariant/5', optionValue: 'Gingerbread', sku: 'GR-XMS-FIG-GHOST-003-05' },
  { id: 'gid://shopify/ProductVariant/6', optionValue: 'Santa', sku: 'GR-XMS-FIG-GHOST-003-06' },
];

test('matchModelToVariant: exact match - CookieGhost.3mf matches Cookie', () => {
  const result = matchModelToVariant('CookieGhost.3mf', christmasGhostVariants);
  // "cookieghost" contains "cookie", should match
  assert.ok(result, 'Should find a match');
  assert.strictEqual(result.optionValue, 'Cookie');
});

test('matchModelToVariant: exact match - Carol Singer Ghost.3mf matches Carol Singer', () => {
  const result = matchModelToVariant('Carol Singer Ghost.3mf', christmasGhostVariants);
  assert.ok(result, 'Should find a match');
  assert.strictEqual(result.optionValue, 'Carol Singer');
});

test('matchModelToVariant: contains match - ChristmasTreeGhost.3mf matches Christmas Tree', () => {
  const result = matchModelToVariant('ChristmasTreeGhost.3mf', christmasGhostVariants);
  assert.ok(result, 'Should find a match');
  assert.strictEqual(result.optionValue, 'Christmas Tree');
});

test('matchModelToVariant: contains match - CocoaGhost.3mf matches Cocoa', () => {
  const result = matchModelToVariant('CocoaGhost.3mf', christmasGhostVariants);
  assert.ok(result, 'Should find a match');
  assert.strictEqual(result.optionValue, 'Cocoa');
});

test('matchModelToVariant: SKU suffix match - ghost-04.3mf matches Cookie (SKU ends -04)', () => {
  const result = matchModelToVariant('ghost-04.3mf', christmasGhostVariants);
  assert.ok(result, 'Should find a match via SKU suffix');
  assert.strictEqual(result.optionValue, 'Cookie');
});

test('matchModelToVariant: no match - RandomFile.3mf returns null', () => {
  const result = matchModelToVariant('RandomFile.3mf', christmasGhostVariants);
  assert.strictEqual(result, null);
});

test('matchModelToVariant: null/empty inputs handled', () => {
  assert.strictEqual(matchModelToVariant(null, christmasGhostVariants), null);
  assert.strictEqual(matchModelToVariant('file.3mf', null), null);
  assert.strictEqual(matchModelToVariant('file.3mf', []), null);
});

test('matchModelToVariant: case insensitive - COOKIE.3mf matches Cookie', () => {
  const result = matchModelToVariant('COOKIE.3mf', christmasGhostVariants);
  assert.ok(result, 'Should find a match (case insensitive)');
  assert.strictEqual(result.optionValue, 'Cookie');
});

test('matchModelToVariant: underscore/dash normalized - Cookie_Ghost.3mf matches Cookie', () => {
  const result = matchModelToVariant('Cookie_Ghost.3mf', christmasGhostVariants);
  assert.ok(result, 'Should find a match with underscore');
  assert.strictEqual(result.optionValue, 'Cookie');
});

// ============================================
// Test: Schema verification
// ============================================

const fs = require('fs');
const path = require('path');

test('schema: shopify_product_files has variant columns in migration', () => {
  const mainPath = path.join(__dirname, 'main.js');
  const content = fs.readFileSync(mainPath, 'utf8');

  // Check that migration adds the new columns
  assert.ok(
    content.includes("ALTER TABLE shopify_product_files ADD COLUMN shopify_variant_id TEXT"),
    'Migration should add shopify_variant_id column'
  );
  assert.ok(
    content.includes("ALTER TABLE shopify_product_files ADD COLUMN variant_option_value TEXT"),
    'Migration should add variant_option_value column'
  );
});

test('schema: SHOPIFY_VARIANT_INFO query exists', () => {
  const mainPath = path.join(__dirname, 'main.js');
  const content = fs.readFileSync(mainPath, 'utf8');

  assert.ok(
    content.includes('SHOPIFY_VARIANT_INFO'),
    'SHOPIFY_VARIANT_INFO constant should exist'
  );
  assert.ok(
    content.includes('shopifyVariantLabel'),
    'Query should include shopifyVariantLabel'
  );
  assert.ok(
    content.includes('shopifyProductTitle'),
    'Query should include shopifyProductTitle'
  );
});

test('IPC handlers: variant assignment handlers registered', () => {
  const mainPath = path.join(__dirname, 'main.js');
  const content = fs.readFileSync(mainPath, 'utf8');

  assert.ok(
    content.includes("'get-folder-file-variants'"),
    'get-folder-file-variants handler should be registered'
  );
  assert.ok(
    content.includes("'assign-file-variant'"),
    'assign-file-variant handler should be registered'
  );
  assert.ok(
    content.includes("'backfill-variant-mappings'"),
    'backfill-variant-mappings handler should be registered'
  );
});

test('preload: variant methods exposed', () => {
  const preloadPath = path.join(__dirname, 'preload.js');
  const content = fs.readFileSync(preloadPath, 'utf8');

  assert.ok(
    content.includes('getFolderFileVariants'),
    'getFolderFileVariants should be exposed'
  );
  assert.ok(
    content.includes('assignFileVariant'),
    'assignFileVariant should be exposed'
  );
  assert.ok(
    content.includes('backfillVariantMappings'),
    'backfillVariantMappings should be exposed'
  );
});

test('renderer: variant badge shows variant info', () => {
  const rendererPath = path.join(__dirname, 'renderer.js');
  const content = fs.readFileSync(rendererPath, 'utf8');

  assert.ok(
    content.includes('model.shopifyVariantLabel'),
    'Badge should check shopifyVariantLabel'
  );
  assert.ok(
    content.includes('shopify-unassigned'),
    'Badge should have unassigned class'
  );
});

test('renderer: unassigned badge only shown for multi-file products', () => {
  const rendererPath = path.join(__dirname, 'renderer.js');
  const content = fs.readFileSync(rendererPath, 'utf8');

  // The condition for showing "Unassigned" must include shopifyIsMultiFile check
  assert.ok(
    content.includes('model.shopifyIsMultiFile'),
    'Badge should check shopifyIsMultiFile before showing Unassigned'
  );
  // Verify the pattern: only show Unassigned when BOTH conditions are true
  assert.ok(
    content.includes('shopifyProductTitle && model.shopifyIsMultiFile'),
    'Unassigned badge should require both shopifyProductTitle AND shopifyIsMultiFile'
  );
});

test('schema: shopifyIsMultiFile column in query', () => {
  const mainPath = path.join(__dirname, 'main.js');
  const content = fs.readFileSync(mainPath, 'utf8');

  assert.ok(
    content.includes('shopifyIsMultiFile'),
    'Query should include shopifyIsMultiFile column'
  );
  // Query now counts actual model files in folder (not shopify_product_files rows)
  assert.ok(
    content.includes("COUNT(*) FROM models m2") && content.includes("> 1 THEN 1 ELSE 0 END"),
    'Query should count model files and check for more than 1'
  );
});

test('renderer: populateVariantAssignments function exists', () => {
  const rendererPath = path.join(__dirname, 'renderer.js');
  const content = fs.readFileSync(rendererPath, 'utf8');

  assert.ok(
    content.includes('async function populateVariantAssignments'),
    'populateVariantAssignments function should exist'
  );
});

test('styles: variant assignment CSS exists', () => {
  const stylesPath = path.join(__dirname, 'styles.css');
  const content = fs.readFileSync(stylesPath, 'utf8');

  assert.ok(
    content.includes('.shopify-variant-section'),
    'Variant section CSS should exist'
  );
  assert.ok(
    content.includes('.shopify-variant-item'),
    'Variant item CSS should exist'
  );
  assert.ok(
    content.includes('.shopify-unassigned'),
    'Unassigned variant badge CSS should exist'
  );
});

test('HTML: variant assignment section exists', () => {
  const htmlPath = path.join(__dirname, 'index.html');
  const content = fs.readFileSync(htmlPath, 'utf8');

  assert.ok(
    content.includes('shopify-variant-assignments-section'),
    'Variant assignments section should exist in HTML'
  );
  assert.ok(
    content.includes('shopify-variant-list'),
    'Variant list container should exist in HTML'
  );
});

test('renderer: syncModelShopifyBadge function exists', () => {
  const rendererPath = path.join(__dirname, 'renderer.js');
  const content = fs.readFileSync(rendererPath, 'utf8');

  assert.ok(
    content.includes('function syncModelShopifyBadge'),
    'syncModelShopifyBadge function should exist'
  );
  assert.ok(
    content.includes('syncModelShopifyBadge(existingElement, model)'),
    'syncModelShopifyBadge should be called from updateModelElement'
  );
});

test('renderer: editor close handler refreshes badge', () => {
  const rendererPath = path.join(__dirname, 'renderer.js');
  const content = fs.readFileSync(rendererPath, 'utf8');

  assert.ok(
    content.includes("dialog.addEventListener('close', closeHandler)"),
    'Editor should have close event listener'
  );
  assert.ok(
    content.includes('updateModelElement') && content.includes('closeHandler'),
    'Close handler should call updateModelElement'
  );
});

// ============================================
// Test: New variant-first UI features
// ============================================

test('IPC handlers: get-product-variants-with-suggestions registered', () => {
  const mainPath = path.join(__dirname, 'main.js');
  const content = fs.readFileSync(mainPath, 'utf8');

  assert.ok(
    content.includes("'get-product-variants-with-suggestions'"),
    'get-product-variants-with-suggestions handler should be registered'
  );
  assert.ok(
    content.includes('getProductVariantsWithSuggestionsHandler'),
    'Handler function should exist'
  );
});

test('IPC handlers: set-primary-file registered', () => {
  const mainPath = path.join(__dirname, 'main.js');
  const content = fs.readFileSync(mainPath, 'utf8');

  assert.ok(
    content.includes("'set-primary-file'"),
    'set-primary-file handler should be registered'
  );
  assert.ok(
    content.includes('setPrimaryFileHandler'),
    'Handler function should exist'
  );
});

test('preload: new variant methods exposed', () => {
  const preloadPath = path.join(__dirname, 'preload.js');
  const content = fs.readFileSync(preloadPath, 'utf8');

  assert.ok(
    content.includes('getProductVariantsWithSuggestions'),
    'getProductVariantsWithSuggestions should be exposed'
  );
  assert.ok(
    content.includes('setPrimaryFile'),
    'setPrimaryFile should be exposed'
  );
});

test('renderer: variant-first UI functions exist', () => {
  const rendererPath = path.join(__dirname, 'renderer.js');
  const content = fs.readFileSync(rendererPath, 'utf8');

  assert.ok(
    content.includes('attachVariantAssignmentHandlers'),
    'attachVariantAssignmentHandlers should exist'
  );
  assert.ok(
    content.includes('showFilePickerForVariant'),
    'showFilePickerForVariant should exist'
  );
});

test('renderer: split button initialization', () => {
  const rendererPath = path.join(__dirname, 'renderer.js');
  const content = fs.readFileSync(rendererPath, 'utf8');

  assert.ok(
    content.includes('initOpenModelSplitButton'),
    'initOpenModelSplitButton should exist'
  );
  assert.ok(
    content.includes('shopify-open-model-dropdown'),
    'Split button dropdown should be referenced'
  );
});

test('HTML: primary file control exists', () => {
  const htmlPath = path.join(__dirname, 'index.html');
  const content = fs.readFileSync(htmlPath, 'utf8');

  assert.ok(
    content.includes('shopify-primary-file-select'),
    'Primary file select should exist'
  );
  assert.ok(
    content.includes('Default file for listing'),
    'Primary file label should exist'
  );
});

test('HTML: split button structure exists', () => {
  const htmlPath = path.join(__dirname, 'index.html');
  const content = fs.readFileSync(htmlPath, 'utf8');

  assert.ok(
    content.includes('split-button-container'),
    'Split button container should exist'
  );
  assert.ok(
    content.includes('shopify-open-model-dropdown'),
    'Split button dropdown should exist'
  );
});

test('styles: variant-first CSS exists', () => {
  const stylesPath = path.join(__dirname, 'styles.css');
  const content = fs.readFileSync(stylesPath, 'utf8');

  assert.ok(
    content.includes('.variant-info'),
    'Variant info CSS should exist'
  );
  assert.ok(
    content.includes('.variant-file-assignment'),
    'Variant file assignment CSS should exist'
  );
  assert.ok(
    content.includes('.variant-file-picker-overlay'),
    'File picker modal CSS should exist'
  );
  assert.ok(
    content.includes('.split-button-container'),
    'Split button CSS should exist'
  );
});

// ============================================
// Test: calculateMatchScoreSimple algorithm
// ============================================

/**
 * Extracted from main.js - the calculateMatchScoreSimple function
 */
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

  return 0;
}

test('calculateMatchScoreSimple: exact spaceless match', () => {
  const score = calculateMatchScoreSimple('BlackCatGhost.3mf', 'Black Cat Ghost');
  assert.strictEqual(score, 1, 'Spaceless exact match should return 1');
});

test('calculateMatchScoreSimple: spaceless contains - filename contains option', () => {
  // "blackcatghost" contains "blackcat"
  const score = calculateMatchScoreSimple('BlackCatGhost.3mf', 'Black Cat');
  assert.ok(score >= 0.85, `Spaceless contains should score >= 0.85, got ${score}`);
});

test('calculateMatchScoreSimple: multi-word match', () => {
  // "halloweencatghost" contains "cat" and "ghost"
  const score = calculateMatchScoreSimple('HalloweenCatGhost.3mf', 'Purrfect Boo - Black Cat Ghost');
  // "cat" and "ghost" should both match in "halloweencatghost"
  assert.ok(score >= 0.7, `Multi-word match should score >= 0.7, got ${score}`);
});

test('calculateMatchScoreSimple: single word match returns weak score', () => {
  // "victorianghostv2" only contains "ghost"
  const score = calculateMatchScoreSimple('VictorianGhostV2.3mf', 'Purrfect Boo - Black Cat Ghost');
  // Only "ghost" matches - should be weak
  assert.ok(score <= 0.5, `Single word match should score <= 0.5, got ${score}`);
});

test('calculateMatchScoreSimple: no match returns 0', () => {
  const score = calculateMatchScoreSimple('RandomFile.3mf', 'Completely Different Name');
  assert.strictEqual(score, 0, 'No match should return 0');
});

console.log('\nAll variant-mapping tests completed.');
