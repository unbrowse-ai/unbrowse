/**
 * src/sdk/adapters/exa.ts — drop-in replacement for the `exa-js` client.
 *
 * Same construction (`new Exa(apiKey)`) and the same method shapes (`search`,
 * `searchAndContents`, `getContents`, `answer`) returning exa-shaped results — but every
 * call routes through the wallet-sealed unbrowse hole instead of Exa's API. Swap the
 * import, keep your code. Inject a `transport`/`wallet` (HoleOptions) for tests or to
 * bind the hole to a wallet.
 */
import { createHole, type Hole, type HoleItem, type HoleOptions } from "../hole.js";

export interface ExaSearchOptions {
  numResults?: number;
  type?: string;
  includeDomains?: string[];
  startPublishedDate?: string;
  contents?: { text?: boolean; highlights?: boolean; summary?: boolean };
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

function toExa(it: HoleItem): ExaResult {
  return {
    title: it.title ?? null,
    url: it.url ?? "",
    publishedDate: it.publishedDate,
    score: it.score,
    text: typeof it.text === "string" ? it.text : undefined,
    highlights: Array.isArray(it.highlights) ? (it.highlights as string[]) : undefined,
    summary: typeof it.summary === "string" ? (it.summary as string) : undefined,
  };
}

export class Exa {
  private readonly hole: Hole;

  constructor(_apiKey?: string, opts: HoleOptions = {}) {
    this.hole = createHole(opts);
  }

  async search(query: string, options: ExaSearchOptions = {}): Promise<ExaSearchResponse> {
    const r = await this.hole.fill({ intent: query, params: options as Record<string, unknown> });
    const n = options.numResults ?? r.items.length;
    return { results: r.items.slice(0, n).map(toExa) };
  }

  async searchAndContents(query: string, options: ExaSearchOptions = {}): Promise<ExaSearchResponse> {
    return this.search(query, { ...options, contents: { text: true, ...(options.contents ?? {}) } });
  }

  async getContents(urls: string[], _options: { text?: boolean; highlights?: boolean } = {}): Promise<ExaSearchResponse> {
    const results: ExaResult[] = [];
    for (const url of urls) {
      const r = await this.hole.fill({ intent: `contents of ${url}`, url });
      const first = r.items[0];
      if (first) results.push(toExa({ ...first, url }));
    }
    return { results };
  }

  async answer(question: string): Promise<{ answer: string }> {
    const r = await this.hole.fill({ intent: question });
    return { answer: r.answer ?? r.items[0]?.text ?? "" };
  }
}

export default Exa;
