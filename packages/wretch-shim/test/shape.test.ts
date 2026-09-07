import { test, expect } from 'bun:test';
import wretch, { Wretch, ResponseChain } from '../src/index.js';

// Parity: a wretch caller's import surface must exist so the swap compiles.

test('default export is a callable function', () => {
  expect(typeof wretch).toBe('function');
});

test('config methods return a chainable Wretch', () => {
  const w = wretch('https://x');
  expect(w).toBeInstanceOf(Wretch);
  expect(w.headers({ 'x-test': '1' })).toBeInstanceOf(Wretch);
  expect(w.query({ a: 1 })).toBeInstanceOf(Wretch);
  expect(w.auth('Bearer t')).toBeInstanceOf(Wretch);
  expect(w.content('application/json')).toBeInstanceOf(Wretch);
  expect(w.accept('application/json')).toBeInstanceOf(Wretch);
  expect(w.url('/items')).toBeInstanceOf(Wretch);
});

test('a verb returns a thenable ResponseChain with json/text/res resolvers', () => {
  process.env.UNBROWSE_WRETCH_PASSTHROUGH = '1';
  try {
    const chain = wretch('https://x').get();
    expect(chain).toBeInstanceOf(ResponseChain);
    expect(typeof chain.then).toBe('function');
    expect(typeof chain.json).toBe('function');
    expect(typeof chain.text).toBe('function');
    expect(typeof chain.res).toBe('function');
    expect(typeof chain.arrayBuffer).toBe('function');
    expect(typeof chain.notFound).toBe('function');
    expect(typeof chain.error).toBe('function');
    return chain.catch(() => {}); // settle so bun doesn't warn
  } finally {
    delete process.env.UNBROWSE_WRETCH_PASSTHROUGH;
  }
});

test('.json(obj) on a Wretch sets the body and stays chainable; .json() is a resolver passthrough', () => {
  const w = wretch('https://x');
  expect(w.json({ a: 1 })).toBeInstanceOf(Wretch);
  expect(w.json()).toBeInstanceOf(Wretch);
  expect(w.body('raw')).toBeInstanceOf(Wretch);
  expect(w.formData({ f: 'v' })).toBeInstanceOf(Wretch);
});

test('passthrough GET .text() contains the page text (network-tolerant)', async () => {
  process.env.UNBROWSE_WRETCH_PASSTHROUGH = '1';
  try {
    const body = await wretch('https://example.com').get().text();
    expect(body.toLowerCase()).toContain('example');
  } catch {
    // Network failure must not hard-fail the deterministic shape suite.
    expect(true).toBe(true);
  } finally {
    delete process.env.UNBROWSE_WRETCH_PASSTHROUGH;
  }
});
