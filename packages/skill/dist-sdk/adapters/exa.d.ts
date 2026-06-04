/**
 * src/sdk/adapters/exa.ts — drop-in replacement for the `exa-js` client.
 *
 * Same construction (`new Exa(apiKey)`) and the same method shapes (`search`,
 * `searchAndContents`, `getContents`, `answer`) returning exa-shaped results — but every
 * call routes through the wallet-sealed unbrowse hole instead of Exa's API. Swap the
 * import, keep your code. Inject a `transport`/`wallet` (HoleOptions) for tests or to
 * bind the hole to a wallet.
 */
import { type HoleOptions } from "../hole.js";
export interface ExaSearchOptions {
    numResults?: number;
    type?: string;
    includeDomains?: string[];
    startPublishedDate?: string;
    contents?: {
        text?: boolean;
        highlights?: boolean;
        summary?: boolean;
    };
    [key: string]: unknown;
}
export interface ExaResult {
    title: string | null;
    url: string;
    publishedDate?: string;
    score?: number;
    text?: string;
    highlights?: string[];
    summary?: string;
}
export interface ExaSearchResponse {
    results: ExaResult[];
    autopromptString?: string;
}
export declare class Exa {
    private readonly hole;
    constructor(_apiKey?: string, opts?: HoleOptions);
    search(query: string, options?: ExaSearchOptions): Promise<ExaSearchResponse>;
    searchAndContents(query: string, options?: ExaSearchOptions): Promise<ExaSearchResponse>;
    getContents(urls: string[], _options?: {
        text?: boolean;
        highlights?: boolean;
    }): Promise<ExaSearchResponse>;
    answer(question: string): Promise<{
        answer: string;
    }>;
}
export default Exa;
