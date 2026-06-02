import { test, expect } from 'bun:test';
import fetchDefault, { fetch as namedFetch, Headers, Request, Response } from '../src/index.js';

// Parity: cross-fetch's import surface (default fetch + named primitives).

test('default and named fetch are the same function', () => {
  expect(typeof fetchDefault).toBe('function');
  expect(typeof namedFetch).toBe('function');
  expect(fetchDefault).toBe(namedFetch);
});

test('re-exports the fetch primitives cross-fetch exposes', () => {
  expect(Headers).toBe(globalThis.Headers);
  expect(Request).toBe(globalThis.Request);
  expect(Response).toBe(globalThis.Response);
});

test('passthrough GET is an exact native-fetch pass-through (real 200)', async () => {
  process.env.UNBROWSE_CROSS_FETCH_PASSTHROUGH = '1';
  try {
    const res = await fetchDefault('https://example.com');
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain('example');
  } finally {
    delete process.env.UNBROWSE_CROSS_FETCH_PASSTHROUGH;
  }
});

test('non-GET is a pure pass-through (no synthesized cache Response)', async () => {
  const res = await fetchDefault('https://example.com', { method: 'POST' });
  expect(res.headers.get('x-unbrowse-source')).toBeNull();
});
