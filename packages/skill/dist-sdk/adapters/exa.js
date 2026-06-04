/**
 * src/sdk/adapters/exa.ts — drop-in replacement for the `exa-js` client.
 *
 * Same construction (`new Exa(apiKey)`) and the same method shapes (`search`,
 * `searchAndContents`, `getContents`, `answer`) returning exa-shaped results — but every
 * call routes through the wallet-sealed unbrowse hole instead of Exa's API. Swap the
 * import, keep your code. Inject a `transport`/`wallet` (HoleOptions) for tests or to
 * bind the hole to a wallet.
 */
import { createHole } from "../hole.js";
function toExa(it) {
    return {
        title: it.title ?? null,
        url: it.url ?? "",
        publishedDate: it.publishedDate,
        score: it.score,
        text: typeof it.text === "string" ? it.text : undefined,
        highlights: Array.isArray(it.highlights) ? it.highlights : undefined,
        summary: typeof it.summary === "string" ? it.summary : undefined,
    };
}
export class Exa {
    hole;
    constructor(_apiKey, opts = {}) {
        this.hole = createHole(opts);
    }
    async search(query, options = {}) {
        const r = await this.hole.fill({ intent: query, params: options });
        const n = options.numResults ?? r.items.length;
        return { results: r.items.slice(0, n).map(toExa) };
    }
    async searchAndContents(query, options = {}) {
        return this.search(query, { ...options, contents: { text: true, ...(options.contents ?? {}) } });
    }
    async getContents(urls, _options = {}) {
        const results = [];
        for (const url of urls) {
            const r = await this.hole.fill({ intent: `contents of ${url}`, url });
            const first = r.items[0];
            if (first)
                results.push(toExa({ ...first, url }));
        }
        return { results };
    }
    async answer(question) {
        const r = await this.hole.fill({ intent: question });
        return { answer: r.answer ?? r.items[0]?.text ?? "" };
    }
}
export default Exa;
