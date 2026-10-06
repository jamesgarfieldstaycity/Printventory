/**
 * Guardrails for server-mode scan-error visibility.
 *
 * Investigation (2026-10-05) found that window.electron.showMessage() /
 * showMessageBox() are NOT routed through the main-process native dialog in
 * server mode at all: server-bridge.js overrides them client-side with
 * showBrowserMessage(), an in-page <dialog> that renders correctly and
 * resolves when clicked (confirmed directly -- it is not a hang).
 *
 * The real bug behind "scan flashes the components then stops with no
 * visible error" was in renderer.js's scanAndRenderDirectory(): its catch
 * block only set hidden progress-bar text (and, for the one special case of
 * a UNC-path error, called window.alert()) -- every other scan failure had
 * no visible surface at all, because the progress section is unconditionally
 * hidden again in the finally{} block right after. That catch block now
 * calls window.electron.showMessage() for every failure.
 *
 * Test 1 guards the mechanism itself: that showMessage() still renders a
 * real, visible dialog in server mode (a regression here would silently
 * re-introduce "nothing visible" even though the call technically completes).
 *
 * Test 2 guards the main-process half of the fix: that an invalid scan path
 * in server mode is rejected with a clear error (rather than hanging or
 * succeeding silently) over the same scan-directory IPC channel the UI uses,
 * which is the failure renderer.js's catch block now has to surface.
 * (A full click-through-the-real-UI version of this test was attempted but
 * proved too flaky in this headless harness -- the scan button's listener
 * did not reliably fire after a dynamic sidebar re-render. The fix itself
 * was verified by direct code reading: renderer.js's scanAndRenderDirectory
 * catch block now calls window.electron.showMessage(), the mechanism Test 1
 * independently proves works.)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const { APP_ROOT, getTestEnv } = require('./test-utils');

const MESSAGE_DIALOG_SELECTOR = 'dialog[id^="browser-message-"]';

async function bootServerModeAndConnect(port, dbPath, userDataDir) {
  const base = `http://127.0.0.1:${port}`;
  const env = getTestEnv({ PRINTVENTORY_DB_PATH: dbPath, PRINTVENTORY_PORT: port });
  const app = await electron.launch({
    args: [APP_ROOT, '--server', '--user-data-dir=' + userDataDir],
    env,
    cwd: APP_ROOT
  });

  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  let page = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !page) {
    try {
      const candidate = await browser.newPage();
      await candidate.goto(base, { waitUntil: 'domcontentloaded', timeout: 5000 });
      page = candidate;
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  if (!page) {
    await browser.close().catch(() => {});
    await app.close().catch(() => {});
    throw new Error('server HTTP endpoint never came up');
  }

  for (const label of ['I Agree', 'Accept', 'Get Started!', 'Close', 'OK']) {
    const btn = page.locator(`button:has-text("${label}")`).first();
    try {
      if (await btn.isVisible({ timeout: 1500 })) await btn.click({ timeout: 2000 });
    } catch (_) {}
  }

  await page.waitForFunction(() => !!(window.electron && window.electron.showMessage), null, { timeout: 30000 });
  return { app, browser, page };
}

test.describe('Server mode: scan errors are surfaced, not silent', () => {
  test.setTimeout(120000);

  test('showMessage renders a visible, correctly-labeled dialog', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printventory-dialog-test-'));
    const { app, browser, page } = await bootServerModeAndConnect(
      '15095',
      path.join(tmpDir, 'printventory.db'),
      path.join(tmpDir, 'user-data')
    );
    try {
      await page.evaluate(() => {
        window.electron.showMessage('Error', 'Failed to scan directory');
      });

      const dialog = page.locator(MESSAGE_DIALOG_SELECTOR);
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(dialog).toContainText('Error');
      await expect(dialog).toContainText('Failed to scan directory');
    } finally {
      await browser.close().catch(() => {});
      await app.close().catch(() => {});
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('an invalid scan path is rejected with a clear error, not silently', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printventory-scan-fail-test-'));
    const { app, browser, page } = await bootServerModeAndConnect(
      '15094',
      path.join(tmpDir, 'printventory.db'),
      path.join(tmpDir, 'user-data')
    );
    try {
      // Non-UNC path: server mode rejects this outright. This is the exact
      // IPC channel (scan-directory) and the exact rejection that renderer.js's
      // scanAndRenderDirectory() catch block now surfaces via showMessage().
      const badPath = 'C:\\__printventory_guardrail_missing_' + Date.now();

      const result = await page.evaluate(async (p) => {
        try {
          await window.electron.scanDirectory([p]);
          return { ok: true };
        } catch (e) {
          return { ok: false, message: e && e.message };
        }
      }, badPath);

      expect(result.ok, 'an invalid path must not report success').toBe(false);
      expect(result.message || '').toMatch(/UNC path/i);
    } finally {
      await browser.close().catch(() => {});
      await app.close().catch(() => {});
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
