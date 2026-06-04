/**
 * src/sdk/hole.ts — the wallet-sealed streaming "hole".
 *
 * The whole surface, collapsed to one tool: hand the hole an INTENT (and an optional
 * URL / params) and it streams back whatever fills that internet gap — internally the
 * unbrowse resolve → execute → capture pipeline. The CLI/MCP can expose just this one
 * tool; the drop-in adapters (exa / tavily / browser-use) all wrap it (see
 * `src/sdk/adapters/`). Optionally bound to a wallet so every request is signed to the
 * holder — the zk'd hole: the request carries a wallet attestation, and only the holder
 * could have produced it.
 *
 * The transport is injectable. The default routes through the `Unbrowse` SDK client
 * (`.search`); tests and embedders pass their own transport for hermetic, offline use.
 */
import { Unbrowse } from "./client.js";
function bytesToHex(b) {
    let s = "";
    for (let i = 0; i < b.length; i++)
        s += (b[i] ?? 0).toString(16).padStart(2, "0");
    return s;
}
function hostOf(url) {
    if (!url)
        return undefined;
    try {
        return new URL(url).hostname;
    }
    catch {
        return undefined;
    }
}
/**
 * Zero-cost deterministic name + description for a captured route. The always-on baseline
 * so a learned route is never left undescribed and the USER never has to write one; the
 * optional `generate` hook (a cheap model) enriches this when present.
 */
export function defaultDescribe(intent, skill, items) {
    const domain = skill.domain ?? hostOf(items[0]?.url);
    const verb = intent.toLowerCase().match(/\b(search|find|list|get|fetch|add|create|update|delete|submit|extract|read|buy|book|send)\b/)?.[1] ??
        "fetch";
    const slug = intent
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .split("-")
        .filter(Boolean)
        .slice(0, 4)
        .join("-") || "route";
    const name = skill.name ?? (domain ? `${domain.split(".")[0]}-${verb}` : `${verb}-${slug}`);
    const where = domain ? ` on ${domain}` : "";
    const description = `${verb.charAt(0).toUpperCase()}${verb.slice(1)} route${where} — ${intent}`.slice(0, 140);
    return { name, description };
}
/** Stable bytes to sign — key order fixed so client and verifier agree. */
export function canonicalRequest(req) {
    const frag = JSON.stringify({
        intent: req.intent,
        url: req.url ?? null,
        params: req.params ?? null,
    });
    return new TextEncoder().encode(frag);
}
/** Default transport: route the intent through the real Unbrowse SDK `.search`. */
function makeDefaultTransport(clientOpts) {
    const client = new Unbrowse(clientOpts);
    return async (req) => {
        // ACT → execute the intent (perform the action); READ → search (fill from knowledge).
        const res = (req.act
            ? await client.execute({ intent: req.intent, url: req.url, params: req.params })
            : await client.search({ query: req.intent }));
        const rawItems = res.results ??
            res.endpoints ??
            res.items ??
            [];
        const items = (Array.isArray(rawItems) ? rawItems : []).map((r) => {
            const o = (r ?? {});
            return {
                title: typeof o.title === "string" ? o.title : undefined,
                url: typeof o.url === "string" ? o.url : (typeof o.url_template === "string" ? o.url_template : undefined),
                text: typeof o.text === "string" ? o.text : (typeof o.description === "string" ? o.description : undefined),
                score: typeof o.score === "number" ? o.score : undefined,
                ...o,
            };
        });
        const skillRes = (res.skill ?? undefined);
        return {
            ok: true,
            intent: req.intent,
            items,
            answer: typeof res.answer === "string" ? res.answer : undefined,
            source: "unbrowse",
            raw: res,
            // a fresh capture happened if the backend says so (new route learned this call)
            captured: res.captured === true || res.indexed === false,
            skill: skillRes
                ? {
                    domain: typeof skillRes.domain === "string" ? skillRes.domain : undefined,
                    name: typeof skillRes.name === "string" ? skillRes.name : undefined,
                    description: typeof skillRes.description === "string" ? skillRes.description : undefined,
                }
                : undefined,
        };
    };
}
/** The hole. One method that matters: `fill`. Stream with `stream`. */
export class Hole {
    transport;
    wallet;
    autoIndex;
    describe;
    index;
    generate;
    constructor(opts = {}) {
        this.transport = opts.transport ?? makeDefaultTransport(opts.client);
        this.wallet = opts.wallet;
        this.autoIndex = opts.autoIndex ?? true;
        this.describe = opts.describe ?? true;
        this.index = opts.index;
        this.generate = opts.generate;
    }
    /**
     * Fill the gap — READ (search) or ACT (execute/fill/submit, when `req.act`). When the
     * hole is wallet-bound the result carries a seal. When the fill required a fresh
     * capture, the route is auto-indexed (named/described by the client-side `generate`
     * hook, then handed to `index`) — the discover → publish loop, on the client.
     */
    async fill(req) {
        const base = await this.transport(req);
        const result = { ...base };
        if (this.wallet) {
            const { signature, walletPubkey } = await this.wallet.sign(canonicalRequest(req));
            result.seal = { walletPubkey: bytesToHex(walletPubkey), signature: bytesToHex(signature) };
        }
        const wantIndex = req.autoIndex ?? this.autoIndex;
        if (wantIndex && base.captured) {
            let skill = base.skill ?? {};
            // "index it nicely": WE generate the route's name + description (cheap), the user
            // never has to. The client's own model (`generate`) enriches; otherwise a zero-cost
            // deterministic baseline always fills it in.
            if (this.describe && !skill.description) {
                if (this.generate) {
                    const prompt = `Name and one-line describe a reusable API route just learned for the intent ` +
                        `"${req.intent}"${skill.domain ? ` on ${skill.domain}` : ""}. ` +
                        `Reply exactly as: <name> — <description>.`;
                    const gen = await this.generate(prompt);
                    if (typeof gen === "string" && gen.trim()) {
                        const [name, ...rest] = gen.split(" — ");
                        skill = { ...skill, name: skill.name ?? (name ?? "").trim(), description: rest.join(" — ").trim() || gen.trim() };
                    }
                }
                else {
                    const d = defaultDescribe(req.intent, skill, base.items);
                    skill = { ...skill, name: skill.name ?? d.name, description: skill.description ?? d.description };
                }
            }
            result.skill = skill;
            if (this.index) {
                await this.index({ intent: req.intent, skill, items: base.items });
                result.indexed = true;
            }
            else {
                result.indexed = false;
            }
        }
        return result;
    }
    /** Stream the filled items one at a time (the "streaming shit into it" surface). */
    async *stream(req) {
        const r = await this.fill(req);
        for (const item of r.items)
            yield item;
    }
}
/** Construct a hole. With `wallet`, it is the zk'd, wallet-protected hole. */
export function createHole(opts) {
    return new Hole(opts);
}
