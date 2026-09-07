import { test, expect } from 'bun:test';
import {
  unbrowseTools,
  unbrowse_resolve,
  unbrowse_execute,
  unbrowse_search,
  createUnbrowseTools,
} from '../src/index';

test('unbrowseTools has 3 tools with the right runtime shape', () => {
  const ids = Object.keys(unbrowseTools);
  expect(ids.length).toBe(3);
  expect(ids.sort()).toEqual(['unbrowse_execute', 'unbrowse_resolve', 'unbrowse_search']);

  for (const tool of Object.values(unbrowseTools)) {
    expect(typeof tool.id).toBe('string');
    expect(tool.id.length).toBeGreaterThan(0);
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(typeof tool.inputSchema).toBe('object');
    expect(tool.inputSchema).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  }
});

test('individual tool exports match the record entries', () => {
  expect(unbrowse_resolve).toBe(unbrowseTools.unbrowse_resolve);
  expect(unbrowse_execute).toBe(unbrowseTools.unbrowse_execute);
  expect(unbrowse_search).toBe(unbrowseTools.unbrowse_search);
});

test('search executes offline via DRYRUN with {context} envelope', async () => {
  const prev = process.env.UNBROWSE_DRYRUN;
  try {
    process.env.UNBROWSE_DRYRUN = '1';
    const res = await unbrowseTools.unbrowse_search.execute({ context: { query: 'test' } });
    expect(res).toBeDefined();
    expect(res).not.toBeNull();
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_DRYRUN;
    else process.env.UNBROWSE_DRYRUN = prev;
  }
});

test('search executes offline via DRYRUN with raw args (no context)', async () => {
  const prev = process.env.UNBROWSE_DRYRUN;
  try {
    process.env.UNBROWSE_DRYRUN = '1';
    const res = await unbrowseTools.unbrowse_search.execute({ query: 'test' });
    expect(res).toBeDefined();
    expect(res).not.toBeNull();
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_DRYRUN;
    else process.env.UNBROWSE_DRYRUN = prev;
  }
});

test('resolve + execute run offline via DRYRUN', async () => {
  const prev = process.env.UNBROWSE_DRYRUN;
  try {
    process.env.UNBROWSE_DRYRUN = '1';
    const resolved: any = await unbrowse_resolve.execute({ context: { url: 'https://example.com', intent: 'get data' } });
    expect(resolved).toBeDefined();
    const id = resolved?.available_operations?.[0]?.endpoint_id;
    expect(typeof id).toBe('string');
    const exec = await unbrowse_execute.execute({ context: { endpoint_id: id, params: { a: 1 } } });
    expect(exec).toBeDefined();
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_DRYRUN;
    else process.env.UNBROWSE_DRYRUN = prev;
  }
});

test('createUnbrowseTools is a factory returning 3 branded Mastra tools', () => {
  expect(typeof createUnbrowseTools).toBe('function');
  const fakeCreateTool = (def: any) => ({ ...def, __brand: 'mastra' });
  const tools = createUnbrowseTools({ createTool: fakeCreateTool });
  const vals = Object.values(tools) as any[];
  expect(vals.length).toBe(3);
  for (const t of vals) {
    expect(t.__brand).toBe('mastra');
    expect(typeof t.id).toBe('string');
    expect(typeof t.execute).toBe('function');
  }
});
