/**
 * Guardrail for "works on desktop, broken in server mode" IPC drift.
 *
 * Desktop exposes its API as window.electron.<method> via preload.js. Server
 * mode has no preload: server-bridge.js rebuilds window.electron in the browser,
 * and it does so by hand, in two ways:
 *   1. a `methodToChannel` map ({ method: 'ipc-channel' }) that is turned into
 *      WebSocket-backed proxy methods, and
 *   2. explicit `window.electron.<name> = ...` assignments for everything that
 *      isn't a plain invoke (the onXxx event listeners, send, on, receive, pong, ...).
 *
 * When a method is added to preload.js and not to either place, it is simply
 * `undefined` in server mode: it works on desktop, and the first sign in
 * production is "window.electron.foo is not a function". That already shipped
 * once (the GR-PLAN-004/006 Shopify methods, see the comment above that block
 * in methodToChannel). This test makes the drift fail in CI instead.
 *
 * It is a static check: it does not launch Electron, so it is fast and has no
 * port/DB side effects.
 *
 *   - Forward:  every method preload.js exposes must be defined in server mode
 *               (in methodToChannel OR explicitly assigned in server-bridge.js)
 *               unless it is on DESKTOP_ONLY below.
 *   - Reverse:  no methodToChannel key may point at a method preload.js no
 *               longer exposes (a stale entry is dead code that hides a rename).
 *   - Hygiene:  DESKTOP_ONLY entries must be real preload methods that really
 *               are missing from server mode, so the allowlist can't rot.
 *
 * Only the `window.electron` surface is checked. `window.electronAPI` (getDb)
 * is deliberately not bridged: it returns a live better-sqlite3 handle that
 * can't cross a WebSocket (see the note in methodToChannel).
 */
const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { APP_ROOT } = require('./test-utils');

/**
 * Preload methods that are genuinely desktop-only and intentionally absent from
 * server mode. Map of method name -> why. Keep this EMPTY unless you can
 * justify an entry: "opens a native dialog" is NOT a reason by itself, because
 * those are still bridged (main.js answers them via safeShowOpenDialog /
 * safeShowSaveDialog, which surface a clear server-alert instead of hanging).
 * Add an entry only if server mode truly must not expose the method at all.
 */
const DESKTOP_ONLY = {
  // exampleMethod: 'why server mode must not expose this',
};

/** Load preload.js against a stubbed `electron` module and return the object it exposes as window.electron. */
function loadPreloadSurface() {
  const exposed = {};
  const ipcRenderer = {
    invoke: () => Promise.resolve(),
    on() { return ipcRenderer; },
    send() {},
    removeAllListeners() {}
  };
  const stubElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer,
    shell: {}
  };
  const source = fs.readFileSync(path.join(APP_ROOT, 'preload.js'), 'utf8');
  const quiet = { log() {}, warn() {}, error() {} };
  const localRequire = (id) => (id === 'electron' ? stubElectron : require(path.join(APP_ROOT, id)));
  // Same wrapper shape Electron gives a preload script; `window` is left undefined (not touched at load).
  new Function('require', 'module', 'console', 'window', source)(localRequire, {}, quiet, undefined);
  if (!exposed.electron) {
    throw new Error("preload.js did not call contextBridge.exposeInMainWorld('electron', ...)");
  }
  return Object.keys(exposed.electron);
}

/** Pull the methodToChannel object literal out of server-bridge.js and the set of explicitly-assigned window.electron.* names. */
function loadBridgeSurface() {
  const source = fs.readFileSync(path.join(APP_ROOT, 'server-bridge.js'), 'utf8');

  const declStart = source.indexOf('const methodToChannel = {');
  if (declStart === -1) throw new Error('could not find "const methodToChannel = {" in server-bridge.js');
  const open = source.indexOf('{', declStart);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) { close = i; break; }
  }
  if (close === -1) throw new Error('unbalanced braces while reading methodToChannel');
  // The literal holds only string keys/values and comments, so it is safe to evaluate.
  const methodToChannel = new Function('return ' + source.slice(open, close + 1))();

  const assigned = new Set(
    [...source.matchAll(/window\.electron\.([A-Za-z0-9_$]+)\s*=(?!=)/g)].map((m) => m[1])
  );
  return { mapKeys: Object.keys(methodToChannel), assigned };
}

test.describe('Server mode: IPC surface parity (preload.js vs server-bridge.js)', () => {
  const preloadMethods = loadPreloadSurface();
  const { mapKeys, assigned } = loadBridgeSurface();

  test('parsing found a plausible surface (guards against a silently broken parser)', () => {
    expect(preloadMethods.length, 'preload.js methods found').toBeGreaterThan(100);
    expect(mapKeys.length, 'methodToChannel keys found').toBeGreaterThan(100);
    expect(assigned.size, 'explicit window.electron.* assignments found').toBeGreaterThan(10);
  });

  test('every preload.js method is defined in server mode (or explicitly desktop-only)', () => {
    const inMap = new Set(mapKeys);
    const missing = preloadMethods.filter(
      (m) => !inMap.has(m) && !assigned.has(m) && !(m in DESKTOP_ONLY)
    );
    expect(
      missing,
      `window.electron.<method> exists in preload.js but would be undefined in server mode: ${missing.join(', ')}.\n` +
        'Fix: add it to methodToChannel in server-bridge.js (plain ipcRenderer.invoke wrappers), ' +
        'give it an explicit window.electron.<name> = ... in server-bridge.js (event listeners etc.), ' +
        'or, if it truly must not exist in server mode, add it to DESKTOP_ONLY in this test with a reason.'
    ).toEqual([]);
  });

  test('no stale methodToChannel entries for methods preload.js no longer exposes', () => {
    const inPreload = new Set(preloadMethods);
    const stale = mapKeys.filter((k) => !inPreload.has(k));
    expect(
      stale,
      `methodToChannel in server-bridge.js has entries with no matching preload.js method: ${stale.join(', ')}. ` +
        'Remove them, or fix the name if preload.js was renamed.'
    ).toEqual([]);
  });

  test('DESKTOP_ONLY allowlist only contains real, genuinely-unbridged preload methods', () => {
    const inPreload = new Set(preloadMethods);
    const inMap = new Set(mapKeys);
    const notInPreload = Object.keys(DESKTOP_ONLY).filter((m) => !inPreload.has(m));
    const actuallyBridged = Object.keys(DESKTOP_ONLY).filter((m) => inMap.has(m) || assigned.has(m));
    expect(notInPreload, `DESKTOP_ONLY lists methods preload.js does not expose: ${notInPreload.join(', ')}`).toEqual([]);
    expect(
      actuallyBridged,
      `DESKTOP_ONLY lists methods that server-bridge.js does define (remove from the allowlist): ${actuallyBridged.join(', ')}`
    ).toEqual([]);
  });
});
