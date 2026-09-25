/**
 * Extension E2E tests for the built MV3 extension in dist/, driven by real Chromium.
 *
 * Design decisions (why this file looks the way it does):
 *  - One persistent browser context is shared by all tests: the extension is
 *    loaded once via --load-extension and every test talks to the same
 *    service worker, which keeps the suite fast and deterministic.
 *  - Pages come from a loopback HTTP fixture server, not example.com: the CI
 *    container has no outbound network, and a local fixture also pins the
 *    exact DOM the ARIA snapshot must describe.
 *  - A web page has no `chrome` global (the extension is not
 *    externally_connectable), so messaging is driven the way production
 *    drives it: the extension service worker calls
 *    chrome.tabs.sendMessage(tabId, {action, payload}) and the content
 *    script's chrome.runtime.onMessage listener answers. Reaching that
 *    listener is itself the proof that injection happened.
 *  - The popup is opened as a chrome-extension:// page (equivalent to the
 *    toolbar popup). Assertions target the real Vue DOM: the h1 header and
 *    the ServerSettings "En uso:" hint, which only renders after a
 *    getServerConfig round-trip through the background service worker.
 *    There is no #statusText in this popup.
 */
import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '..', 'dist');
const EXTENSION_NAME = 'Agent Jake Browser MCP';

const FIXTURE_TITLE = 'Agent Jake E2E Fixture';
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${FIXTURE_TITLE}</title>
  </head>
  <body>
    <h1>E2E fixture heading</h1>
    <p>Served over loopback so content script injection is deterministic.</p>
    <button type="button">Fixture button</button>
    <a href="#section">Fixture link</a>
    <section id="section"><p>Anchor target.</p></section>
  </body>
</html>`;

/** Shape of ContentScriptResponse returned by the content script listener. */
interface ContentScriptResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

let fixtureServer: http.Server;
let fixtureOrigin: string;
let context: BrowserContext;
let extensionId: string;

function startFixtureServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/fixture') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(FIXTURE_HTML);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * The MV3 service worker starts with the browser and can be torn down while
 * idle, so always re-resolve the live worker instead of caching the handle.
 */
async function getExtensionServiceWorker(ctx: BrowserContext): Promise<Worker> {
  const live = ctx.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (live) return live;
  return ctx.waitForEvent('serviceworker', { timeout: 15000 });
}

async function getExtensionId(ctx: BrowserContext): Promise<string> {
  const worker = await getExtensionServiceWorker(ctx);
  const match = worker.url().match(/^chrome-extension:\/\/([^/]+)/);
  if (!match) throw new Error(`Unexpected service worker URL: ${worker.url()}`);
  return match[1];
}

/**
 * Message the content script of the fixture tab through the service worker,
 * mirroring production's sendToContent(): retry until the @crxjs loader's
 * dynamic import has registered the onMessage listener.
 */
async function sendToFixtureContentScript(
  ctx: BrowserContext,
  fixtureUrl: string,
  action: string,
  payload: unknown,
  waitMs = 20000
): Promise<ContentScriptResponse> {
  const deadline = Date.now() + waitMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    const sw = await getExtensionServiceWorker(ctx).catch(() => null);
    if (sw) {
      try {
        return await sw.evaluate(
          async ({ url, action, payload }) => {
            const [tab] = await chrome.tabs.query({ url });
            if (!tab?.id) throw new Error(`no tab found for ${url}`);
            return await chrome.tabs.sendMessage(tab.id, { action, payload }, { frameId: 0 });
          },
          { url: fixtureUrl, action, payload }
        );
      } catch (err) {
        // 'Receiving end does not exist' until the content script listener exists.
        lastError = String((err as Error)?.message ?? err);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`content script unreachable for '${action}': ${lastError}`);
}

test.beforeAll(async () => {
  ({ server: fixtureServer, origin: fixtureOrigin } = await startFixtureServer());

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  extensionId = await getExtensionId(context);
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolve, reject) =>
    fixtureServer?.close(err => (err ? reject(err) : resolve()))
  );
});

test('extension loads successfully', async () => {
  const sw = await getExtensionServiceWorker(context);
  expect(sw.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/`));
  expect(extensionId).toMatch(/^[a-p]{32}$/);

  // Self-report from inside the worker: the manifest Chrome actually loaded.
  const manifest = await sw.evaluate(() => {
    const m = chrome.runtime.getManifest();
    return {
      name: m.name,
      version: m.version,
      popup: (m as { action?: { default_popup?: string } }).action?.default_popup ?? '',
    };
  });
  expect(manifest.name).toBe(EXTENSION_NAME);
  expect(manifest.popup).toBe('src/popup/index.html');
});

test('popup renders status panel and reads server config from background', async () => {
  const popup = await context.newPage();
  try {
    await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await expect(popup.getByRole('heading', { name: 'Agent Jake Browser' })).toBeVisible();

    // The 'En uso:' hint renders only after getServerConfig round-trips
    // through the background service worker, so this proves popup <-> SW
    // messaging, not just a static shell.
    await expect(popup.getByText('En uso: ws://127.0.0.1:8765')).toBeVisible({ timeout: 15000 });

    // With no MCP WebSocket server listening on 8765, the indicator must
    // report the real state from getStatus: OFFLINE.
    await expect(popup.locator('.mcp-indicator .indicator-value')).toHaveText('OFFLINE', {
      timeout: 15000,
    });
  } finally {
    await popup.close();
  }
});

test('content script injects on page load and answers the extension', async () => {
  const fixtureUrl = `${fixtureOrigin}/fixture`;
  const page = await context.newPage();
  const logs: string[] = [];
  const onConsole = (msg: { text: () => string }) => {
    const text = msg.text();
    if (text.includes('[AgentJake]')) logs.push(text);
  };
  page.on('console', onConsole);
  try {
    await page.goto(fixtureUrl, { waitUntil: 'load' });
    await expect(page.locator('h1')).toHaveText('E2E fixture heading');

    // Deterministic injection proof: the service worker reaches the
    // content script's onMessage listener and gets the live page back.
    const info = await sendToFixtureContentScript(context, fixtureUrl, 'getPageInfo', {});
    expect(info.success).toBe(true);
    expect(info.data).toMatchObject({ url: fixtureUrl, title: FIXTURE_TITLE });

    // The content script also logs its presence; keep as secondary evidence.
    await expect
      .poll(() => logs.some(log => log.includes('Content script loaded')), { timeout: 10000 })
      .toBe(true);
  } finally {
    page.off('console', onConsole);
    await page.close();
  }
});

test('generates an ARIA snapshot through the production messaging path', async () => {
  const fixtureUrl = `${fixtureOrigin}/fixture`;
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl, { waitUntil: 'load' });

    // Same two steps the browser_snapshot tool takes over WebSocket:
    // wait for the frame listener, then request the snapshot itself.
    const ready = await sendToFixtureContentScript(context, fixtureUrl, 'getPageInfo', {});
    expect(ready.success).toBe(true);

    const snapshot = await sendToFixtureContentScript(context, fixtureUrl, 'generateSnapshot', {});
    expect(snapshot.success).toBe(true);
    expect(typeof snapshot.data).toBe('string');

    const aria = snapshot.data as string;
    expect(aria).toMatch(/- heading "E2E fixture heading"/);
    expect(aria).toMatch(/- button "Fixture button"/);
    expect(aria).toMatch(/- link "Fixture link"/);
    // Every addressable node carries a usable ref (sN eM) for later actions.
    expect(aria).toMatch(/\[s\d+e\d+/);
  } finally {
    await page.close();
  }
});
