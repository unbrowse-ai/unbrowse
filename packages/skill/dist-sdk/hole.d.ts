import type { UnbrowseClientOptions } from "./types.js";
/** What the caller hands the hole: an intent, optionally scoped to a URL. */
export interface HoleRequest {
    intent: string;
    url?: string;
    params?: Record<string, unknown>;
    /** Perform an ACTION (execute / fill / submit) rather than just read/search. */
    act?: boolean;
    /** Override the hole's auto-index default for this one request. */
    autoIndex?: boolean;
}
/** A reusable route the hole learned while filling a gap (what gets indexed). */
export interface HoleSkill {
    domain?: string;
    name?: string;
    description?: string;
}
/** Payload handed to the index hook when a captured route is auto-indexed. */
export interface IndexInfo {
    intent: string;
    skill: HoleSkill;
    items: HoleItem[];
}
/** One normalized result item — the lingua franca every adapter reshapes from. */
export interface HoleItem {
    title?: string;
    url?: string;
    text?: string;
    score?: number;
    publishedDate?: string;
    [key: string]: unknown;
}
/** A wallet attestation attached when the hole is sealed (the zk'd hole). */
export interface HoleSeal {
    walletPubkey: string;
    signature: string;
}
export interface HoleResult {
    ok: boolean;
    intent: string;
    items: HoleItem[];
    answer?: string;
    source?: string;
    raw?: unknown;
    seal?: HoleSeal;
    /** True when filling required a fresh capture (a new route was learned). */
    captured?: boolean;
    /** The learned route, when captured — what the auto-index hook receives. */
    skill?: HoleSkill;
    /** True when this fill auto-indexed the captured route. */
    indexed?: boolean;
}
/** The pluggable backend: turn a request into normalized items. */
export type HoleTransport = (req: HoleRequest) => Promise<Omit<HoleResult, "seal">>;
/** Minimal wallet signer the hole seals to (any Ed25519-style signer fits). */
export interface WalletSeal {
    sign(message: Uint8Array): Promise<{
        signature: Uint8Array;
        walletPubkey: Uint8Array;
    }>;
}
export interface HoleOptions {
    transport?: HoleTransport;
    wallet?: WalletSeal;
    client?: UnbrowseClientOptions;
    /** Auto-index captured routes after a fill (default true). */
    autoIndex?: boolean;
    /**
     * Generate a name + description for a captured route (default true). We generate
     * descriptions for the user, not the other way round — a zero-cost deterministic
     * baseline always, enriched by the `generate` hook (a cheap model) when provided.
     * Set false only if you truly want routes indexed with no description.
     */
    describe?: boolean;
    /**
     * Where a captured route is sent to be indexed — the discover → publish loop.
     * Wire this to the CLI's `queueBackgroundIndex`; left unset, fills still work but
     * nothing is indexed (result.indexed = false).
     */
    index?: (info: IndexInfo) => Promise<void> | void;
    /**
     * Client-side LLM used to "index it nicely" — name + describe a captured route.
     * Keeps generation ON THE CLIENT (the agent's own model); no server round-trip.
     * Given the captured route, return a short "<name> — <description>".
     */
    generate?: (prompt: string) => Promise<string> | string;
}
/**
 * Zero-cost deterministic name + description for a captured route. The always-on baseline
 * so a learned route is never left undescribed and the USER never has to write one; the
 * optional `generate` hook (a cheap model) enriches this when present.
 */
export declare function defaultDescribe(intent: string, skill: HoleSkill, items: HoleItem[]): {
    name: string;
    description: string;
};
/** Stable bytes to sign — key order fixed so client and verifier agree. */
export declare function canonicalRequest(req: HoleRequest): Uint8Array;
/** The hole. One method that matters: `fill`. Stream with `stream`. */
export declare class Hole {
    private readonly transport;
    private readonly wallet?;
    private readonly autoIndex;
    private readonly describe;
    private readonly index?;
    private readonly generate?;
    constructor(opts?: HoleOptions);
    /**
     * Fill the gap — READ (search) or ACT (execute/fill/submit, when `req.act`). When the
     * hole is wallet-bound the result carries a seal. When the fill required a fresh
     * capture, the route is auto-indexed (named/described by the client-side `generate`
     * hook, then handed to `index`) — the discover → publish loop, on the client.
     */
    fill(req: HoleRequest): Promise<HoleResult>;
    /** Stream the filled items one at a time (the "streaming shit into it" surface). */
    stream(req: HoleRequest): AsyncIterable<HoleItem>;
}
/** Construct a hole. With `wallet`, it is the zk'd, wallet-protected hole. */
export declare function createHole(opts?: HoleOptions): Hole;
