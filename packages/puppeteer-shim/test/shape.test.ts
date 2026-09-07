import { test, expect } from 'bun:test';
import puppeteer, { launch, connect, executablePath } from '../src/index.js';

// Parity: a puppeteer caller's import surface must exist so the swap compiles.

test('default export has launch/connect/executablePath', () => {
  expect(typeof puppeteer.launch).toBe('function');
  expect(typeof puppeteer.connect).toBe('function');
  expect(typeof puppeteer.executablePath).toBe('function');
});

test('named exports match', () => {
  expect(typeof launch).toBe('function');
  expect(typeof connect).toBe('function');
  expect(executablePath()).toContain('chromium');
});

test('launch() returns a Browser with newPage/close/version/isConnected', async () => {
  const browser = await launch();
  expect(typeof browser.newPage).toBe('function');
  expect(typeof browser.close).toBe('function');
  expect(browser.isConnected()).toBe(true);
  expect(await browser.version()).toContain('unbrowse');
  await browser.close();
});

test('newPage() returns a Page with the goto/content/title surface', async () => {
  const browser = await launch();
  const page = await browser.newPage();
  for (const m of ['goto', 'content', 'title', 'url', 'evaluate', 'click', 'type', 'screenshot', 'close']) {
    expect(typeof (page as any)[m]).toBe('function');
  }
  expect(page.url()).toBe('about:blank');
  await browser.close();
});

test('a cache miss surfaces a real error (shim guidance, or the real-puppeteer fallback)', async () => {
  const browser = await launch();
  const page = await browser.newPage();
  // No marketplace route for this URL. Either: puppeteer is absent → the shim's
  // actionable "install puppeteer" guidance, or puppeteer is present → it
  // delegates to the real fallback (which surfaces its own launch error here).
  // Both prove the miss path is wired and never silently no-ops.
  await expect(page.goto('https://nowhere.invalid/x')).rejects.toThrow();
  await browser.close();
});

test('live-DOM methods fail loudly on a synthesized page (no silent no-op)', async () => {
  const browser = await launch();
  const page = await browser.newPage();
  await expect(page.click()).rejects.toThrow(/live browser/);
  await expect(page.screenshot()).rejects.toThrow(/live browser/);
  await browser.close();
});
