/**
 * Guardrail for the GR-PLAN-007 Phase 2 Shopify extraction.
 *
 * The Shopify IPC handler logic lives in core/shopify-catalog.js,
 * core/shopify-orders.js and core/shopify-reconciliation.js. Those modules are
 * Electron-free: they take `db` as an explicit argument and a `notify(channel,
 * ...args)` callback where they need to emit an event, so a future
 * Electron-free server runtime can import them. main.js keeps only the
 * `ipcMain.handle('channel', fooHandler)` registrations, and each `fooHandler`
 * is a thin wrapper that reads the *current* `db` (main.js reassigns it on
 * backup / restore / purge) and delegates.
 *
 * Drift to prevent: someone adds a new Shopify handler and writes the logic
 * inline in main.js again, quietly growing the Electron-coupled surface.
 *
 * It is a static check (no Electron launch), in the style of
 * server-mode-ipc-surface-parity.spec.js:
 *   - Delegation:   every `ipcMain.handle(...)` between the
 *                   "Shopify Integration Handlers" markers in main.js must
 *                   resolve to a function whose whole body is one
 *                   `return <coreModule>.<fn>(db, ...)` call, where <fn> is a
 *                   real export of that core module, unless the channel is on
 *                   INLINE_ALLOWLIST below.
 *   - Wiring:       each core module is required into main.js under the alias
 *                   the wrappers use, and the file exists.
 *   - Purity:       core/shopify-*.js contain no Electron coupling.
 *   - Hygiene:      allowlist entries must be real channels that really are
 *                   not thin delegates, so the allowlist can't rot.
 */
const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { APP_ROOT } = require('./test-utils');

const START_MARKER = '// Shopify Integration Handlers';
const END_MARKER = '// End Shopify Integration Handlers';

/** main.js alias -> core file the wrappers delegate to. */
const CORE_MODULES = {
  shopifyCatalog: 'core/shopify-catalog.js',
  shopifyOrders: 'core/shopify-orders.js',
  shopifyReconciliation: 'core/shopify-reconciliation.js'
};

/**
 * Channels registered in the Shopify section that genuinely cannot be thin
 * delegates into core/. Map of channel -> why. Keep this short and justified:
 * "it's big" is not a reason; "it needs Electron" is.
 */
const INLINE_ALLOWLIST = {
  'show-photo-context-menu':
    'builds a native Electron Menu, shows a message box, saves a thumbnail and pushes to mainWindow / global.broadcastEvent',
  'browse-for-images':
    'opens a native file dialog against mainWindow (safeShowOpenDialog)'
};

const read = (rel) => fs.readFileSync(path.join(APP_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** Strip // and block comments (good enough for these files; strings containing "//" are rare and only make the check stricter). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Body text between the braces of `function NAME(...) {` in `src`, or null if not found / unbalanced. */
function functionBody(src, name) {
  const m = new RegExp(String.raw`(?:async\s+)?function\s+${name}\s*\([^)]*\)\s*\{`).exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

/** Names listed in a core module's trailing `module.exports = { a, b, c };`. */
function coreExports(rel) {
  const src = stripComments(read(rel));
  const m = /module\.exports\s*=\s*\{([\s\S]*?)\}\s*;?\s*$/.exec(src.trim());
  if (!m) throw new Error(`could not find a trailing "module.exports = { ... }" in ${rel}`);
  return new Set(m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean));
}

const THIN = new RegExp(
  String.raw`^return\s+(${Object.keys(CORE_MODULES).join('|')})\.([A-Za-z_$][\w$]*)\(\s*db\b[^;]*\)\s*;$`
);

function loadSection() {
  const main = read('main.js');
  const start = main.indexOf(START_MARKER);
  const end = main.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`could not find the "${START_MARKER}" / "${END_MARKER}" markers in main.js`);
  }
  const section = main.slice(start, end);
  const channels = [...section.matchAll(/ipcMain\.handle\(\s*'([^']+)'\s*,\s*([^;]*?)\)\s*;/g)].map((m) => ({
    channel: m[1],
    handlerExpr: m[2].trim()
  }));
  return { main, section, channels };
}

/** Classify one registration: { thin: true, alias, fn } or { thin: false, why }. */
function classify(main, { channel, handlerExpr }) {
  if (!/^[A-Za-z_$][\w$]*$/.test(handlerExpr)) {
    return { thin: false, why: `registered with an inline function expression (${handlerExpr.slice(0, 40)}...), not a named delegating wrapper` };
  }
  const body = functionBody(main, handlerExpr);
  if (body === null) {
    return { thin: false, why: `handler "${handlerExpr}" is not a plain "function ${handlerExpr}(...) { ... }" declaration in main.js` };
  }
  const code = stripComments(body).trim();
  const m = THIN.exec(code);
  if (!m) {
    const lines = code.split('\n').length;
    return { thin: false, why: `handler "${handlerExpr}" has an inline body (${lines} line(s)), not a single "return <core>.<fn>(db, ...)" delegation` };
  }
  return { thin: true, alias: m[1], fn: m[2] };
}

test.describe('Shopify core extraction: main.js handlers delegate to core/shopify-*.js', () => {
  const { main, channels } = loadSection();
  const results = channels.map((c) => ({ ...c, ...classify(main, c) }));

  test('parsing found a plausible surface (guards against a silently broken parser)', () => {
    expect(channels.length, 'Shopify ipcMain.handle registrations found').toBeGreaterThan(50);
    expect(new Set(channels.map((c) => c.channel)).size, 'distinct channels').toBe(channels.length);
    expect(results.filter((r) => r.thin).length, 'thin delegating wrappers found').toBeGreaterThan(50);
    const usedAliases = new Set(results.filter((r) => r.thin).map((r) => r.alias));
    expect([...usedAliases].sort(), 'every core module is used by at least one wrapper').toEqual(Object.keys(CORE_MODULES).sort());
  });

  test('every Shopify handler delegates to a core/ export (no inline bodies)', () => {
    const offenders = results
      .filter((r) => !r.thin && !(r.channel in INLINE_ALLOWLIST))
      .map((r) => `  - '${r.channel}': ${r.why}`);
    expect(
      offenders,
      `Shopify handlers in main.js must be thin wrappers around core/shopify-*.js, but found inline logic:\n${offenders.join('\n')}\n` +
        'Fix: move the body into core/shopify-catalog.js, core/shopify-orders.js or core/shopify-reconciliation.js ' +
        '(db as the first parameter, a notify(channel, ...args) callback for events, no Electron globals), then make the main.js ' +
        'handler "return <module>.<fn>(db, ...)". If it truly needs Electron (native Menu / dialog / BrowserWindow), ' +
        'add the channel to INLINE_ALLOWLIST in this test with a reason.'
    ).toEqual([]);
  });

  test('every delegation targets a function the core module really exports', () => {
    const exportsByAlias = Object.fromEntries(Object.entries(CORE_MODULES).map(([a, rel]) => [a, coreExports(rel)]));
    const dangling = results
      .filter((r) => r.thin && !exportsByAlias[r.alias].has(r.fn))
      .map((r) => `  - '${r.channel}' -> ${r.alias}.${r.fn}(...) is not exported by ${CORE_MODULES[r.alias]}`);
    expect(dangling, `main.js wrappers call core functions that do not exist:\n${dangling.join('\n')}`).toEqual([]);
  });

  test('each core module exists and is required into main.js under the alias the wrappers use', () => {
    const problems = [];
    for (const [alias, rel] of Object.entries(CORE_MODULES)) {
      if (!fs.existsSync(path.join(APP_ROOT, rel))) problems.push(`${rel} does not exist`);
      const req = new RegExp(String.raw`const\s+${alias}\s*=\s*require\(\s*'\./${rel.replace(/\.js$/, '').replace(/\./g, '\\.')}'\s*\)\s*;`);
      if (!req.test(main)) problems.push(`main.js does not contain "const ${alias} = require('./${rel.replace(/\.js$/, '')}');"`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('core/shopify-*.js contain no Electron coupling', () => {
    const forbidden = [
      [/require\(\s*['"]electron['"]\s*\)/, "require('electron')"],
      [/\bipcMain\b/, 'ipcMain'],
      [/\bipcRenderer\b/, 'ipcRenderer'],
      [/\bBrowserWindow\b/, 'BrowserWindow'],
      [/\bmainWindow\b/, 'mainWindow'],
      [/\bglobal\./, 'global.*'],
      [/\bevent\b/, 'event (use a notify callback instead)'],
      [/(?<![.\w$])dialog\./, 'dialog.*'],
      [/(?<![.\w$])app\./, 'app.*']
    ];
    const hits = [];
    for (const rel of Object.values(CORE_MODULES)) {
      const code = stripComments(read(rel));
      for (const [re, label] of forbidden) {
        if (re.test(code)) hits.push(`${rel}: ${label}`);
      }
    }
    expect(
      hits,
      `core/shopify-*.js must stay Electron-free (parameterize db, pass a notify callback):\n  - ${hits.join('\n  - ')}`
    ).toEqual([]);
  });

  test('INLINE_ALLOWLIST only contains real Shopify-section channels that genuinely are not thin delegates', () => {
    const byChannel = new Map(results.map((r) => [r.channel, r]));
    const unknown = Object.keys(INLINE_ALLOWLIST).filter((c) => !byChannel.has(c));
    const nowThin = Object.keys(INLINE_ALLOWLIST).filter((c) => byChannel.get(c)?.thin);
    expect(unknown, `INLINE_ALLOWLIST lists channels that are not registered in the Shopify section: ${unknown.join(', ')}`).toEqual([]);
    expect(nowThin, `INLINE_ALLOWLIST lists channels that are now thin delegates (remove from the allowlist): ${nowThin.join(', ')}`).toEqual([]);
  });
});
