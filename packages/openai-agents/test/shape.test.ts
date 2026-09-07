import { test, expect } from 'bun:test';
import {
  unbrowseTools,
  createUnbrowseTools,
  unbrowseResolveTool,
  unbrowseExecuteTool,
  unbrowseSearchTool,
} from '../src/index';

test('unbrowseTools is an array of 3 well-shaped tools', () => {
  expect(Array.isArray(unbrowseTools)).toBe(true);
  expect(unbrowseTools.length).toBe(3);
  for (const t of unbrowseTools) {
    expect(typeof t.name).toBe('string');
    expect(t.name.length).toBeGreaterThan(0);
    expect(typeof t.description).toBe('string');
    expect(t.description.length).toBeGreaterThan(0);
    expect(typeof t.parameters).toBe('object');
    expect(t.parameters).not.toBeNull();
    expect(typeof t.execute).toBe('function');
  }
});

test('each tool is also exported individually', () => {
  expect(unbrowseTools[0]).toBe(unbrowseResolveTool);
  expect(unbrowseTools[1]).toBe(unbrowseExecuteTool);
  expect(unbrowseTools[2]).toBe(unbrowseSearchTool);
  expect(unbrowseResolveTool.name).toBe('unbrowse_resolve');
  expect(unbrowseExecuteTool.name).toBe('unbrowse_execute');
  expect(unbrowseSearchTool.name).toBe('unbrowse_search');
});

test('search tool execute returns a string offline (dryrun)', async () => {
  const prev = process.env.UNBROWSE_DRYRUN;
  try {
    process.env.UNBROWSE_DRYRUN = '1';
    const out = await unbrowseTools[2].execute({ query: 'test' });
    expect(typeof out).toBe('string');
    const parsed = JSON.parse(out);
    expect(parsed.dryrun).toBe(true);
    expect(parsed.query).toBe('test');
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_DRYRUN;
    else process.env.UNBROWSE_DRYRUN = prev;
  }
});

test('resolve + execute tools return strings offline (dryrun)', async () => {
  const prev = process.env.UNBROWSE_DRYRUN;
  try {
    process.env.UNBROWSE_DRYRUN = '1';
    const r = await unbrowseResolveTool.execute({ url: 'https://example.com', intent: 'get items' });
    expect(typeof r).toBe('string');
    expect(JSON.parse(r).ok).toBe(true);
    const e = await unbrowseExecuteTool.execute({ endpoint_id: 'abc' });
    expect(typeof e).toBe('string');
    expect(JSON.parse(e).ok).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_DRYRUN;
    else process.env.UNBROWSE_DRYRUN = prev;
  }
});

test('createUnbrowseTools is a function and builds 3 branded tools', () => {
  expect(typeof createUnbrowseTools).toBe('function');
  const tool = (def: any) => ({ ...def, __brand: 'oa' });
  const built = createUnbrowseTools({ tool });
  expect(Array.isArray(built)).toBe(true);
  expect(built.length).toBe(3);
  for (const t of built) {
    expect(t.__brand).toBe('oa');
    expect(typeof t.name).toBe('string');
    expect(typeof t.execute).toBe('function');
  }
});
