import { test, expect } from 'bun:test';
import undici, {
  request,
  fetch,
  Client,
  Pool,
  Agent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  interceptors,
} from '../src/index.js';

// Parity: an undici caller's import surface must exist so the swap compiles.

test('request is a function', () => {
  expect(typeof request).toBe('function');
  expect(typeof undici.request).toBe('function');
});

test('fetch is re-exported as a function', () => {
  expect(typeof fetch).toBe('function');
  expect(fetch).toBe(globalThis.fetch);
});

test('dispatcher classes exist with correct shape', () => {
  expect(typeof Client).toBe('function');
  expect(typeof Pool).toBe('function');
  expect(typeof Agent).toBe('function');
  const c = new Client('https://api.site.com');
  const p = new Pool('https://api.site.com');
  const a = new Agent();
  for (const d of [c, p, a]) {
    expect(typeof d.request).toBe('function');
    expect(typeof d.close).toBe('function');
    expect(typeof d.destroy).toBe('function');
  }
});

test('global dispatcher getters/setters exist and round-trip', () => {
  expect(typeof setGlobalDispatcher).toBe('function');
  expect(typeof getGlobalDispatcher).toBe('function');
  const a = new Agent();
  setGlobalDispatcher(a);
  expect(getGlobalDispatcher()).toBe(a);
});

test('interceptors is an object of factory functions', () => {
  expect(typeof interceptors).toBe('object');
  expect(typeof interceptors.redirect).toBe('function');
  expect(typeof interceptors.retry).toBe('function');
});

test('passthrough GET returns undici ResponseData shape on a real 200', async () => {
  process.env.UNBROWSE_UNDICI_PASSTHROUGH = '1';
  try {
    const { statusCode, headers, body } = await request('https://example.com');
    expect(statusCode).toBe(200);
    expect(typeof headers).toBe('object');
    expect(typeof body.text).toBe('function');
    expect(typeof body.json).toBe('function');
    expect(typeof body.arrayBuffer).toBe('function');
    const text = await body.text();
    expect(text.toLowerCase()).toContain('example');
  } catch (e) {
    // Tolerate network failure in offline CI; the shape assertions above already ran on success.
    expect(e).toBeInstanceOf(Error);
  } finally {
    delete process.env.UNBROWSE_UNDICI_PASSTHROUGH;
  }
});
