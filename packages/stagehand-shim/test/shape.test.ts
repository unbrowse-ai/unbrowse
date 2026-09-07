import { test, expect } from 'bun:test';
import { Stagehand } from '../src/index.js';

test('Stagehand constructor accepts config', () => {
  const sh = new Stagehand({ env: 'BROWSERBASE', apiKey: 'bb-test', projectId: 'p1' });
  expect(sh).toBeDefined();
});

test('Stagehand has act/extract/observe/init/close', () => {
  const sh = new Stagehand();
  expect(typeof sh.init).toBe('function');
  expect(typeof sh.act).toBe('function');
  expect(typeof sh.extract).toBe('function');
  expect(typeof sh.observe).toBe('function');
  expect(typeof sh.close).toBe('function');
});

test('init populates page and context stubs', async () => {
  const sh = new Stagehand();
  await sh.init();
  expect(sh.page).toBeDefined();
  expect(typeof sh.page.goto).toBe('function');
  expect(typeof sh.page.url).toBe('function');
  expect(sh.context).toBeDefined();
  expect(typeof sh.context.pages).toBe('function');
  await sh.close();
});

test('page.goto stores URL for next resolve', async () => {
  const sh = new Stagehand();
  await sh.init();
  await sh.page.goto('https://example.com');
  expect(sh.page.url()).toBe('https://example.com');
  await sh.close();
});

test('act without URL and no real Stagehand throws actionable error', async () => {
  const sh = new Stagehand();
  await sh.init();
  // no goto'd URL → resolve will fail → fallback will fail since @browserbasehq/stagehand not installed
  await expect(sh.act('click search')).rejects.toThrow(/cached Unbrowse route|@browserbasehq\/stagehand/);
  await sh.close();
});
