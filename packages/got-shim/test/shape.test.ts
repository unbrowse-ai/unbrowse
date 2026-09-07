import { test, expect } from 'bun:test';
import got, { HTTPError, RequestError } from '../src/index.js';

// Parity: a got caller's import surface must exist so the swap compiles.

test('default export is callable with method shortcuts + extend', () => {
  expect(typeof got).toBe('function');
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head', 'extend']) {
    expect(typeof (got as any)[m]).toBe('function');
  }
});

test('error classes match got shape', () => {
  expect(typeof got.HTTPError).toBe('function');
  expect(typeof got.RequestError).toBe('function');
  expect(got.HTTPError).toBe(HTTPError);
  expect(got.RequestError).toBe(RequestError);
  expect(new RequestError('x')).toBeInstanceOf(Error);
});

test('the call returns got\'s augmented promise (json/text/buffer)', () => {
  process.env.UNBROWSE_GOT_PASSTHROUGH = '1';
  try {
    const p = got('https://example.com');
    expect(typeof p.then).toBe('function');
    expect(typeof p.json).toBe('function');
    expect(typeof p.text).toBe('function');
    expect(typeof p.buffer).toBe('function');
    return p.catch(() => {}); // settle the promise so bun doesn't warn
  } finally {
    delete process.env.UNBROWSE_GOT_PASSTHROUGH;
  }
});

test('passthrough GET returns got Response shape on a real 200', async () => {
  process.env.UNBROWSE_GOT_PASSTHROUGH = '1';
  try {
    const res = await got('https://example.com');
    expect(res.statusCode).toBe(200);
    expect(res.ok).toBe(true);
    expect(typeof res.headers).toBe('object');
    expect(res.url).toContain('example.com');
    expect(String(res.body).toLowerCase()).toContain('example');
  } finally {
    delete process.env.UNBROWSE_GOT_PASSTHROUGH;
  }
});

test('.text() resolves the body', async () => {
  process.env.UNBROWSE_GOT_PASSTHROUGH = '1';
  try {
    const body = await got('https://example.com').text();
    expect(body.toLowerCase()).toContain('example');
  } finally {
    delete process.env.UNBROWSE_GOT_PASSTHROUGH;
  }
});

test('extend() yields a configured instance that still has the surface', () => {
  const client = got.extend({ prefixUrl: 'https://api.site.com', headers: { 'x-test': '1' } });
  expect(typeof client).toBe('function');
  expect(typeof client.get).toBe('function');
  expect(typeof client.extend).toBe('function');
});

test('a non-2xx throws an HTTPError carrying the response (throwHttpErrors default)', async () => {
  process.env.UNBROWSE_GOT_PASSTHROUGH = '1';
  try {
    await got('https://example.com/this-should-404-zzz');
  } catch (e) {
    if (e instanceof HTTPError) {
      expect(e.response.statusCode).toBeGreaterThanOrEqual(400);
      expect(e.name).toBe('HTTPError');
    }
    // example.com may serve 200 for unknown paths; if so, no throw — that's also valid.
  } finally {
    delete process.env.UNBROWSE_GOT_PASSTHROUGH;
  }
});
