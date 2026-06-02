import { test, expect } from 'bun:test';
import {
  unbrowseTools,
  createUnbrowseTools,
  unbrowseResolveTool,
  unbrowseExecuteTool,
  unbrowseSearchTool,
} from '../src/index.ts';

test('unbrowseTools is an array of 3 FunctionTool-shaped objects', () => {
  expect(Array.isArray(unbrowseTools)).toBe(true);
  expect(unbrowseTools.length).toBe(3);
  for (const t of unbrowseTools) {
    expect(typeof t.metadata.name).toBe('string');
    expect(t.metadata.name.length).toBeGreaterThan(0);
    expect(typeof t.metadata.description).toBe('string');
    expect(t.metadata.description.length).toBeGreaterThan(0);
    expect(typeof t.metadata.parameters).toBe('object');
    expect(t.metadata.parameters).not.toBeNull();
    expect(typeof t.call).toBe('function');
  }
});

test('the three tools are exported individually with the expected names', () => {
  expect(unbrowseResolveTool.metadata.name).toBe('unbrowse_resolve');
  expect(unbrowseExecuteTool.metadata.name).toBe('unbrowse_execute');
  expect(unbrowseSearchTool.metadata.name).toBe('unbrowse_search');
  expect(unbrowseTools).toContain(unbrowseResolveTool);
  expect(unbrowseTools).toContain(unbrowseExecuteTool);
  expect(unbrowseTools).toContain(unbrowseSearchTool);
});

test('search tool call returns a string under UNBROWSE_DRYRUN offline', async () => {
  const prev = process.env.UNBROWSE_DRYRUN;
  try {
    process.env.UNBROWSE_DRYRUN = '1';
    const out = await unbrowseTools[2].call({ query: 'test' });
    expect(typeof out).toBe('string');
    const parsed = JSON.parse(out);
    expect(parsed.query).toBe('test');
    expect(parsed.ok).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_DRYRUN;
    else process.env.UNBROWSE_DRYRUN = prev;
  }
});

test('resolve + execute tool calls return strings under UNBROWSE_DRYRUN offline', async () => {
  const prev = process.env.UNBROWSE_DRYRUN;
  try {
    process.env.UNBROWSE_DRYRUN = '1';
    const r = await unbrowseResolveTool.call({ url: 'https://example.com', intent: 'list items' });
    expect(typeof r).toBe('string');
    expect(JSON.parse(r).dryrun).toBe(true);
    const e = await unbrowseExecuteTool.call({ endpoint_id: 'dryrun-endpoint-0', params: { a: 1 } });
    expect(typeof e).toBe('string');
    expect(JSON.parse(e).ok).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_DRYRUN;
    else process.env.UNBROWSE_DRYRUN = prev;
  }
});

test('createUnbrowseTools is a factory returning real FunctionTool instances', () => {
  expect(typeof createUnbrowseTools).toBe('function');
  const FunctionTool = { from: (fn: any, md: any) => ({ metadata: md, call: fn, __brand: 'li' }) };
  const tools = createUnbrowseTools({ FunctionTool });
  expect(Array.isArray(tools)).toBe(true);
  expect(tools.length).toBe(3);
  for (const t of tools) {
    expect(t.__brand).toBe('li');
    expect(typeof t.metadata.name).toBe('string');
    expect(typeof t.call).toBe('function');
  }
});
