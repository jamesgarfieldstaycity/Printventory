#!/usr/bin/env node
/**
 * Cleanup script for Parent Model grouping data.
 * Run this with the app CLOSED (SQLite file lock).
 *
 * Usage: node cleanup-parent-model.js
 *
 * This script:
 * 1. Backs up the database to printventory.db.bak-<timestamp>
 * 2. Clears all parentModel values from the models table
 * 3. Disables the two settings that auto-populate this field
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Determine database path based on platform
function getDatabasePath() {
  let userDataPath;

  if (process.platform === 'darwin') {
    // macOS
    userDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'Printventory', 'data');
  } else if (process.platform === 'win32') {
    // Windows
    userDataPath = path.join(process.env.LOCALAPPDATA, 'Printventory', 'data');
  } else {
    // Linux
    userDataPath = path.join(os.homedir(), '.config', 'Printventory', 'data');
  }

  return path.join(userDataPath, 'printventory.db');
}

function main() {
  const dbPath = getDatabasePath();

  console.log('Parent Model Cleanup Script');
  console.log('===========================');
  console.log('');
  console.log('Database path:', dbPath);

  // Check if database exists
  if (!fs.existsSync(dbPath)) {
    console.error('ERROR: Database not found at', dbPath);
    console.error('Make sure the app has been run at least once to create the database.');
    process.exit(1);
  }

  // Step 1: Backup the database
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = dbPath + '.bak-' + timestamp;

  console.log('');
  console.log('Step 1: Creating backup...');
  try {
    fs.copyFileSync(dbPath, backupPath);
    console.log('  Backup created:', backupPath);

    // Also backup WAL and SHM files if they exist
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, backupPath + '-wal');
      console.log('  WAL backup created:', backupPath + '-wal');
    }
    if (fs.existsSync(shmPath)) {
      fs.copyFileSync(shmPath, backupPath + '-shm');
      console.log('  SHM backup created:', backupPath + '-shm');
    }
  } catch (err) {
    console.error('ERROR: Failed to create backup:', err.message);
    console.error('Make sure the Printventory app is fully closed.');
    process.exit(1);
  }

  // Step 2: Open database and clear parentModel
  console.log('');
  console.log('Step 2: Opening database...');
  let db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    console.error('ERROR: Could not open database:', err.message);
    console.error('Make sure the Printventory app is fully closed.');
    process.exit(1);
  }

  console.log('');
  console.log('Step 3: Clearing parentModel data...');
  try {
    const result = db.prepare(`
      UPDATE models
      SET parentModel = NULL
      WHERE parentModel IS NOT NULL AND parentModel != ''
    `).run();

    console.log('  Rows affected:', result.changes);
  } catch (err) {
    console.error('ERROR: Failed to clear parentModel:', err.message);
    db.close();
    process.exit(1);
  }

  // Step 4: Disable the settings
  console.log('');
  console.log('Step 4: Disabling auto-populate settings...');
  try {
    // Use upsert pattern to set enable3MFParentModel = '0'
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('enable3MFParentModel', '0')
      ON CONFLICT(key) DO UPDATE SET value = '0'
    `).run();
    console.log('  enable3MFParentModel set to 0');

    // Use upsert pattern to set pathMetadataUseParentModel = '0'
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('pathMetadataUseParentModel', '0')
      ON CONFLICT(key) DO UPDATE SET value = '0'
    `).run();
    console.log('  pathMetadataUseParentModel set to 0');
  } catch (err) {
    console.error('ERROR: Failed to update settings:', err.message);
    db.close();
    process.exit(1);
  }

  // Verify the changes
  console.log('');
  console.log('Step 5: Verifying changes...');
  try {
    const remainingGroups = db.prepare(`
      SELECT COUNT(*) as count FROM models
      WHERE parentModel IS NOT NULL AND parentModel != ''
    `).get();
    console.log('  Models with parentModel remaining:', remainingGroups.count);

    const setting1 = db.prepare(`SELECT value FROM settings WHERE key = 'enable3MFParentModel'`).get();
    const setting2 = db.prepare(`SELECT value FROM settings WHERE key = 'pathMetadataUseParentModel'`).get();
    console.log('  enable3MFParentModel:', setting1?.value || '(not set)');
    console.log('  pathMetadataUseParentModel:', setting2?.value || '(not set)');
  } catch (err) {
    console.error('WARNING: Could not verify changes:', err.message);
  }

  db.close();

  console.log('');
  console.log('===========================');
  console.log('Cleanup complete!');
  console.log('');
  console.log('Next steps:');
  console.log('1. Open Printventory');
  console.log('2. Verify Settings > "3MF Parent Model" checkbox is unchecked');
  console.log('3. Verify no "GROUPED" badges remain in the library grid');
  console.log('');
}

main();
