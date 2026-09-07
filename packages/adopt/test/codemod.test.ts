import { test, expect } from 'bun:test';
import { adoptSource, summarize, DROP_IN_MAP } from '../src/index.js';

// The witness: the adopter rewrites every supported upstream import to its drop-in,
// in the source's own syntax, and leaves everything else exactly as it was.

test('rewrites a default ESM import (axios)', () => {
  const { source, rewrites } = adoptSource(`import axios from 'axios';`);
  expect(source).toBe(`import axios from '@unbrowse/axios-shim';`);
  expect(rewrites).toHaveLength(1);
  expect(rewrites[0]).toMatchObject({ from: 'axios', to: '@unbrowse/axios-shim' });
});

test('rewrites named + namespace imports, preserving the binding', () => {
  expect(adoptSource(`import { chromium } from "playwright";`).source).toBe(`import { chromium } from "@unbrowse/playwright-shim";`);
  expect(adoptSource(`import * as pup from 'puppeteer';`).source).toBe(`import * as pup from '@unbrowse/puppeteer-shim';`);
});

test('rewrites CommonJS require and dynamic import', () => {
  expect(adoptSource(`const got = require('got');`).source).toBe(`const got = require('@unbrowse/got-shim');`);
  expect(adoptSource(`const ky = await import("ky");`).source).toBe(`const ky = await import("@unbrowse/ky-shim");`);
});

test('rewrites scoped upstreams (firecrawl, stagehand)', () => {
  expect(adoptSource(`import Firecrawl from '@mendable/firecrawl-js';`).source).toBe(`import Firecrawl from '@unbrowse/firecrawl-shim';`);
  expect(adoptSource(`import { Stagehand } from '@browserbasehq/stagehand';`).source).toBe(`import { Stagehand } from '@unbrowse/stagehand-shim';`);
});

test('preserves quote style', () => {
  expect(adoptSource(`import fetch from "node-fetch";`).source).toBe(`import fetch from "@unbrowse/node-fetch-shim";`);
  expect(adoptSource(`import fetch from 'cross-fetch';`).source).toBe(`import fetch from '@unbrowse/cross-fetch-shim';`);
});

test('EVERY supported specifier in the map is rewritten on a real-ish file', () => {
  const specs = Object.keys(DROP_IN_MAP);
  const file = specs.map((s, i) => `import x${i} from '${s}';`).join('\n');
  const { source, rewrites } = adoptSource(file);
  expect(rewrites).toHaveLength(specs.length);
  for (const s of specs) {
    expect(source).toContain(`'${DROP_IN_MAP[s]}'`);
    // the bare upstream specifier must no longer appear as an import target
    expect(source).not.toContain(`from '${s}';`);
  }
});

test('leaves unsupported imports untouched (no false positives)', () => {
  const src = [
    `import _ from 'lodash';`,
    `import React from 'react';`,
    `import { axiosRetry } from 'axios-retry';`, // substring of axios, must NOT match
    `import x from './axios';`,                   // local path, must NOT match
  ].join('\n');
  const { source, rewrites } = adoptSource(src);
  expect(rewrites).toHaveLength(0);
  expect(source).toBe(src);
});

test('is idempotent — running twice does not double-rewrite', () => {
  const once = adoptSource(`import axios from 'axios';`).source;
  const twice = adoptSource(once);
  expect(twice.source).toBe(once);
  expect(twice.rewrites).toHaveLength(0);
});

test('summary names the swaps for a PR body', () => {
  const r = adoptSource(`import axios from 'axios';\nimport got from 'got';`);
  const text = summarize([{ path: 'a.ts', result: r }]);
  expect(text).toContain('axios → @unbrowse/axios-shim');
  expect(text).toContain('got → @unbrowse/got-shim');
  expect(text.toLowerCase()).toContain('fallback'); // upstream attributed as the fallback
});
