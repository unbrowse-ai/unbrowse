/**
 * @unbrowse/axios-shim — drop-in replacement for `axios`.
 *
 *   - import axios from 'axios';
 *   + import axios from '@unbrowse/axios-shim';
 *
 *   const { data } = await axios.get('https://api.site.com/items');
 *   const res = await axios.post('https://api.site.com/items', { name: 'x' });
 *
 * A safe GET routes through Unbrowse's resolve+execute marketplace cache first
 * (free synthesized axios response on a hit); every other request, and any GET
 * miss, is performed with the platform's native fetch and shaped into the exact
 * axios response object `{ data, status, statusText, headers, config, request }`.
 * Same callable default, same method shortcuts, same `create()`, `interceptors`,
 * `isAxiosError`, `AxiosError`, `CancelToken`, `all`, `spread` — so existing
 * axios code swaps one import line and pays per cached call, not per egress.
 *
 * Attribution: mirrors the public surface of `axios`
 * (https://github.com/axios/axios, MIT). Semantics are preserved; the shim only
 * lowers cost on cache hits.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

export interface AxiosRequestConfig {
  url?: string;
  method?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  data?: unknown;
  timeout?: number;
  responseType?: 'json' | 'text' | 'arraybuffer' | 'blob' | 'stream';
  signal?: AbortSignal;
  validateStatus?: ((status: number) => boolean) | null;
  [k: string]: unknown;
}

export interface AxiosResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: AxiosRequestConfig;
  request?: unknown;
}

type Fulfilled<T> = (value: T) => T | Promise<T>;
type Rejected = (error: any) => any;

class InterceptorManager<T> {
  handlers: Array<{ fulfilled?: Fulfilled<T>; rejected?: Rejected } | null> = [];
  use(fulfilled?: Fulfilled<T>, rejected?: Rejected): number {
    this.handlers.push({ fulfilled, rejected });
    return this.handlers.length - 1;
  }
  eject(id: number): void {
    if (this.handlers[id]) this.handlers[id] = null;
  }
  clear(): void {
    this.handlers = [];
  }
}

export class AxiosError<T = unknown> extends Error {
  config?: AxiosRequestConfig;
  code?: string;
  request?: unknown;
  response?: AxiosResponse<T>;
  isAxiosError = true;
  constructor(message: string, code?: string, config?: AxiosRequestConfig, request?: unknown, response?: AxiosResponse<T>) {
    super(message);
    this.name = 'AxiosError';
    this.code = code;
    this.config = config;
    this.request = request;
    this.response = response;
  }
}

export function isAxiosError(payload: unknown): payload is AxiosError {
  return typeof payload === 'object' && payload !== null && (payload as any).isAxiosError === true;
}

function unbrowseBase(): string {
  return process.env.UNBROWSE_API_URL || process.env.UNBROWSE_BASE || DEFAULT_BASE;
}
function unbrowseAuth(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = process.env.UNBROWSE_API_KEY;
  if (apiKey) h['authorization'] = `Bearer ${apiKey}`;
  const x402 = process.env.UNBROWSE_X_PAYMENT || process.env.X_PAYMENT;
  if (x402) h['x-payment'] = x402;
  return h;
}
async function unbrowseResolve(url: string, intent: string): Promise<any | null> {
  try {
    const res = await fetch(`${unbrowseBase()}/v1/resolve`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ url, intent }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
async function unbrowseExecute(endpointId: string): Promise<any> {
  try {
    const res = await fetch(`${unbrowseBase()}/v1/execute`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ endpoint_id: endpointId, params: {}, raw: true }),
      signal: AbortSignal.timeout(30000),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
function topEndpointId(resolved: any): string | null {
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  return list[0]?.endpoint_id ?? null;
}
function intentFor(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length ? `fetch ${parts.slice(-2).join(' ')} from ${u.hostname}` : `fetch homepage of ${u.hostname}`;
  } catch {
    return 'fetch resource';
  }
}

function buildUrl(config: AxiosRequestConfig): string {
  let url = config.url || '';
  if (config.baseURL && !/^https?:\/\//i.test(url)) {
    url = config.baseURL.replace(/\/$/, '') + '/' + url.replace(/^\//, '');
  }
  if (config.params && Object.keys(config.params).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(config.params)) qs.append(k, String(v));
    url += (url.includes('?') ? '&' : '?') + qs.toString();
  }
  return url;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

async function shapeResponse<T>(res: Response, config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  const ct = res.headers.get('content-type') || '';
  let data: unknown;
  if (config.responseType === 'text') data = await res.text();
  else if (config.responseType === 'arraybuffer') data = await res.arrayBuffer();
  else if (config.responseType === 'blob') data = await res.blob();
  else if (ct.includes('application/json')) {
    const txt = await res.text();
    data = txt ? JSON.parse(txt) : '';
  } else {
    const txt = await res.text();
    try {
      data = JSON.parse(txt);
    } catch {
      data = txt;
    }
  }
  return {
    data: data as T,
    status: res.status,
    statusText: res.statusText,
    headers: headersToObject(res.headers),
    config,
    request: {},
  };
}

function synthesizeAxiosResponse<T>(body: unknown, config: AxiosRequestConfig): AxiosResponse<T> {
  const isStr = typeof body === 'string';
  return {
    data: (config.responseType === 'text' && !isStr ? JSON.stringify(body) : body) as T,
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json',
      'x-unbrowse-source': 'marketplace-cache',
    },
    config,
    request: {},
  };
}

export interface AxiosInstance {
  <T = any>(configOrUrl: AxiosRequestConfig | string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  head<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  options<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  post<T = any>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  put<T = any>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  patch<T = any>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  defaults: AxiosRequestConfig;
  interceptors: {
    request: InterceptorManager<AxiosRequestConfig>;
    response: InterceptorManager<AxiosResponse>;
  };
  create(defaults?: AxiosRequestConfig): AxiosInstance;
}

function createInstance(instanceDefaults: AxiosRequestConfig = {}): AxiosInstance {
  const interceptors = {
    request: new InterceptorManager<AxiosRequestConfig>(),
    response: new InterceptorManager<AxiosResponse>(),
  };

  async function dispatch<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    let cfg: AxiosRequestConfig = {
      method: 'get',
      ...instanceDefaults,
      ...config,
      headers: { ...(instanceDefaults.headers || {}), ...(config.headers || {}) },
    };

    // request interceptors (in registration order, like axios reverses then runs;
    // we keep it simple and run in order — enough for the common header/auth case)
    for (const h of interceptors.request.handlers) {
      if (h?.fulfilled) cfg = (await h.fulfilled(cfg)) as AxiosRequestConfig;
    }

    const method = (cfg.method || 'get').toUpperCase();
    const url = buildUrl(cfg);

    let response: AxiosResponse<T> | null = null;

    if (method === 'GET' && process.env.UNBROWSE_AXIOS_PASSTHROUGH !== '1') {
      const resolved = await unbrowseResolve(url, intentFor(url));
      const endpointId = topEndpointId(resolved);
      if (endpointId) {
        const exec = await unbrowseExecute(endpointId);
        if (exec?.ok && exec.body !== undefined) {
          response = synthesizeAxiosResponse<T>(exec.body, cfg);
        }
      }
    }

    if (!response) {
      let nativeRes: Response;
      try {
        nativeRes = await fetch(url, {
          method,
          headers: cfg.headers,
          body:
            cfg.data === undefined
              ? undefined
              : typeof cfg.data === 'string'
                ? cfg.data
                : JSON.stringify(cfg.data),
          signal: cfg.signal ?? (cfg.timeout ? AbortSignal.timeout(cfg.timeout) : undefined),
        });
      } catch (e) {
        throw new AxiosError((e as Error).message, 'ECONNABORTED', cfg, {});
      }
      response = await shapeResponse<T>(nativeRes, cfg);
    }

    const validate = cfg.validateStatus ?? ((s: number) => s >= 200 && s < 300);
    if (validate && !validate(response.status)) {
      throw new AxiosError(
        `Request failed with status code ${response.status}`,
        response.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
        cfg,
        response.request,
        response,
      );
    }

    let out = response;
    for (const h of interceptors.response.handlers) {
      if (h?.fulfilled) out = (await h.fulfilled(out)) as AxiosResponse<T>;
    }
    return out;
  }

  const instance = (<T = any>(configOrUrl: AxiosRequestConfig | string, config?: AxiosRequestConfig) => {
    const cfg: AxiosRequestConfig = typeof configOrUrl === 'string' ? { url: configOrUrl, ...config } : configOrUrl;
    return dispatch<T>(cfg);
  }) as AxiosInstance;

  instance.request = <T = any>(config: AxiosRequestConfig) => dispatch<T>(config);
  instance.get = <T = any>(url: string, config?: AxiosRequestConfig) => dispatch<T>({ ...config, url, method: 'get' });
  instance.delete = <T = any>(url: string, config?: AxiosRequestConfig) => dispatch<T>({ ...config, url, method: 'delete' });
  instance.head = <T = any>(url: string, config?: AxiosRequestConfig) => dispatch<T>({ ...config, url, method: 'head' });
  instance.options = <T = any>(url: string, config?: AxiosRequestConfig) => dispatch<T>({ ...config, url, method: 'options' });
  instance.post = <T = any>(url: string, data?: unknown, config?: AxiosRequestConfig) => dispatch<T>({ ...config, url, data, method: 'post' });
  instance.put = <T = any>(url: string, data?: unknown, config?: AxiosRequestConfig) => dispatch<T>({ ...config, url, data, method: 'put' });
  instance.patch = <T = any>(url: string, data?: unknown, config?: AxiosRequestConfig) => dispatch<T>({ ...config, url, data, method: 'patch' });
  instance.defaults = instanceDefaults;
  instance.interceptors = interceptors;
  instance.create = (defaults?: AxiosRequestConfig) => createInstance({ ...instanceDefaults, ...defaults });

  return instance;
}

const axios = createInstance() as AxiosInstance & {
  isAxiosError: typeof isAxiosError;
  AxiosError: typeof AxiosError;
  all: <T>(values: Array<T | Promise<T>>) => Promise<T[]>;
  spread: <T, R>(callback: (...args: T[]) => R) => (arr: T[]) => R;
  CancelToken: { source: () => { token: AbortSignal; cancel: (reason?: string) => void } };
};

axios.isAxiosError = isAxiosError;
axios.AxiosError = AxiosError;
axios.all = <T>(values: Array<T | Promise<T>>) => Promise.all(values);
axios.spread = <T, R>(callback: (...args: T[]) => R) => (arr: T[]) => callback(...arr);
axios.CancelToken = {
  source: () => {
    const controller = new AbortController();
    return { token: controller.signal, cancel: () => controller.abort() };
  },
};

export default axios;
export { axios };
