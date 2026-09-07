import { test, expect } from 'bun:test';
import Exa from '../src/index.js';

test('Exa is constructable with apiKey and baseURL', () => {
  const e = new Exa('exa-test', 'https://api.exa.ai');
  expect(e).toBeDefined();
  const e2 = new Exa();
  expect(e2).toBeDefined();
});

test('Exa instance exposes the mirrored exa-js surface', () => {
  const e = new Exa('exa-test');
  expect(typeof e.search).toBe('function');
  expect(typeof e.searchAndContents).toBe('function');
  expect(typeof e.getContents).toBe('function');
  expect(typeof e.findSimilar).toBe('function');
  expect(typeof e.findSimilarAndContents).toBe('function');
  expect(typeof e.answer).toBe('function');
});

test('search returns a results array under DRYRUN (no network)', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  try {
    const e = new Exa();
    const res = await e.search('test');
    expect(Array.isArray(res.results)).toBe(true);
    expect(res.results.length).toBe(0);
  } finally {
    delete process.env.UNBROWSE_DRYRUN;
  }
});

test('searchAndContents returns the results shape under DRYRUN', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  try {
    const e = new Exa();
    const res = await e.searchAndContents('test', { numResults: 3 });
    expect(Array.isArray(res.results)).toBe(true);
  } finally {
    delete process.env.UNBROWSE_DRYRUN;
  }
});

test('getContents and findSimilar return results arrays under DRYRUN', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  try {
    const e = new Exa();
    const c = await e.getContents(['https://example.com']);
    expect(Array.isArray(c.results)).toBe(true);
    const s = await e.findSimilar('https://example.com');
    expect(Array.isArray(s.results)).toBe(true);
  } finally {
    delete process.env.UNBROWSE_DRYRUN;
  }
});

test('answer returns { answer, citations } shape under DRYRUN', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  try {
    const e = new Exa();
    const a = await e.answer('test');
    expect(typeof a.answer).toBe('string');
    expect(Array.isArray(a.citations)).toBe(true);
  } finally {
    delete process.env.UNBROWSE_DRYRUN;
  }
});
