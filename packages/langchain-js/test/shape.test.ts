import { test, expect } from 'bun:test';
import {
  unbrowseTools,
  createUnbrowseTools,
  unbrowseResolveTool,
  unbrowseExecuteTool,
  unbrowseSearchTool,
} from '../src/index.ts';

test('unbrowseTools is an array of 3 LangChain-shaped tools', () => {
  expect(Array.isArray(unbrowseTools)).toBe(true);
  expect(unbrowseTools.length).toBe(3);
  for (const t of unbrowseTools) {
    expect(typeof t.name).toBe('string');
    expect(t.name.length).toBeGreaterThan(0);
    expect(typeof t.description).toBe('string');
    expect(t.description.length).toBeGreaterThan(0);
    expect(typeof t.schema).toBe('object');
    expect(t.schema).not.toBeNull();
    expect(typeof t.invoke).toBe('function');
    expect(typeof t.call).toBe('function');
  }
});

test('individually exported tools are the same three', () => {
  expect(unbrowseTools[0]).toBe(unbrowseResolveTool);
  expect(unbrowseTools[1]).toBe(unbrowseExecuteTool);
  expect(unbrowseTools[2]).toBe(unbrowseSearchTool);
  expect(unbrowseTools.map((t) => t.name)).toEqual([
    'unbrowse_resolve',
    'unbrowse_execute',
    'unbrowse_search',
  ]);
});

test('search tool returns a string under dryrun (offline, no network)', async () => {
  const prev = process.env.UNBROWSE_DRYRUN;
  try {
    process.env.UNBROWSE_DRYRUN = '1';
    const out = await unbrowseTools[2].invoke({ query: 'test' });
    expect(typeof out).toBe('string');
    const parsed = JSON.parse(out);
    expect(parsed.dryrun).toBe(true);
    expect(parsed.query).toBe('test');

    // call alias also returns a string offline
    const out2 = await unbrowseTools[0].call({ url: 'https://example.com' });
    expect(typeof out2).toBe('string');
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_DRYRUN;
    else process.env.UNBROWSE_DRYRUN = prev;
  }
});

test('createUnbrowseTools is a function and returns 3 branded tools', async () => {
  expect(typeof createUnbrowseTools).toBe('function');
  const fakeTool = (fn: any, cfg: any) => ({ ...cfg, invoke: fn, call: fn, __brand: 'lc' });
  const tools = createUnbrowseTools({ tool: fakeTool });
  expect(Array.isArray(tools)).toBe(true);
  expect(tools.length).toBe(3);
  for (const t of tools) {
    expect(t.__brand).toBe('lc');
    expect(typeof t.name).toBe('string');
    expect(typeof t.description).toBe('string');
    expect(typeof t.schema).toBe('object');
    expect(typeof t.invoke).toBe('function');
  }
  expect(tools.map((t: any) => t.name)).toEqual([
    'unbrowse_resolve',
    'unbrowse_execute',
    'unbrowse_search',
  ]);

  // branded tool fn still produces a string offline
  const prev = process.env.UNBROWSE_DRYRUN;
  try {
    process.env.UNBROWSE_DRYRUN = '1';
    const out = await tools[1].invoke({ endpoint_id: 'x' });
    expect(typeof out).toBe('string');
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_DRYRUN;
    else process.env.UNBROWSE_DRYRUN = prev;
  }
});
