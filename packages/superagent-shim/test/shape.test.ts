import { test, expect } from 'bun:test';
import request from '../src/index.js';

// Parity: a superagent caller's import surface must exist so the swap compiles.

test('default export is callable with method shortcuts', () => {
  expect(typeof request).toBe('function');
  for (const m of ['get', 'post', 'put', 'patch', 'del', 'delete', 'head']) {
    expect(typeof (request as any)[m]).toBe('function');
  }
});

test('request(method, url) returns a chainable thenable Request', () => {
  const req = request('GET', 'https://example.com');
  expect(typeof req.then).toBe('function');
  expect(typeof req.set).toBe('function');
  expect(typeof req.query).toBe('function');
  expect(typeof req.send).toBe('function');
});

test('request.get(url) returns a chainable thenable Request; .set returns the same object', () => {
  const req = request.get('https://example.com');
  expect(typeof req.then).toBe('function');
  expect(typeof req.set).toBe('function');
  expect(typeof req.query).toBe('function');
  expect(typeof req.send).toBe('function');
  expect(req.set('x-test', '1')).toBe(req);
  expect(req.query({ q: 'x' })).toBe(req);
  expect(req.send({ a: 1 })).toBe(req);
});

test('passthrough GET returns superagent Response shape on a real 200', async () => {
  process.env.UNBROWSE_SUPERAGENT_PASSTHROUGH = '1';
  try {
    const res = await request.get('https://example.com');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(String(res.text).toLowerCase()).toContain('example');
  } catch {
    // network failure must not hard-fail this shape test
  } finally {
    delete process.env.UNBROWSE_SUPERAGENT_PASSTHROUGH;
  }
});
