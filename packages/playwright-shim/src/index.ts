/**
 * @unbrowse/playwright-shim — drop-in replacement for playwright.
 *
 *   - import { chromium } from 'playwright'
 *   + import { chromium } from '@unbrowse/playwright-shim'
 *
 * Everything else stays the same. page.goto() short-circuits through
 * Unbrowse's resolve+execute on cache hit; falls through to real playwright
 * on miss (if installed as an optional peer dep) or throws a clear error.
 *
 * Designed for: cost-curious scraping teams whose existing playwright code
 * gets a `npm i @unbrowse/playwright-shim` upgrade path that pays per-call
 * instead of per-browser-hour for any URL already indexed in the marketplace.
 */
export { chromium } from './chromium.js';
export type {
  Browser,
  BrowserContext,
  BrowserType,
  LaunchOptions,
  Page,
  Response,
} from './types.js';
