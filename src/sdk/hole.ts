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
  walletPubkey: string; // hex
  signature: string; // hex over the canonical request
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
  sign(message: Uint8Array): Promise<{ signature: Uint8Array; walletPubkey: Uint8Array }>;
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

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += (b[i] ?? 0).toString(16).padStart(2, "0");
  return s;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Zero-cost deterministic name + description for a captured route. The always-on baseline
 * so a learned route is never left undescribed and the USER never has to write one; the
 * optional `generate` hook (a cheap model) enriches this when present.
 */
export function defaultDescribe(intent: string, skill: HoleSkill, items: HoleItem[]): { name: string; description: string } {
  const domain = skill.domain ?? hostOf(items[0]?.url);
  const verb =
    intent.toLowerCase().match(/\b(search|find|list|get|fetch|add|create|update|delete|submit|extract|read|buy|book|send)\b/)?.[1] ??
    "fetch";
  const slug =
    intent
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
export function canonicalRequest(req: HoleRequest): Uint8Array {
  const frag = JSON.stringify({
    intent: req.intent,
    url: req.url ?? null,
    params: req.params ?? null,
  });
  return new TextEncoder().encode(frag);
}

/** Default transport: route the intent through the real Unbrowse SDK `.search`. */
function makeDefaultTransport(clientOpts?: UnbrowseClientOptions): HoleTransport {
  const client = new Unbrowse(clientOpts);
  return async (req: HoleRequest): Promise<Omit<HoleResult, "seal">> => {
    // ACT → execute the intent (perform the action); READ → search (fill from knowledge).
    const res = (req.act
      ? await client.execute({ intent: req.intent, url: req.url, params: req.params } as never)
      : await client.search({ query: req.intent } as never)) as unknown as Record<string, unknown>;
    const rawItems =
      (res.results as unknown[]) ??
      (res.endpoints as unknown[]) ??
      (res.items as unknown[]) ??
      [];
    const items: HoleItem[] = (Array.isArray(rawItems) ? rawItems : []).map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return {
        title: typeof o.title === "string" ? o.title : undefined,
        url: typeof o.url === "string" ? o.url : (typeof o.url_template === "string" ? o.url_template : undefined),
        text: typeof o.text === "string" ? o.text : (typeof o.description === "string" ? o.description : undefined),
        score: typeof o.score === "number" ? o.score : undefined,
        ...o,
      };
    });
    const skillRes = (res.skill ?? undefined) as Record<string, unknown> | undefined;
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
  private readonly transport: HoleTransport;
  private readonly wallet?: WalletSeal;
  private readonly autoIndex: boolean;
  private readonly describe: boolean;
  private readonly index?: (info: IndexInfo) => Promise<void> | void;
  private readonly generate?: (prompt: string) => Promise<string> | string;

  constructor(opts: HoleOptions = {}) {
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
  async fill(req: HoleRequest): Promise<HoleResult> {
    const base = await this.transport(req);
    const result: HoleResult = { ...base };

    if (this.wallet) {
      const { signature, walletPubkey } = await this.wallet.sign(canonicalRequest(req));
      result.seal = { walletPubkey: bytesToHex(walletPubkey), signature: bytesToHex(signature) };
    }

    const wantIndex = req.autoIndex ?? this.autoIndex;
    if (wantIndex && base.captured) {
      let skill: HoleSkill = base.skill ?? {};
      // "index it nicely": WE generate the route's name + description (cheap), the user
      // never has to. The client's own model (`generate`) enriches; otherwise a zero-cost
      // deterministic baseline always fills it in.
      if (this.describe && !skill.description) {
        if (this.generate) {
          const prompt =
            `Name and one-line describe a reusable API route just learned for the intent ` +
            `"${req.intent}"${skill.domain ? ` on ${skill.domain}` : ""}. ` +
            `Reply exactly as: <name> — <description>.`;
          const gen = await this.generate(prompt);
          if (typeof gen === "string" && gen.trim()) {
            const [name, ...rest] = gen.split(" — ");
            skill = { ...skill, name: skill.name ?? (name ?? "").trim(), description: rest.join(" — ").trim() || gen.trim() };
          }
        } else {
          const d = defaultDescribe(req.intent, skill, base.items);
          skill = { ...skill, name: skill.name ?? d.name, description: skill.description ?? d.description };
        }
      }
      result.skill = skill;
      if (this.index) {
        await this.index({ intent: req.intent, skill, items: base.items });
        result.indexed = true;
      } else {
        result.indexed = false;
      }
    }
    return result;
  }

  /** Stream the filled items one at a time (the "streaming shit into it" surface). */
  async *stream(req: HoleRequest): AsyncIterable<HoleItem> {
    const r = await this.fill(req);
    for (const item of r.items) yield item;
  }
}

/** Construct a hole. With `wallet`, it is the zk'd, wallet-protected hole. */
export function createHole(opts?: HoleOptions): Hole {
  return new Hole(opts);
}
