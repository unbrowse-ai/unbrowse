/**
 * Three-recipient `createUptoHandler` wiring — pure-function unit tests.
 *
 * Closes contract 1a80cffd (DEFERRED-FAREMETER-FLEX-SPLITS-IMPL).
 *
 * The integration with the real `@faremeter/payment-solana/flex/hono`
 * upto factory is exercised via a stubbed `uptoFactory` injection so we
 * can assert the EXACT options shape (`facilitatorURL`, `accepts`,
 * `payTo`, etc.) the factory receives — without standing up a
 * facilitator URL or running Solana RPC.
 *
 * Real code paths covered:
 *   - `pickIndexerWallet` — top-cumulative-delta contributor selection
 *   - `lookupDomainWallet` — KV binding read + opt-out short-circuit
 *   - `globalHoldUsdcAta` — env validation
 *   - `resolveThreeRecipientSplits` — full three-recipient assembly,
 *     bps sum, source tagging, fallback chain
 *   - `createUptoHandlerForSkill` — the wire shape the upto factory sees
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_THREE_RECIPIENT_BPS,
  createUptoHandlerForSkill,
  globalHoldUsdcAta,
  lookupDomainWallet,
  pickIndexerWallet,
  resolveThreeRecipientSplits,
  type UptoSplitsKV,
} from "../src/services/flex-upto-handler.js";
import type { Env, SkillContributor, SkillManifest } from "../src/types.js";

// Base58 ATAs (Solana ed25519-derived, 32-44 chars). These are
// dummy-but-shape-valid for the validators in the service. The base58
// alphabet excludes 0, O, I, l and any non-alphanumeric; all chars below
// are drawn from [1-9A-HJ-NP-Za-km-z] so the loose check passes.
const PLATFORM_ATA = "PLATFRMUSDCabcdefghjkmnpqrstuvwxyz234567ABCD";
const GLOBAL_HOLD_ATA = "GLBLHLDUSDCabcdefghjkmnpqrstuvwxyz234567ABCD";
const INDEXER_ATA = "NDXRWLTabcdefghjkmnpqrstuvwxyz234567ABCDEFG";
const DOMAIN_ATA = "DMNUSDCabcdefghjkmnpqrstuvwxyz234567ABCDEFG";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    FLEX_PLATFORM_RECIPIENT_USDC_ATA: PLATFORM_ATA,
    FLEX_GLOBAL_HOLD_USDC_ATA: GLOBAL_HOLD_ATA,
    ENVIRONMENT: "local-dev",
    ...overrides,
  } as Env;
}

function contributor(
  agent: string,
  wallet: string | undefined,
  cumulative_delta: number,
): SkillContributor {
  return {
    agent_id: agent,
    ...(wallet ? { wallet_address: wallet } : {}),
    endpoints_contributed: 1,
    cumulative_delta,
    share: 0,
    first_contributed_at: "2026-01-01T00:00:00Z",
    last_contributed_at: "2026-05-25T00:00:00Z",
  };
}

class MemKV implements UptoSplitsKV {
  private store = new Map<string, string>();
  set(k: string, v: string) {
    this.store.set(k, v);
  }
  async get(k: string): Promise<string | null> {
    return this.store.get(k) ?? null;
  }
}

describe("globalHoldUsdcAta", () => {
  it("returns the env value when set + valid", () => {
    expect(globalHoldUsdcAta(makeEnv())).toBe(GLOBAL_HOLD_ATA);
  });

  it("returns null when unset", () => {
    expect(globalHoldUsdcAta(makeEnv({ FLEX_GLOBAL_HOLD_USDC_ATA: undefined }))).toBeNull();
  });

  it("throws when env value is malformed (length / charset)", () => {
    expect(() => globalHoldUsdcAta(makeEnv({ FLEX_GLOBAL_HOLD_USDC_ATA: "too-short" }))).toThrow(
      /FLEX_GLOBAL_HOLD_USDC_ATA does not look like a base58/,
    );
    // Non-base58 chars (underscore, hyphen) rejected even at correct length.
    expect(() =>
      globalHoldUsdcAta(
        makeEnv({ FLEX_GLOBAL_HOLD_USDC_ATA: "____invalid_base58_with_underscores____xxxx" }),
      ),
    ).toThrow();
  });
});

describe("pickIndexerWallet", () => {
  it("picks the top cumulative_delta wallet", () => {
    expect(
      pickIndexerWallet([
        contributor("a", "WALLETxA", 5),
        contributor("b", "WALLETxB", 50),
        contributor("c", "WALLETxC", 10),
      ]),
    ).toBe("WALLETxB");
  });

  it("returns null when no contributor has a wallet", () => {
    expect(pickIndexerWallet([contributor("a", undefined, 5)])).toBeNull();
    expect(pickIndexerWallet([])).toBeNull();
    expect(pickIndexerWallet(undefined)).toBeNull();
  });

  it("filters out contributors without a wallet before picking", () => {
    // a has no wallet but the highest delta; b has a wallet and lower delta.
    expect(
      pickIndexerWallet([
        contributor("a", undefined, 100),
        contributor("b", "WALLETxB", 5),
      ]),
    ).toBe("WALLETxB");
  });
});

describe("lookupDomainWallet", () => {
  it("returns claimed_wallet when binding present", async () => {
    const kv = new MemKV();
    kv.set(
      "domain-wallet:example.com",
      JSON.stringify({
        domain: "example.com",
        wallet_address: "OWNERBASE",
        wallet_usdc_ata: DOMAIN_ATA,
        verified_at: "2026-05-25T00:00:00Z",
        verified_by_agent_id: "a1",
        txt_value_witness: "x",
        doh_attestations: [],
        schema_version: 1,
      }),
    );
    const result = await lookupDomainWallet(kv, "example.com");
    expect(result.ata).toBe(DOMAIN_ATA);
    expect(result.source).toBe("claimed_wallet");
  });

  it("returns global_hold when binding absent", async () => {
    const kv = new MemKV();
    const result = await lookupDomainWallet(kv, "unclaimed.com");
    expect(result.ata).toBeNull();
    expect(result.source).toBe("global_hold");
  });

  it("returns global_hold when domain is opted-out (even if claimed)", async () => {
    const kv = new MemKV();
    kv.set(
      "domain-wallet:taken-down.com",
      JSON.stringify({
        domain: "taken-down.com",
        wallet_usdc_ata: DOMAIN_ATA,
        verified_at: "2026-05-25T00:00:00Z",
        verified_by_agent_id: "a1",
        txt_value_witness: "x",
        doh_attestations: [],
        schema_version: 1,
      }),
    );
    kv.set("domain-optout:taken-down.com", JSON.stringify({ taken_down_at: "2026-05-25" }));
    const result = await lookupDomainWallet(kv, "taken-down.com");
    expect(result.ata).toBeNull();
    expect(result.source).toBe("global_hold");
  });

  it("normalises domain to lowercase before lookup", async () => {
    const kv = new MemKV();
    kv.set(
      "domain-wallet:example.com",
      JSON.stringify({ wallet_usdc_ata: DOMAIN_ATA, schema_version: 1 }),
    );
    const result = await lookupDomainWallet(kv, "EXAMPLE.COM");
    expect(result.ata).toBe(DOMAIN_ATA);
  });

  it("treats malformed binding JSON as unclaimed", async () => {
    const kv = new MemKV();
    kv.set("domain-wallet:bad.com", "{not-json");
    const result = await lookupDomainWallet(kv, "bad.com");
    expect(result.ata).toBeNull();
    expect(result.source).toBe("global_hold");
  });
});

describe("resolveThreeRecipientSplits — three-recipient defaultSplits", () => {
  const baseSkill = {
    contributors: [contributor("indexer-1", INDEXER_ATA, 100)],
    domain: "example.com",
    owner_compensation_opt_in: true,
    owner_wallet_usdc_ata: undefined,
    markup_bps: undefined,
  } satisfies Pick<
    SkillManifest,
    "contributors" | "domain" | "owner_compensation_opt_in" | "owner_wallet_usdc_ata" | "markup_bps"
  >;

  it("default markup: emits three recipients in [indexer, domain, platform] order", async () => {
    const kv = new MemKV();
    kv.set(
      "domain-wallet:example.com",
      JSON.stringify({ wallet_usdc_ata: DOMAIN_ATA, schema_version: 1 }),
    );

    const result = await resolveThreeRecipientSplits(makeEnv(), kv, baseSkill);

    expect(result.recipients.indexer_ata).toBe(INDEXER_ATA);
    expect(result.recipients.domain_or_hold_ata).toBe(DOMAIN_ATA);
    expect(result.recipients.platform_ata).toBe(PLATFORM_ATA);
    expect(result.recipients.domain_claimed).toBe(true);
    expect(result.recipients.domain_recipient_source).toBe("claimed_wallet");

    // Three entries, in stable order, summing to 10000.
    expect(result.defaultSplits).toHaveLength(3);
    expect(result.defaultSplits[0]).toMatchObject({
      recipient: INDEXER_ATA,
      bps: DEFAULT_THREE_RECIPIENT_BPS.indexer,
      role: "contributor",
    });
    expect(result.defaultSplits[1]).toMatchObject({
      recipient: DOMAIN_ATA,
      bps: DEFAULT_THREE_RECIPIENT_BPS.domain,
      role: "site_owner",
    });
    expect(result.defaultSplits[2]).toMatchObject({
      recipient: PLATFORM_ATA,
      bps: DEFAULT_THREE_RECIPIENT_BPS.platform,
      role: "infrastructure",
    });
    expect(result.defaultSplits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
  });

  it("unclaimed domain → routes to global-hold with source=global_hold", async () => {
    const kv = new MemKV();
    const result = await resolveThreeRecipientSplits(makeEnv(), kv, baseSkill);

    expect(result.recipients.domain_or_hold_ata).toBe(GLOBAL_HOLD_ATA);
    expect(result.recipients.domain_claimed).toBe(false);
    expect(result.recipients.domain_recipient_source).toBe("global_hold");

    // Bps still sum to 10000; only the recipient changed.
    expect(result.defaultSplits[1].recipient).toBe(GLOBAL_HOLD_ATA);
    expect(result.defaultSplits[1].bps).toBe(DEFAULT_THREE_RECIPIENT_BPS.domain);
    expect(result.defaultSplits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
  });

  it("opted-out domain → global-hold even with a binding present", async () => {
    const kv = new MemKV();
    kv.set(
      "domain-wallet:example.com",
      JSON.stringify({ wallet_usdc_ata: DOMAIN_ATA, schema_version: 1 }),
    );
    kv.set("domain-optout:example.com", "1");

    const result = await resolveThreeRecipientSplits(makeEnv(), kv, baseSkill);
    expect(result.recipients.domain_or_hold_ata).toBe(GLOBAL_HOLD_ATA);
    expect(result.recipients.domain_claimed).toBe(false);
  });

  it("throws when global-hold is unset AND domain unclaimed", async () => {
    const kv = new MemKV();
    const env = makeEnv({ FLEX_GLOBAL_HOLD_USDC_ATA: undefined });
    await expect(resolveThreeRecipientSplits(env, kv, baseSkill)).rejects.toThrow(
      /FLEX_GLOBAL_HOLD_USDC_ATA is unset/,
    );
  });

  it("throws when no contributor has a wallet (no indexer to pay)", async () => {
    const kv = new MemKV();
    const noWalletSkill = {
      ...baseSkill,
      contributors: [contributor("a", undefined, 100)],
    };
    await expect(resolveThreeRecipientSplits(makeEnv(), kv, noWalletSkill)).rejects.toThrow(
      /no payable contributor/,
    );
  });

  it("throws when skill.domain is missing", async () => {
    const kv = new MemKV();
    const noDomainSkill = { ...baseSkill, domain: "" };
    await expect(resolveThreeRecipientSplits(makeEnv(), kv, noDomainSkill)).rejects.toThrow(
      /skill\.domain required/,
    );
  });

  it("markup_bps override shifts platform lane; domain stays at OWNER_BPS", async () => {
    // Per services/flex.ts clamp range [500, 8000]. 8000 = 80% markup.
    const kv = new MemKV();
    const skill = { ...baseSkill, markup_bps: 8000 };
    const result = await resolveThreeRecipientSplits(makeEnv(), kv, skill);

    // domain lane = OWNER_BPS (1500) — invariant.
    expect(result.defaultSplits[1].bps).toBe(1500);
    // platform lane absorbs the markup.
    expect(result.defaultSplits[2].bps).toBe(8000);
    // indexer lane = 10000 - 8000 - 1500 = 500.
    expect(result.defaultSplits[0].bps).toBe(500);
    expect(result.defaultSplits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
  });

  it("picks the top-cumulative-delta contributor as the indexer", async () => {
    const kv = new MemKV();
    const skill = {
      ...baseSkill,
      contributors: [
        contributor("low", "LOWxWALLETabcdefghjkmnpqrstuvwxyz234567", 5),
        contributor("hi", INDEXER_ATA, 999),
        contributor("mid", "MIDxWALLETabcdefghjkmnpqrstuvwxyz234567", 50),
      ],
    };
    const result = await resolveThreeRecipientSplits(makeEnv(), kv, skill);
    expect(result.recipients.indexer_ata).toBe(INDEXER_ATA);
  });

  it("collapses duplicates via mergeSplits (indexer === domain owner)", async () => {
    const kv = new MemKV();
    kv.set(
      "domain-wallet:example.com",
      JSON.stringify({ wallet_usdc_ata: INDEXER_ATA, schema_version: 1 }),
    );
    // Same ATA for indexer + domain — Faremeter on-chain program rejects
    // duplicate recipients (FLEX_ERROR__DUPLICATE_SPLIT_RECIPIENT);
    // mergeSplits is the declared remediation.
    const result = await resolveThreeRecipientSplits(makeEnv(), kv, baseSkill);
    // The dedup collapses the indexer + domain entries → 2 recipients total.
    expect(result.defaultSplits).toHaveLength(2);
    // Indexer = first entry by mergeSplits order (preserves first appearance).
    expect(result.defaultSplits[0].recipient).toBe(INDEXER_ATA);
    // Combined bps = indexer (3500) + domain (1500) = 5000.
    expect(result.defaultSplits[0].bps).toBe(
      DEFAULT_THREE_RECIPIENT_BPS.indexer + DEFAULT_THREE_RECIPIENT_BPS.domain,
    );
    expect(result.defaultSplits[1].recipient).toBe(PLATFORM_ATA);
    expect(result.defaultSplits[1].bps).toBe(DEFAULT_THREE_RECIPIENT_BPS.platform);
    expect(result.defaultSplits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
  });
});

describe("createUptoHandlerForSkill — wire shape passed to createUptoHandler", () => {
  const baseSkill = {
    contributors: [contributor("indexer-1", INDEXER_ATA, 100)],
    domain: "example.com",
    owner_compensation_opt_in: true,
    owner_wallet_usdc_ata: undefined,
    markup_bps: undefined,
  } satisfies Pick<
    SkillManifest,
    "contributors" | "domain" | "owner_compensation_opt_in" | "owner_wallet_usdc_ata" | "markup_bps"
  >;

  it("passes facilitatorURL + accepts (indexer payTo) + authorize + handle to the upto factory", async () => {
    const kv = new MemKV();
    kv.set(
      "domain-wallet:example.com",
      JSON.stringify({ wallet_usdc_ata: DOMAIN_ATA, schema_version: 1 }),
    );

    let capturedOpts: Record<string, unknown> | null = null;
    const stubFactory = async (opts: unknown) => {
      capturedOpts = opts as Record<string, unknown>;
      return (() => new Response("stub", { status: 200 })) as never;
    };

    const noopHandle = async (_body: unknown, settle: (amount: bigint) => Promise<unknown>) => {
      await settle(BigInt(1000));
      return new Response("ok");
    };

    const { handler, split } = await createUptoHandlerForSkill(makeEnv(), {
      facilitatorURL: "https://facilitator.example.com",
      skill: baseSkill,
      maxAmountUc: "10000",
      handle: noopHandle,
      kv,
      uptoFactory: stubFactory,
    });

    expect(typeof handler).toBe("function");
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.facilitatorURL).toBe("https://facilitator.example.com");

    const accepts = capturedOpts!.accepts as Array<Record<string, unknown>>;
    expect(accepts).toHaveLength(1);
    expect(accepts[0].scheme).toBe("flex");
    expect(accepts[0].network).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(accepts[0].asset).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(accepts[0].amount).toBe("10000");
    // payTo MUST be the indexer ATA (variable receiver per buildSplits convention).
    expect(accepts[0].payTo).toBe(INDEXER_ATA);

    expect(typeof capturedOpts!.authorize).toBe("function");
    expect(typeof capturedOpts!.handle).toBe("function");

    // The three-recipient split is returned alongside the handler.
    expect(split.recipients.indexer_ata).toBe(INDEXER_ATA);
    expect(split.recipients.domain_or_hold_ata).toBe(DOMAIN_ATA);
    expect(split.recipients.platform_ata).toBe(PLATFORM_ATA);
    expect(split.defaultSplits).toHaveLength(3);
    expect(split.defaultSplits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
  });

  it("authorize defaults to the maxAmountUc ceiling when not overridden", async () => {
    const kv = new MemKV();
    let capturedOpts: Record<string, unknown> | null = null;
    const stubFactory = async (opts: unknown) => {
      capturedOpts = opts as Record<string, unknown>;
      return (() => new Response("stub", { status: 200 })) as never;
    };

    await createUptoHandlerForSkill(makeEnv(), {
      facilitatorURL: "https://f.example",
      skill: baseSkill,
      maxAmountUc: "50000",
      handle: async () => new Response("ok"),
      kv,
      uptoFactory: stubFactory,
    });

    const authorize = capturedOpts!.authorize as (body: unknown) => Promise<bigint> | bigint;
    const ceiling = await authorize({});
    expect(ceiling).toBe(BigInt(50000));
  });
});

describe("DEFAULT_THREE_RECIPIENT_BPS — primitive doc 07 invariants", () => {
  it("sums to 10000 and matches the 50/35/15 documented split", () => {
    const total =
      DEFAULT_THREE_RECIPIENT_BPS.indexer +
      DEFAULT_THREE_RECIPIENT_BPS.domain +
      DEFAULT_THREE_RECIPIENT_BPS.platform;
    expect(total).toBe(10000);

    // primitive doc 07 + the 50/35/15 docs migration: platform 50%,
    // indexer 35%, domain owner 15%.
    expect(DEFAULT_THREE_RECIPIENT_BPS.platform).toBe(5000);
    expect(DEFAULT_THREE_RECIPIENT_BPS.indexer).toBe(3500);
    expect(DEFAULT_THREE_RECIPIENT_BPS.domain).toBe(1500);
  });
});
