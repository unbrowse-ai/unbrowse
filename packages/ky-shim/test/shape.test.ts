import { test, expect } from 'bun:test';
import ky, { HTTPError, TimeoutError } from '../src/index.js';

// Parity: a ky caller's import surface must exist so the swap compiles.

test('default export is callable with method shortcuts + create/extend', () => {
  expect(typeof ky).toBe('function');
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head', 'create', 'extend']) {
    expect(typeof (ky as any)[m]).toBe('function');
  }
});

test('error classes match ky shape', () => {
  expect(ky.HTTPError).toBe(HTTPError);
  expect(ky.TimeoutError).toBe(TimeoutError);
  expect(new TimeoutError()).toBeInstanceOf(Error);
});

test('the call returns ky\'s ResponsePromise (json/text/blob/arrayBuffer/formData)', () => {
  process.env.UNBROWSE_KY_PASSTHROUGH = '1';
  try {
    const p = ky('https://example.com');
    expect(typeof p.then).toBe('function');
    for (const m of ['json', 'text', 'blob', 'arrayBuffer', 'formData']) {
      expect(typeof (p as any)[m]).toBe('function');
    }
    return p.catch(() => {});
  } finally {
    delete process.env.UNBROWSE_KY_PASSTHROUGH;
  }
});

test('passthrough GET resolves to a real fetch Response (200)', async () => {
  process.env.UNBROWSE_KY_PASSTHROUGH = '1';
  try {
    const res = await ky('https://example.com');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    const body = await res.text();
    expect(body.toLowerCase()).toContain('example');
  } finally {
    delete process.env.UNBROWSE_KY_PASSTHROUGH;
  }
});

test('.text() resolves the body without consuming the caller\'s response', async () => {
  process.env.UNBROWSE_KY_PASSTHROUGH = '1';
  try {
    const body = await ky('https://example.com').text();
    expect(body.toLowerCase()).toContain('example');
  } finally {
    delete process.env.UNBROWSE_KY_PASSTHROUGH;
  }
});

test('create() and extend() yield configured instances with the full surface', () => {
  const a = ky.create({ prefixUrl: 'https://api.site.com' });
  const b = a.extend({ headers: { 'x-test': '1' } });
  expect(typeof a.get).toBe('function');
  expect(typeof b.post).toBe('function');
  expect(typeof b.extend).toBe('function');
});
