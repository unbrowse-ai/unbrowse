/**
 * Structural smoke test for the playwright-shim. Verifies the public surface
 * has the right shape — actual cache-hit behavior is tested integration-side
 * (requires real Unbrowse backend; gated behind UNBROWSE_API_KEY env).
 */
import { test, expect } from 'bun:test';
import { chromium } from '../src/index.js';

test('chromium has playwright-shape surface', () => {
  expect(typeof chromium.launch).toBe('function');
  expect(typeof chromium.connectOverCDP).toBe('function');
  expect(typeof chromium.executablePath).toBe('function');
  expect(chromium.name()).toBe('chromium');
});

test('chromium.launch returns a Browser', async () => {
  const browser = await chromium.launch();
  expect(typeof browser.newContext).toBe('function');
  expect(typeof browser.newPage).toBe('function');
  expect(typeof browser.close).toBe('function');
  expect(browser.isConnected()).toBe(true);
  expect(browser.version()).toContain('unbrowse');
  await browser.close();
});

test('browser.newContext + newPage chain', async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  expect(typeof page.goto).toBe('function');
  expect(typeof page.content).toBe('function');
  expect(typeof page.click).toBe('function');
  expect(typeof page.fill).toBe('function');
  expect(typeof page.evaluate).toBe('function');
  expect(typeof page.screenshot).toBe('function');
  expect(page.url()).toBe('about:blank');
  await browser.close();
});

test('page.click without fallback throws clear error', async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await expect(page.click('button')).rejects.toThrow(/requires a live browser/);
  await browser.close();
});

test('page.evaluate(document.title) on empty page returns empty string', async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const t = await page.evaluate('document.title');
  expect(t).toBe('');
  await browser.close();
});
