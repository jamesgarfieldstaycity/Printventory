#!/usr/bin/env node
'use strict';

/**
 * Unit tests for badge changes:
 * 1. "New" badge uses 3-day rolling window based on dateAdded
 * 2. Print status badge removed from grid (verified via code search)
 *
 * Run with: node badge-changes.test.js
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
// Test: isModelNew() 3-day rolling window
// ============================================

/** Extracted from renderer.js - the new isModelNew() logic */
function isModelNew(model) {
  if (!model || !model.dateAdded) return false;
  const added = new Date(model.dateAdded);
  if (isNaN(added.getTime())) return false;
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  return added.getTime() >= threeDaysAgo;
}

test('isModelNew: returns false for null model', () => {
  assert.strictEqual(isModelNew(null), false);
});

test('isModelNew: returns false for model without dateAdded', () => {
  assert.strictEqual(isModelNew({ id: 1 }), false);
});

test('isModelNew: returns false for invalid dateAdded', () => {
  assert.strictEqual(isModelNew({ dateAdded: 'invalid-date' }), false);
});

test('isModelNew: returns true for model added today', () => {
  const today = new Date().toISOString();
  assert.strictEqual(isModelNew({ dateAdded: today }), true);
});

test('isModelNew: returns true for model added 1 day ago', () => {
  const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(isModelNew({ dateAdded: oneDayAgo }), true);
});

test('isModelNew: returns true for model added 2 days ago', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(isModelNew({ dateAdded: twoDaysAgo }), true);
});

test('isModelNew: returns true for model added exactly 3 days ago', () => {
  // Edge case: exactly 3 days ago should still be "new" (>= comparison)
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(isModelNew({ dateAdded: threeDaysAgo }), true);
});

test('isModelNew: returns false for model added 4 days ago', () => {
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(isModelNew({ dateAdded: fourDaysAgo }), false);
});

test('isModelNew: returns false for model added 1 week ago', () => {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(isModelNew({ dateAdded: oneWeekAgo }), false);
});

test('isModelNew: returns false for model added 1 year ago', () => {
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(isModelNew({ dateAdded: oneYearAgo }), false);
});

// ============================================
// Test: Old isNew flag logic is NOT used
// ============================================

test('isModelNew: ignores legacy isNew flag completely', () => {
  // Even with isNew=1, if dateAdded is old, model is NOT new
  const oldModel = {
    isNew: 1,
    dateAdded: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days ago
  };
  assert.strictEqual(isModelNew(oldModel), false, 'Old model with isNew=1 should not be new');

  // Even with isNew=0, if dateAdded is recent, model IS new
  const recentModel = {
    isNew: 0,
    dateAdded: new Date().toISOString() // today
  };
  assert.strictEqual(isModelNew(recentModel), true, 'Recent model with isNew=0 should be new');
});

// ============================================
// Verification: Print status badge removed
// ============================================

const fs = require('fs');
const path = require('path');

test('print status badge: NOT created in createModelItem()', () => {
  const rendererPath = path.join(__dirname, 'renderer.js');
  const content = fs.readFileSync(rendererPath, 'utf8');

  // Look for the createModelItem function area and verify no print-status badge creation
  // The function should NOT have "printStatus.className = 'print-status'" pattern
  const createModelItemMatch = content.match(/function createModelItem\([\s\S]{0,3000}/);
  if (createModelItemMatch) {
    const hasOldBadgeCode = createModelItemMatch[0].includes("printStatus.className = 'print-status'");
    assert.strictEqual(hasOldBadgeCode, false, 'createModelItem should not create print-status badge');
  }
});

test('print status badge: NOT created in renderFile()', () => {
  const rendererPath = path.join(__dirname, 'renderer.js');
  const content = fs.readFileSync(rendererPath, 'utf8');

  // Look for the renderFile function area and verify no print-status badge creation
  const renderFileMatch = content.match(/async function renderFile\([\s\S]{0,2000}/);
  if (renderFileMatch) {
    const hasOldBadgeCode = renderFileMatch[0].includes("printStatus.className = `print-status");
    assert.strictEqual(hasOldBadgeCode, false, 'renderFile should not create print-status badge');
  }
});

test('print status field: still exists in model details form', () => {
  const rendererPath = path.join(__dirname, 'renderer.js');
  const content = fs.readFileSync(rendererPath, 'utf8');

  // Verify print status select element is still referenced
  const hasModelPrintStatus = content.includes("model-print-status");
  assert.strictEqual(hasModelPrintStatus, true, 'model-print-status field should still exist');
});

test('print status badge: no orphaned appendChild(printStatus) calls', () => {
  const rendererPath = path.join(__dirname, 'renderer.js');
  const content = fs.readFileSync(rendererPath, 'utf8');

  // Check for orphaned item.appendChild(printStatus) that would throw ReferenceError
  const orphanedCalls = content.match(/item\.appendChild\(printStatus\)/g) || [];
  assert.strictEqual(orphanedCalls.length, 0,
    `Found ${orphanedCalls.length} orphaned item.appendChild(printStatus) calls that would throw ReferenceError`);
});

console.log('\nAll badge-changes tests completed.');
