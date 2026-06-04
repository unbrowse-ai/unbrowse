/**
 * src/sdk/adapters/tavily.ts — drop-in replacement for the `@tavily/core` client.
 *
 * Same construction (`tavily({ apiKey })`) and the same methods (`search`, `extract`)
 * returning tavily-shaped responses — routed through the wallet-sealed unbrowse hole.
 */
import { type HoleOptions } from "../hole.js";
export interface TavilyResult {
    title: string;
    url: string;
    content: string;
    score: number;
    rawContent?: string;
}
export interface TavilySearchResponse {
    query: string;
    answer?: string;
    results: TavilyResult[];
    responseTime?: number;
}
export interface TavilyExtractResponse {
    results: Array<{
        url: string;
        rawContent: string;
    }>;
    failedResults: string[];
}
export interface TavilyOptions extends HoleOptions {
    apiKey?: string;
}
export interface TavilyClient {
    search(query: string, options?: Record<string, unknown>): Promise<TavilySearchResponse>;
    extract(urls: string[]): Promise<TavilyExtractResponse>;
}
export declare function tavily(options?: TavilyOptions): TavilyClient;
export default tavily;
