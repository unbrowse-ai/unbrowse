/**
 * src/sdk/adapters/tavily.ts — drop-in replacement for the `@tavily/core` client.
 *
 * Same construction (`tavily({ apiKey })`) and the same methods (`search`, `extract`)
 * returning tavily-shaped responses — routed through the wallet-sealed unbrowse hole.
 */
import { createHole } from "../hole.js";
function toTavily(it) {
    return {
        title: it.title ?? "",
        url: it.url ?? "",
        content: typeof it.text === "string" ? it.text : "",
        score: typeof it.score === "number" ? it.score : 0,
        rawContent: typeof it.rawContent === "string" ? it.rawContent : undefined,
    };
}
export function tavily(options = {}) {
    const hole = createHole(options);
    return {
        async search(query, opts = {}) {
            const r = await hole.fill({ intent: query, params: opts });
            return { query, answer: r.answer, results: r.items.map(toTavily) };
        },
        async extract(urls) {
            const results = [];
            const failedResults = [];
            for (const url of urls) {
                const r = await hole.fill({ intent: `extract ${url}`, url });
                const text = r.items[0]?.text;
                if (typeof text === "string" && text)
                    results.push({ url, rawContent: text });
                else
                    failedResults.push(url);
            }
            return { results, failedResults };
        },
    };
}
export default tavily;
