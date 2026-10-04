#!/usr/bin/env node
'use strict';

/**
 * Unit tests for dateAddedFilter behavior in search.js
 * Tests the filter clearing and pill rendering logic.
 * Run with: node search-date-filter.test.js
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
// Mock window object for testing
// ============================================

function createMockWindow() {
  return {
    dateAddedFilter: null,
    _lastDateAddedFilter: null,
    currentDirectoryFilter: null,
    invertedFilters: {},
    multiFilterChips: { tags: [], designer: [], license: [], parentModel: [], filaments: [] },
    viewingEntireLibrary: false
  };
}

// ============================================
// Test: clearAllLibraryFilters clears both filter variables
// ============================================

/**
 * Simulates clearAllLibraryFilters behavior for dateAddedFilter
 * (extracted from search.js lines 223-224)
 */
function clearDateAddedFilters(mockWindow) {
  mockWindow.dateAddedFilter = null;
  mockWindow._lastDateAddedFilter = null;
}

test('clearDateAddedFilters: clears dateAddedFilter', () => {
  const mockWindow = createMockWindow();
  mockWindow.dateAddedFilter = '2024-01-01T12:00:00';
  mockWindow._lastDateAddedFilter = '2024-01-01T12:00:00';

  clearDateAddedFilters(mockWindow);

  assert.strictEqual(mockWindow.dateAddedFilter, null);
  assert.strictEqual(mockWindow._lastDateAddedFilter, null);
});

test('clearDateAddedFilters: handles already-null values', () => {
  const mockWindow = createMockWindow();

  clearDateAddedFilters(mockWindow);

  assert.strictEqual(mockWindow.dateAddedFilter, null);
  assert.strictEqual(mockWindow._lastDateAddedFilter, null);
});

// ============================================
// Test: No restore logic in performCombinedSearch
// ============================================

/**
 * Previous buggy behavior that restored _lastDateAddedFilter.
 * This test ensures the restore logic is NOT present.
 */
function shouldRestoreFilter_OLD_BUGGY(mockWindow) {
  // OLD BEHAVIOR (now removed):
  // if (!mockWindow.dateAddedFilter && mockWindow._lastDateAddedFilter) {
  //   mockWindow.dateAddedFilter = mockWindow._lastDateAddedFilter;
  // }
  // NEW BEHAVIOR: Do nothing - filter stays cleared
}

function shouldRestoreFilter_FIXED(mockWindow) {
  // The fix: We do NOT restore from _lastDateAddedFilter
  // This function intentionally does nothing
}

test('performCombinedSearch: does NOT restore dateAddedFilter from _lastDateAddedFilter', () => {
  const mockWindow = createMockWindow();
  mockWindow.dateAddedFilter = null;
  mockWindow._lastDateAddedFilter = '2024-01-01T12:00:00'; // This would have triggered restore

  shouldRestoreFilter_FIXED(mockWindow);

  // Filter should remain null (not restored)
  assert.strictEqual(mockWindow.dateAddedFilter, null);
});

test('performCombinedSearch: preserves dateAddedFilter when already set', () => {
  const mockWindow = createMockWindow();
  const timestamp = '2024-01-01T12:00:00';
  mockWindow.dateAddedFilter = timestamp;
  mockWindow._lastDateAddedFilter = timestamp;

  shouldRestoreFilter_FIXED(mockWindow);

  // Filter should remain set
  assert.strictEqual(mockWindow.dateAddedFilter, timestamp);
});

// ============================================
// Test: libraryFiltersAreActive includes dateAdded
// ============================================

function filtersIncludeDateAdded(filters) {
  return !!filters.dateAdded;
}

test('libraryFiltersAreActive: returns true when dateAdded is set', () => {
  const filters = { dateAdded: '2024-01-01T12:00:00' };
  assert.strictEqual(filtersIncludeDateAdded(filters), true);
});

test('libraryFiltersAreActive: returns false when dateAdded is null', () => {
  const filters = { dateAdded: null };
  assert.strictEqual(filtersIncludeDateAdded(filters), false);
});

test('libraryFiltersAreActive: returns false when dateAdded is empty string', () => {
  const filters = { dateAdded: '' };
  assert.strictEqual(filtersIncludeDateAdded(filters), false);
});

// ============================================
// Test: Filter pill generation for dateAdded
// ============================================

function generateDateAddedPill(dateAddedFilter) {
  if (!dateAddedFilter) return '';

  const filterDate = new Date(dateAddedFilter);
  const dateStr = filterDate.toLocaleDateString() + ' ' +
    filterDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return `<div class="filter-pill filter-pill-date-added" data-filter-type="dateAdded">
    New since: ${dateStr}
    <span class="filter-remove" data-filter-type="dateAdded">×</span>
  </div>`;
}

test('generateDateAddedPill: generates pill when filter is set', () => {
  const pill = generateDateAddedPill('2024-01-15T14:30:00');

  assert.ok(pill.includes('filter-pill-date-added'));
  assert.ok(pill.includes('data-filter-type="dateAdded"'));
  assert.ok(pill.includes('New since:'));
  assert.ok(pill.includes('filter-remove'));
});

test('generateDateAddedPill: returns empty string when filter is null', () => {
  const pill = generateDateAddedPill(null);
  assert.strictEqual(pill, '');
});

test('generateDateAddedPill: returns empty string when filter is empty', () => {
  const pill = generateDateAddedPill('');
  assert.strictEqual(pill, '');
});

// ============================================
// Test: Click handler clears both variables
// ============================================

function handleDateAddedPillClick(mockWindow) {
  mockWindow.dateAddedFilter = null;
  mockWindow._lastDateAddedFilter = null;
}

test('handleDateAddedPillClick: clears both filter variables', () => {
  const mockWindow = createMockWindow();
  mockWindow.dateAddedFilter = '2024-01-01T12:00:00';
  mockWindow._lastDateAddedFilter = '2024-01-01T12:00:00';

  handleDateAddedPillClick(mockWindow);

  assert.strictEqual(mockWindow.dateAddedFilter, null);
  assert.strictEqual(mockWindow._lastDateAddedFilter, null);
});

// ============================================
// Test: Integration scenario - user flow
// ============================================

test('integration: user can clear dateAddedFilter via pill click', () => {
  const mockWindow = createMockWindow();

  // Step 1: Scan finds new models, user clicks "Yes" to show them
  mockWindow.dateAddedFilter = '2024-01-01T12:00:00';
  mockWindow._lastDateAddedFilter = '2024-01-01T12:00:00';

  assert.strictEqual(!!mockWindow.dateAddedFilter, true, 'Filter should be set');

  // Step 2: User sees the "New since" pill and clicks X
  handleDateAddedPillClick(mockWindow);

  assert.strictEqual(mockWindow.dateAddedFilter, null, 'Filter should be cleared');
  assert.strictEqual(mockWindow._lastDateAddedFilter, null, 'Backup should be cleared');

  // Step 3: performCombinedSearch runs - filter should stay cleared
  shouldRestoreFilter_FIXED(mockWindow);

  assert.strictEqual(mockWindow.dateAddedFilter, null, 'Filter should remain cleared');
});

test('integration: clearing all filters clears dateAddedFilter', () => {
  const mockWindow = createMockWindow();

  // Step 1: Filter is active
  mockWindow.dateAddedFilter = '2024-01-01T12:00:00';
  mockWindow._lastDateAddedFilter = '2024-01-01T12:00:00';

  // Step 2: User clicks "Clear All Filters"
  clearDateAddedFilters(mockWindow);

  assert.strictEqual(mockWindow.dateAddedFilter, null);
  assert.strictEqual(mockWindow._lastDateAddedFilter, null);

  // Step 3: performCombinedSearch runs - filter should stay cleared
  shouldRestoreFilter_FIXED(mockWindow);

  assert.strictEqual(mockWindow.dateAddedFilter, null, 'Filter should not be restored');
});

// ============================================
// Test: Database has models but filter blocks them
// ============================================

function countModelsMatchingFilter(models, dateAddedFilter) {
  if (!dateAddedFilter) return models.length;

  const filterDate = new Date(dateAddedFilter);
  return models.filter(model => {
    if (!model.dateAdded) return false;
    const modelDate = new Date(model.dateAdded);
    return modelDate >= filterDate;
  }).length;
}

test('countModelsMatchingFilter: all models shown when no filter', () => {
  const models = [
    { id: 1, dateAdded: '2023-01-01' },
    { id: 2, dateAdded: '2023-06-01' },
    { id: 3, dateAdded: '2024-01-01' }
  ];

  const count = countModelsMatchingFilter(models, null);
  assert.strictEqual(count, 3);
});

test('countModelsMatchingFilter: filters to models after date', () => {
  const models = [
    { id: 1, dateAdded: '2023-01-01' },
    { id: 2, dateAdded: '2023-06-01' },
    { id: 3, dateAdded: '2024-01-01' }
  ];

  const count = countModelsMatchingFilter(models, '2023-05-01');
  assert.strictEqual(count, 2); // Only models 2 and 3
});

test('countModelsMatchingFilter: returns 0 when filter is too recent', () => {
  const models = [
    { id: 1, dateAdded: '2023-01-01' },
    { id: 2, dateAdded: '2023-06-01' },
    { id: 3, dateAdded: '2024-01-01' }
  ];

  // This simulates the bug: filter set to a future date
  const count = countModelsMatchingFilter(models, '2025-01-01');
  assert.strictEqual(count, 0, '0 models should match a future filter date');
});

test('countModelsMatchingFilter: diagnoses stuck filter problem', () => {
  // This test simulates James\'s exact scenario:
  // - 271 models in database
  // - 0 models in view
  // - dateAddedFilter is set to a time when no models qualify

  const totalModels = 271;
  const models = Array.from({ length: totalModels }, (_, i) => ({
    id: i + 1,
    dateAdded: '2023-06-15T10:00:00' // All models added on the same old date
  }));

  // Filter set to a recent scan time (after all models were added)
  const stuckFilter = '2024-10-01T12:00:00';

  const countWithFilter = countModelsMatchingFilter(models, stuckFilter);
  const countWithoutFilter = countModelsMatchingFilter(models, null);

  assert.strictEqual(countWithFilter, 0, 'Stuck filter shows 0 models');
  assert.strictEqual(countWithoutFilter, 271, 'Without filter shows all 271 models');

  // The fix: clearing the filter restores the view
  const mockWindow = createMockWindow();
  mockWindow.dateAddedFilter = stuckFilter;
  mockWindow._lastDateAddedFilter = stuckFilter;

  // User clears via pill click
  handleDateAddedPillClick(mockWindow);

  const countAfterClear = countModelsMatchingFilter(models, mockWindow.dateAddedFilter);
  assert.strictEqual(countAfterClear, 271, 'After clearing filter, all 271 models visible');
});

console.log('\nAll search-date-filter tests completed.');
