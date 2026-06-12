/**
 * src/sdk/adapters/index.ts — drop-in client adapters over the unbrowse hole.
 *
 * Each adapter mirrors a popular client's construction + method shapes, so swapping the
 * import is the only change needed:
 *
 *   import Exa from "@unbrowse/sdk/adapters/exa";          // was: import Exa from "exa-js"
 *   import { tavily } from "@unbrowse/sdk/adapters/tavily"; // was: from "@tavily/core"
 *   import FirecrawlApp from "@unbrowse/sdk/adapters/firecrawl"; // was: from "@mendable/firecrawl-js"
 *   import { Agent } from "@unbrowse/sdk/adapters/browser-use";
 *
 * All of them wrap the same wallet-sealed streaming hole (`../hole.ts`), so each call
 * settles per request via x402 — you pay only for what you fetch, not a flat plan.
 */
export { Exa, type ExaResult, type ExaSearchResponse, type ExaSearchOptions } from "./exa.js";
export { tavily, type TavilyClient, type TavilyResult, type TavilySearchResponse } from "./tavily.js";
export {
  FirecrawlApp,
  type FirecrawlDocument,
  type ScrapeResponse,
  type SearchResponse,
  type MapResponse,
  type CrawlResponse,
} from "./firecrawl.js";
export { Agent, type AgentOptions, type AgentResult } from "./browser-use.js";
export {
  createHole,
  Hole,
  type HoleRequest,
  type HoleResult,
  type HoleItem,
  type HoleOptions,
  type HoleTransport,
  type WalletSeal,
} from "../hole.js";
