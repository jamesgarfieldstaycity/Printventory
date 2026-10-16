'use strict';

// Electron-free logic for "Open File" (GR-PLAN-007: new logic lives in core/).
// main.js injects `shell` and the logger; tests inject fakes.

// shell.openPath on these would run code on the server PC rather than open a model.
const BLOCKED_HOST_OPEN_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.hta', '.cpl', '.reg', '.lnk', '.jar', '.sh', '.app', '.dll'
]);

/**
 * True when the socket address is the server PC talking to itself:
 * 127.0.0.0/8, ::1, or an IPv4-mapped loopback (::ffff:127.x.x.x).
 * Anything else (including null/unknown) is treated as a remote client.
 */
function isLoopbackAddress(address) {
  if (!address || typeof address !== 'string') return false;
  const a = address.trim().toLowerCase();
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function blockedExtension(filePath) {
  const m = /(\.[^./\\]+)$/.exec(String(filePath || ''));
  return m && BLOCKED_HOST_OPEN_EXTENSIONS.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}

/**
 * Open a file with the OS default application on THIS machine (the host running
 * Printventory). Never throws; always returns { success, path, error? }.
 *
 * shell.openPath() resolves to an error string ('' on success) rather than
 * rejecting, so the returned string is checked explicitly.
 */
async function openFileOnHost(filePath, { shell, fs, log = () => {}, context = '' } = {}) {
  const tag = `[OpenFile]${context ? ` ${context}` : ''}`;
  const fail = (error) => {
    log(`${tag} FAILED path="${filePath}" error="${error}"`);
    return { success: false, error, path: filePath };
  };

  if (!filePath || typeof filePath !== 'string') return fail('No file path was provided.');

  const blocked = blockedExtension(filePath);
  if (blocked) return fail(`Refusing to open "${blocked}" files - only model files can be opened.`);

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return fail('Path is not a file.');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return fail('File not found. It may have been moved or deleted, or its share is not reachable from the server.');
    }
    return fail(`Cannot access file: ${(err && err.message) || err}`);
  }

  let openError;
  try {
    openError = await shell.openPath(filePath);
  } catch (err) {
    return fail((err && err.message) || String(err));
  }
  if (openError) return fail(openError);

  log(`${tag} OK path="${filePath}"`);
  return { success: true, path: filePath };
}

/**
 * Decide where an open-file request should run.
 *  - 'host'   : open on the machine running Printventory
 *  - 'choice' : a remote browser asked; let the user pick (open on server PC / download a copy)
 * Desktop mode and loopback clients always open on the host. A remote client only
 * opens on the host when it explicitly asked for target 'server'.
 */
function resolveOpenTarget({ isServerMode, clientAddress, requestedTarget }) {
  if (!isServerMode) return 'host';
  if (isLoopbackAddress(clientAddress)) return 'host';
  return requestedTarget === 'server' ? 'host' : 'choice';
}

module.exports = { isLoopbackAddress, blockedExtension, openFileOnHost, resolveOpenTarget, BLOCKED_HOST_OPEN_EXTENSIONS };
