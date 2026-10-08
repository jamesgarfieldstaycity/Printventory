/**
 * Guardrail for the server-mode arbitrary-file-read gap in
 * core/shopify-catalog.js's getProductFolderImages / readImageAsBase64.
 *
 * Those two functions originally took a caller-supplied path with only an
 * fs.existsSync() check — no containment. In desktop/Electron mode that is
 * reachable only via the app's own IPC from a renderer the user already
 * trusts (and the native Browse dialog intentionally lets the user pick any
 * image anywhere on disk, even outside every registered library folder), so
 * that path stays permissive. In --server mode the identical calls are
 * exposed over the WebSocket bridge to any network client with a
 * caller-supplied path and no native dialog in front of it, which is a real
 * arbitrary-file-read risk once --server is ever reachable beyond localhost.
 *
 * The fix adds a third `enforce` parameter (main.js passes `isServerMode`)
 * that, when true, requires the path resolve to a location inside one of the
 * registered `library_folders` rows, using the same boundary-safe
 * root-or-root-plus-separator matcher as findModelsUnderLibraryFolderPath in
 * main.js (so 'C:/a' does not also match the sibling 'C:/ab').
 *
 * This test uses a minimal mock `db` (the two functions only ever call
 * db.prepare(sql).all()) rather than a real better-sqlite3 handle, so it
 * doesn't depend on the native binary's Node-ABI build (better-sqlite3 here
 * is rebuilt for Electron's ABI, not the system Node `npx playwright test`
 * runs under) and needs no Electron launch — it runs from a Linux-bridged
 * remote shell as well as on Windows directly.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');

const shopifyCatalog = require('../core/shopify-catalog');

function makeFakeDb(libraryFolderPaths) {
  return {
    prepare(sql) {
      return {
        all() {
          if (/library_folders/i.test(sql)) {
            return libraryFolderPaths.map((p) => ({ path: p }));
          }
          return [];
        }
      };
    }
  };
}

test.describe('Server mode: Shopify photo path containment', () => {
  let tmpRoot, libraryFolder, siblingFolder, outsideFolder, insideImage, siblingImage, outsideImage, db;

  test.beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'printventory-photo-containment-'));
    // A registered library folder ...
    libraryFolder = path.join(tmpRoot, 'library');
    fs.mkdirSync(libraryFolder, { recursive: true });
    insideImage = path.join(libraryFolder, 'inside.png');
    fs.writeFileSync(insideImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // ... and a sibling folder that shares its name as a bare string prefix
    // ('library' is a prefix of 'libraryX') but is NOT nested inside it —
    // the case the boundary-safe matcher exists to reject.
    siblingFolder = path.join(tmpRoot, 'libraryX');
    fs.mkdirSync(siblingFolder, { recursive: true });
    siblingImage = path.join(siblingFolder, 'sibling.png');
    fs.writeFileSync(siblingImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // ... and a folder with no relation to the registered library at all.
    outsideFolder = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outsideFolder, { recursive: true });
    outsideImage = path.join(outsideFolder, 'outside.png');
    fs.writeFileSync(outsideImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    db = makeFakeDb([libraryFolder]);
  });

  test.afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('isPathWithinLibraryFolders accepts the registered root and paths under it', () => {
    expect(shopifyCatalog.isPathWithinLibraryFolders(db, libraryFolder)).toBe(true);
    expect(shopifyCatalog.isPathWithinLibraryFolders(db, insideImage)).toBe(true);
  });

  test('isPathWithinLibraryFolders rejects a sibling folder with a shared name prefix', () => {
    expect(shopifyCatalog.isPathWithinLibraryFolders(db, siblingFolder)).toBe(false);
    expect(shopifyCatalog.isPathWithinLibraryFolders(db, siblingImage)).toBe(false);
  });

  test('isPathWithinLibraryFolders rejects an unrelated folder', () => {
    expect(shopifyCatalog.isPathWithinLibraryFolders(db, outsideFolder)).toBe(false);
  });

  test('isPathWithinLibraryFolders rejects a directory-traversal escape from inside the library folder', () => {
    const escaped = path.join(libraryFolder, '..', 'outside', 'outside.png');
    expect(shopifyCatalog.isPathWithinLibraryFolders(db, escaped)).toBe(false);
  });

  test('getProductFolderImages: enforce=false (desktop/IPC) allows a folder outside every library folder', async () => {
    const images = await shopifyCatalog.getProductFolderImages(db, outsideFolder, false);
    expect(images.map((i) => i.filename)).toEqual(['outside.png']);
  });

  test('getProductFolderImages: enforce=true (server mode) allows a folder inside a registered library folder', async () => {
    const images = await shopifyCatalog.getProductFolderImages(db, libraryFolder, true);
    expect(images.map((i) => i.filename)).toEqual(['inside.png']);
  });

  test('getProductFolderImages: enforce=true (server mode) rejects a sibling folder and an unrelated folder', async () => {
    expect(await shopifyCatalog.getProductFolderImages(db, siblingFolder, true)).toEqual([]);
    expect(await shopifyCatalog.getProductFolderImages(db, outsideFolder, true)).toEqual([]);
  });

  test('readImageAsBase64: enforce=false (desktop/IPC) allows a file outside every library folder', async () => {
    const result = await shopifyCatalog.readImageAsBase64(db, outsideImage, false);
    expect(result).not.toBeNull();
    expect(result.startsWith('data:image/png;base64,')).toBe(true);
  });

  test('readImageAsBase64: enforce=true (server mode) allows a file inside a registered library folder', async () => {
    const result = await shopifyCatalog.readImageAsBase64(db, insideImage, true);
    expect(result).not.toBeNull();
    expect(result.startsWith('data:image/png;base64,')).toBe(true);
  });

  test('readImageAsBase64: enforce=true (server mode) rejects a sibling-folder file and an unrelated file', async () => {
    expect(await shopifyCatalog.readImageAsBase64(db, siblingImage, true)).toBeNull();
    expect(await shopifyCatalog.readImageAsBase64(db, outsideImage, true)).toBeNull();
  });

  test('readImageAsBase64: enforce=true (server mode) rejects a directory-traversal escape', async () => {
    const escaped = path.join(libraryFolder, '..', 'outside', 'outside.png');
    expect(await shopifyCatalog.readImageAsBase64(db, escaped, true)).toBeNull();
  });
});
