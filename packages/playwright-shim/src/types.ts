/**
 * Types that mirror playwright's public surface so the shim is a structural
 * drop-in. We intentionally do NOT depend on `playwright` at runtime — the
 * package is marked as an optional peerDependency for fall-through-to-real
 * cases. The types here describe enough surface to satisfy `import { chromium
 * } from '@unbrowse/playwright-shim'` and the most-called methods.
 *
 * Anything we don't shim throws a clear "not implemented in shim, install
 * playwright and use the real chromium for this method" error so callers can
 * incrementally adopt.
 */

export interface LaunchOptions {
  headless?: boolean;
  args?: string[];
  executablePath?: string;
  proxy?: {
    server: string;
    bypass?: string;
    username?: string;
    password?: string;
  };
  channel?: string;
  downloadsPath?: string;
  chromiumSandbox?: boolean;
  slowMo?: number;
  timeout?: number;
}

export interface BrowserContextOptions {
  viewport?: { width: number; height: number } | null;
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  permissions?: string[];
  extraHTTPHeaders?: Record<string, string>;
  httpCredentials?: { username: string; password: string };
  storageState?: string | { cookies: any[]; origins: any[] };
}

export interface GotoOptions {
  timeout?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  referer?: string;
}

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
  force?: boolean;
  modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[];
  noWaitAfter?: boolean;
  position?: { x: number; y: number };
  timeout?: number;
  trial?: boolean;
}

export interface FillOptions {
  force?: boolean;
  noWaitAfter?: boolean;
  timeout?: number;
}

export interface ScreenshotOptions {
  path?: string;
  type?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  omitBackground?: boolean;
  timeout?: number;
}

/**
 * Minimal Response surface returned by `page.goto()`. We synthesize this from
 * the Unbrowse marketplace endpoint's response on cache hit; on fall-through,
 * the real playwright Response is returned untouched.
 */
export interface Response {
  url(): string;
  status(): number;
  statusText(): string;
  headers(): Record<string, string>;
  ok(): boolean;
  body(): Promise<Buffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface Page {
  goto(url: string, options?: GotoOptions): Promise<Response | null>;
  click(selector: string, options?: ClickOptions): Promise<void>;
  fill(selector: string, value: string, options?: FillOptions): Promise<void>;
  type(selector: string, text: string, options?: { delay?: number; noWaitAfter?: boolean; timeout?: number }): Promise<void>;
  evaluate<T = unknown>(pageFunction: string | ((...args: any[]) => T), arg?: any): Promise<T>;
  content(): Promise<string>;
  url(): string;
  title(): Promise<string>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  close(): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: 'attached' | 'detached' | 'visible' | 'hidden' }): Promise<unknown>;
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void>;
}

export interface BrowserContext {
  newPage(): Promise<Page>;
  pages(): Page[];
  close(): Promise<void>;
  cookies(urls?: string | string[]): Promise<any[]>;
  addCookies(cookies: any[]): Promise<void>;
}

export interface Browser {
  newContext(options?: BrowserContextOptions): Promise<BrowserContext>;
  newPage(options?: BrowserContextOptions): Promise<Page>;
  contexts(): BrowserContext[];
  close(): Promise<void>;
  isConnected(): boolean;
  version(): string;
}

export interface BrowserType {
  launch(options?: LaunchOptions): Promise<Browser>;
  connectOverCDP(wsEndpoint: string, options?: { timeout?: number }): Promise<Browser>;
  executablePath(): string;
  name(): 'chromium';
}
