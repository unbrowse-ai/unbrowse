import { test, expect } from 'bun:test';
import Firecrawl from '../src/index.js';

test('Firecrawl constructor accepts apiKey', () => {
  const c = new Firecrawl({ apiKey: 'fc-test' });
  expect(c).toBeDefined();
});

test('Firecrawl has 5 methods', () => {
  const c = new Firecrawl();
  expect(typeof c.scrape).toBe('function');
  expect(typeof c.map).toBe('function');
  expect(typeof c.crawl).toBe('function');
  expect(typeof c.extract).toBe('function');
  expect(typeof c.search).toBe('function');
});

test('scrape without apiKey + no Unbrowse hit throws actionable error', async () => {
  const c = new Firecrawl();
  // Pointing at an URL Unbrowse can't resolve. No FIRECRAWL_API_KEY.
  delete process.env.FIRECRAWL_API_KEY;
  await expect(c.scrape('https://nowhere.invalid/x')).rejects.toThrow(/cached route|FIRECRAWL_API_KEY/);
});

test('map without apiKey throws clear error', async () => {
  const c = new Firecrawl();
  delete process.env.FIRECRAWL_API_KEY;
  await expect(c.map('https://example.com')).rejects.toThrow(/FIRECRAWL_API_KEY|sitemap/);
});

test('extract returns ExtractJob shape with completed status', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  const c = new Firecrawl();
  const job = await c.extract(['https://nowhere.invalid/x']);
  expect(job.status).toBe('completed');
  expect(job.id).toMatch(/^unbrowse-extract-/);
  delete process.env.UNBROWSE_DRYRUN;
});
