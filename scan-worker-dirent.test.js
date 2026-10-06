#!/usr/bin/env node
'use strict';

// Regression test for the UNC/OneDrive "silent empty scan" bug.
//
// Root cause: fs.promises.readdir(path, { withFileTypes: true }) can return
// a Dirent whose isDirectory() incorrectly reports false for a real
// directory when the path goes over SMB/UNC onto a OneDrive-backed, cloud
// placeholder (reparse-point) folder. processDirectory() in scan-worker.js
// used to trust that bit unconditionally, so a real directory would get
// silently misclassified as a (non-matching) file and dropped - the entire
// subtree under it was never visited, with no error of any kind. That is
// what "UNC library folder scans but finds 0 files" actually was, in both
// desktop and server mode (the scanning code itself is mode-agnostic).
//
// This test reproduces the exact Dirent-lies-about-isDirectory() condition
// without needing a real UNC share or OneDrive folder, by monkey-patching
// fs.promises.readdir for the duration of the test to make one specific
// directory's Dirent report isDirectory() === false, same as the real bug.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanDirectory } = require('./scan-worker');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err && err.stack || err);
    process.exitCode = 1;
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Wraps fs.promises.readdir so that any directory entry whose name is in
// `lyingNames` has its Dirent.isDirectory() forced to return false - exactly
// reproducing the real-world SMB/OneDrive quirk. Returns a restore function.
function patchReaddirToLieAbout(lyingNames) {
  const realReaddir = fs.promises.readdir;
  fs.promises.readdir = async (dirPath, opts) => {
    const entries = await realReaddir(dirPath, opts);
    if (!opts || !opts.withFileTypes) return entries;
    return entries.map((entry) => {
      if (!lyingNames.has(entry.name)) return entry;
      return new Proxy(entry, {
        get(target, prop, receiver) {
          if (prop === 'isDirectory') return () => false;
          return Reflect.get(target, prop, receiver);
        }
      });
    });
  };
  return () => {
    fs.promises.readdir = realReaddir;
  };
}

async function run() {
  await asyncTest('scanDirectory still finds files inside a directory Dirent falsely reports as not-a-directory (UNC/OneDrive bug)', async () => {
    const root = makeTempDir('pv-dirent-lie-');
    try {
      fs.writeFileSync(path.join(root, 'normalFile.stl'), 'x');
      const liarDir = path.join(root, 'liarDir');
      fs.mkdirSync(liarDir);
      fs.writeFileSync(path.join(liarDir, 'hiddenFile.stl'), 'x');
      const nested = path.join(liarDir, 'nested');
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, 'deepFile.3mf'), 'x');

      const restore = patchReaddirToLieAbout(new Set(['liarDir']));
      let result;
      try {
        result = await scanDirectory(root, 500 * 1024 * 1024, false, ['.stl', '.3mf'], null);
      } finally {
        restore();
      }

      // scanDirectory streams found files out via worker postMessage batches
      // (a no-op here, since there's no real parentPort outside a Worker);
      // totalFiles is the one count available directly from the resolved
      // result, and it is exactly what the real-world reproduction used to
      // prove the fix (0 -> 197 for James's real UNC path). Here it should
      // count all three real files: normalFile.stl, hiddenFile.stl (inside
      // the "lying" directory) and deepFile.3mf (inside the nested
      // directory under it). Before the fix, liarDir's contents are never
      // visited at all - only normalFile.stl plus liarDir itself
      // (misrouted into the file branch and counted there) would be seen,
      // giving totalFiles === 2 instead of 3.
      assert.strictEqual(result.totalFiles, 3,
        `expected scanDirectory to traverse into the "lying" directory and find all 3 files, got totalFiles=${result.totalFiles}`);
    } finally {
      rmDir(root);
    }
  });

  await asyncTest('scanDirectory works normally for plain nested directories with no Dirent lies (sanity/no-regression check)', async () => {
    const root = makeTempDir('pv-dirent-normal-');
    try {
      fs.writeFileSync(path.join(root, 'a.stl'), 'x');
      const sub = path.join(root, 'subfolder');
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, 'b.3mf'), 'x');
      fs.writeFileSync(path.join(sub, 'ignored.txt'), 'x');

      const result = await scanDirectory(root, 500 * 1024 * 1024, false, ['.stl', '.3mf'], null);

      // ignored.txt doesn't match a scan extension so it's dropped, but it
      // IS a real file (not a directory) so it's still counted as traversed,
      // same as a.stl and b.3mf -> totalFiles === 3.
      assert.strictEqual(result.totalFiles, 3,
        `expected normal nested scan to traverse 3 file entries, got totalFiles=${result.totalFiles}`);
    } finally {
      rmDir(root);
    }
  });

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

run();
