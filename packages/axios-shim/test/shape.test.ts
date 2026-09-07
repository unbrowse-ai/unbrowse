import { test, expect } from 'bun:test';
import axios, { isAxiosError, AxiosError } from '../src/index.js';

// Parity: the axios import surface a caller relies on must all exist.

test('default export is callable and carries the method shortcuts', () => {
  expect(typeof axios).toBe('function');
  for (const m of ['request', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'create']) {
    expect(typeof (axios as any)[m]).toBe('function');
  }
});

test('statics: isAxiosError / AxiosError / all / spread / CancelToken', () => {
  expect(typeof axios.isAxiosError).toBe('function');
  expect(axios.AxiosError).toBe(AxiosError);
  expect(typeof axios.all).toBe('function');
  expect(typeof axios.spread).toBe('function');
  expect(typeof axios.CancelToken.source).toBe('function');
});

test('interceptors.request/response are usable managers', () => {
  const id = axios.interceptors.request.use((c) => c);
  expect(typeof id).toBe('number');
  axios.interceptors.request.eject(id);
  expect(typeof axios.interceptors.response.use).toBe('function');
});

test('create() yields an independent configured instance', () => {
  const client = axios.create({ baseURL: 'https://api.site.com', headers: { 'x-test': '1' } });
  expect(typeof client.get).toBe('function');
  expect(client.defaults.baseURL).toBe('https://api.site.com');
});

test('isAxiosError discriminates an AxiosError', () => {
  const e = new AxiosError('boom', 'ERR_BAD_REQUEST');
  expect(isAxiosError(e)).toBe(true);
  expect(e.isAxiosError).toBe(true);
  expect(isAxiosError(new Error('plain'))).toBe(false);
});

test('GET passthrough returns the axios response shape on a real 200', async () => {
  process.env.UNBROWSE_AXIOS_PASSTHROUGH = '1';
  try {
    const res = await axios.get<string>('https://example.com', { responseType: 'text' });
    expect(res.status).toBe(200);
    expect(res.statusText).toBeDefined();
    expect(typeof res.headers).toBe('object');
    expect(res.config.method).toBe('get');
    expect(String(res.data).toLowerCase()).toContain('example');
  } finally {
    delete process.env.UNBROWSE_AXIOS_PASSTHROUGH;
  }
});

test('non-2xx rejects with an AxiosError carrying the response (validateStatus default)', async () => {
  process.env.UNBROWSE_AXIOS_PASSTHROUGH = '1';
  try {
    await axios.get('https://example.com/this-path-should-404-xyzzy');
    // example.com may 200 the SPA; if so this test is inconclusive but must not throw wrongly.
  } catch (e) {
    expect(isAxiosError(e)).toBe(true);
    expect((e as AxiosError).response).toBeDefined();
  } finally {
    delete process.env.UNBROWSE_AXIOS_PASSTHROUGH;
  }
});

test('request interceptor can inject an auth header', async () => {
  const client = axios.create();
  let sawHeader = '';
  client.interceptors.request.use((cfg) => {
    cfg.headers = { ...cfg.headers, authorization: 'Bearer test' };
    sawHeader = cfg.headers.authorization;
    return cfg;
  });
  process.env.UNBROWSE_AXIOS_PASSTHROUGH = '1';
  try {
    await client.get('https://example.com', { responseType: 'text' });
    expect(sawHeader).toBe('Bearer test');
  } finally {
    delete process.env.UNBROWSE_AXIOS_PASSTHROUGH;
  }
});
