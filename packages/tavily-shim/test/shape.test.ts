import { test, expect } from 'bun:test';
import { tavily } from '../src/index.js';
import defaultExport from '../src/index.js';

test('tavily is a factory function', () => {
  expect(typeof tavily).toBe('function');
});

test('default export carries the named tavily factory', () => {
  expect(typeof defaultExport.tavily).toBe('function');
});

test('tavily({apiKey}) returns a client with the public method surface', () => {
  const c = tavily({ apiKey: 'tvly-test' });
  expect(typeof c.search).toBe('function');
  expect(typeof c.searchQNA).toBe('function');
  expect(typeof c.qnaSearch).toBe('function');
  expect(typeof c.searchContext).toBe('function');
  expect(typeof c.extract).toBe('function');
});

test('search returns a SearchResponse with results array (dryrun, no network)', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  try {
    const c = tavily({ apiKey: 'tvly-test' });
    const res = await c.search('test');
    expect(res.query).toBe('test');
    expect(Array.isArray(res.results)).toBe(true);
  } finally {
    delete process.env.UNBROWSE_DRYRUN;
  }
});

test('searchContext returns a string (dryrun, no network)', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  try {
    const c = tavily({ apiKey: 'tvly-test' });
    const ctx = await c.searchContext('test');
    expect(typeof ctx).toBe('string');
  } finally {
    delete process.env.UNBROWSE_DRYRUN;
  }
});

test('extract returns ExtractResponse shape (dryrun, no network)', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  try {
    const c = tavily({ apiKey: 'tvly-test' });
    const out = await c.extract(['https://nowhere.invalid/x']);
    expect(Array.isArray(out.results)).toBe(true);
    expect(Array.isArray(out.failedResults)).toBe(true);
  } finally {
    delete process.env.UNBROWSE_DRYRUN;
  }
});
