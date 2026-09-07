import { test, expect } from 'bun:test';
import {
  unbrowseTools,
  unbrowse_resolve,
  unbrowse_execute,
  unbrowse_search,
  createUnbrowseTools,
} from '../src/index';

const KEYS = ['unbrowse_resolve', 'unbrowse_execute', 'unbrowse_search'] as const;

test('unbrowseTools has the three tool keys', () => {
  expect(Object.keys(unbrowseTools).sort()).toEqual([...KEYS].sort());
});

test('each tool has string description, object inputSchema, function execute', () => {
  for (const key of KEYS) {
    const t = unbrowseTools[key];
    expect(typeof t.description).toBe('string');
    expect(t.description.length).toBeGreaterThan(0);
    expect(typeof t.inputSchema).toBe('object');
    expect(t.inputSchema).not.toBeNull();
    expect(typeof t.inputSchema.type).toBe('string');
    expect(typeof t.execute).toBe('function');
  }
});

test('named exports match the record entries', () => {
  expect(unbrowse_resolve).toBe(unbrowseTools.unbrowse_resolve);
  expect(unbrowse_execute).toBe(unbrowseTools.unbrowse_execute);
  expect(unbrowse_search).toBe(unbrowseTools.unbrowse_search);
});

test('inputSchemas declare the expected props', () => {
  expect(unbrowse_resolve.inputSchema.properties).toHaveProperty('url');
  expect(unbrowse_resolve.inputSchema.properties).toHaveProperty('intent');
  expect(unbrowse_execute.inputSchema.properties).toHaveProperty('endpoint_id');
  expect(unbrowse_execute.inputSchema.properties).toHaveProperty('params');
  expect(unbrowse_search.inputSchema.properties).toHaveProperty('query');
  expect(unbrowse_search.inputSchema.properties).toHaveProperty('url');
});

test('DRYRUN: unbrowse_search.execute returns a defined result offline', async () => {
  const prev = process.env.UNBROWSE_DRYRUN;
  try {
    process.env.UNBROWSE_DRYRUN = '1';
    const result = await unbrowseTools.unbrowse_search.execute({ query: 'test' });
    expect(result).toBeDefined();
    expect(result.query).toBe('test');
    expect(result.ok).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_DRYRUN;
    else process.env.UNBROWSE_DRYRUN = prev;
  }
});

test('DRYRUN: resolve + execute return defined results offline', async () => {
  const prev = process.env.UNBROWSE_DRYRUN;
  try {
    process.env.UNBROWSE_DRYRUN = '1';
    const r = await unbrowse_resolve.execute({ url: 'https://example.com', intent: 'find x' });
    expect(r).toBeDefined();
    expect(Array.isArray(r.endpoints)).toBe(true);
    expect(r.endpoints.length).toBeGreaterThan(0);

    const e = await unbrowse_execute.execute({ endpoint_id: 'dryrun-endpoint-0' });
    expect(e).toBeDefined();
    expect(e.ok).toBe(true);
    expect(e.endpoint_id).toBe('dryrun-endpoint-0');
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_DRYRUN;
    else process.env.UNBROWSE_DRYRUN = prev;
  }
});

test('createUnbrowseTools is a function and returns three branded tools', () => {
  const fakeTool = (def: any) => ({ ...def, __brand: 'tool' });
  const fakeJsonSchema = (s: any) => s;
  expect(typeof createUnbrowseTools).toBe('function');
  const tools = createUnbrowseTools({ tool: fakeTool, jsonSchema: fakeJsonSchema });
  expect(Object.keys(tools).sort()).toEqual([...KEYS].sort());
  for (const key of KEYS) {
    expect(tools[key].__brand).toBe('tool');
    expect(typeof tools[key].description).toBe('string');
    expect(typeof tools[key].execute).toBe('function');
  }
});

test('createUnbrowseTools throws without real helpers', () => {
  expect(() => createUnbrowseTools({} as any)).toThrow();
});
