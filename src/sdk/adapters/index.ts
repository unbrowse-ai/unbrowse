/**
 * src/sdk/adapters/index.ts — drop-in client adapters over the unbrowse hole.
 *
 * Each adapter mirrors a popular client's construction + method shapes, so swapping the
 * import is the only change needed:
 *
 *   import Exa from "@unbrowse/sdk/adapters/exa";          // was: import Exa from "exa-js"
 *   import { tavily } from "@unbrowse/sdk/adapters/tavily"; // was: from "@tavily/core"
 *   import { Agent } from "@unbrowse/sdk/adapters/browser-use";
 *
 * All of them wrap the same wallet-sealed streaming hole (`../hole.ts`).
 */
export { Exa, type ExaResult, type ExaSearchResponse, type ExaSearchOptions } from "./exa.js";
export { tavily, type TavilyClient, type TavilyResult, type TavilySearchResponse } from "./tavily.js";
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
