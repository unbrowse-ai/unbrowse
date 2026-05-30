import { test, expect } from 'bun:test';
import fetchDefault, {
  fetch as namedFetch,
  Headers,
  Request,
  Response,
  Blob,
  FormData,
  FetchError,
  AbortError,
  isRedirect,
} from '../src/index.js';

// Parity: the public surface a node-fetch caller imports by name must all exist
// and be the right kind, so `- import ... from 'node-fetch'` swaps cleanly.

test('default export is the fetch function', () => {
  expect(typeof fetchDefault).toBe('function');
  expect(typeof namedFetch).toBe('function');
  expect(fetchDefault).toBe(namedFetch);
});

test('re-exports the request/response primitives node-fetch exposes', () => {
  expect(Headers).toBe(globalThis.Headers);
  expect(Request).toBe(globalThis.Request);
  expect(Response).toBe(globalThis.Response);
  expect(typeof Blob).toBe('function');
  expect(typeof FormData).toBe('function');
});

test('FetchError carries node-fetch shape (name/type/code)', () => {
  const e = new FetchError('boom', 'system', { code: 'ECONNRESET' });
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe('FetchError');
  expect(e.type).toBe('system');
  expect(e.code).toBe('ECONNRESET');
});

test('AbortError matches node-fetch shape', () => {
  const e = new AbortError();
  expect(e.name).toBe('AbortError');
  expect(e.type).toBe('aborted');
});

test('isRedirect mirrors node-fetch redirect codes', () => {
  for (const c of [301, 302, 303, 307, 308]) expect(isRedirect(c)).toBe(true);
  expect(isRedirect(200)).toBe(false);
  expect(isRedirect(404)).toBe(false);
});

test('passthrough mode is an exact native-fetch pass-through (real GET 200)', async () => {
  process.env.UNBROWSE_NODE_FETCH_PASSTHROUGH = '1';
  try {
    const res = await fetchDefault('https://example.com');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.toLowerCase()).toContain('example');
  } finally {
    delete process.env.UNBROWSE_NODE_FETCH_PASSTHROUGH;
  }
});

test('non-GET is a pure pass-through (no routing attempt)', async () => {
  // POST to example.com returns a real status from native fetch, never a
  // synthesized marketplace-cache Response.
  const res = await fetchDefault('https://example.com', { method: 'POST' });
  expect(res.headers.get('x-unbrowse-source')).toBeNull();
});
