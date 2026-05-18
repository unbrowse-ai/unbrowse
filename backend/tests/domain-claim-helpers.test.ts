import { describe, expect, it } from "bun:test";
import {
  buildTxtName,
  buildTxtValue,
  buildChallengeKey,
  buildBindingKey,
  buildRateLimitKey,
  isValidApexDomain,
  isValidSolanaPubkey,
  mintChallenge,
  verifyTxtBothProviders,
} from "../src/services/domain-claim.js";

// Pure-function falsifier tests for helpers shipped in Step 3 of the firmament
// DNS-claim primitive. No mocks, no spies, no network. Every test pins one
// behavior the design contract in .claude/firmament-step2.md demands.

// ---------------------------------------------------------------------------
// buildTxtName
// ---------------------------------------------------------------------------

describe("buildTxtName", () => {
  it("apex domain produces _unbrowse-claim.<domain>", () => {
    expect(buildTxtName("example.com")).toBe("_unbrowse-claim.example.com");
  });

  it("lowercases uppercase input (RFC 1035 case-insensitivity + ingress norm)", () => {
    expect(buildTxtName("EXAMPLE.COM")).toBe("_unbrowse-claim.example.com");
  });

  it("trims leading and trailing whitespace before prefixing", () => {
    expect(buildTxtName("  example.com  ")).toBe("_unbrowse-claim.example.com");
  });

  it("TODO trailing dot in input is NOT stripped by current impl — spec implies it should be (firmament-step2.md L186 .toLowerCase only). Pinning current behavior so a future strip-trailing-dot fix is a visible test-update, not a silent semantic shift.", () => {
    // Current impl: trim().toLowerCase() only. Trailing dot survives.
    expect(buildTxtName("example.com.")).toBe("_unbrowse-claim.example.com.");
  });

  it("empty string input does NOT throw — returns a deterministic (degenerate) name", () => {
    // Current impl pins to `_unbrowse-claim.`. isValidApexDomain is the gate
    // that callers are supposed to run first; this helper is dumb on purpose.
    expect(buildTxtName("")).toBe("_unbrowse-claim.");
  });

  it("whitespace-only input does NOT throw — same degenerate shape as empty", () => {
    expect(buildTxtName("   ")).toBe("_unbrowse-claim.");
  });
});

// ---------------------------------------------------------------------------
// buildTxtValue
// ---------------------------------------------------------------------------

describe("buildTxtValue", () => {
  it("shape is unbrowse-claim=<challenge>;wallet=<wallet> byte-for-byte", () => {
    const challenge = "a".repeat(64);
    const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    expect(buildTxtValue(challenge, wallet)).toBe(
      `unbrowse-claim=${challenge};wallet=${wallet}`,
    );
  });

  it("contains no extra whitespace", () => {
    const v = buildTxtValue("ch", "wal");
    expect(v).toBe("unbrowse-claim=ch;wallet=wal");
    expect(/\s/.test(v)).toBe(false);
  });

  it("contains no trailing newline (DNS TXT must be exactly this string)", () => {
    const v = buildTxtValue("ch", "wal");
    expect(v.endsWith("\n")).toBe(false);
    expect(v.endsWith("\r")).toBe(false);
  });

  it("separator between challenge and wallet is exactly ';' (no spaces)", () => {
    const v = buildTxtValue("CHAL", "WAL");
    expect(v).toBe("unbrowse-claim=CHAL;wallet=WAL");
    expect(v.includes("; ")).toBe(false);
    expect(v.includes(" ;")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildChallengeKey / buildBindingKey / buildRateLimitKey
// ---------------------------------------------------------------------------

describe("KV key builders", () => {
  it("buildChallengeKey contains BOTH domain and wallet (tuple-scoped per spec)", () => {
    const k = buildChallengeKey("example.com", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    expect(k).toContain("example.com");
    expect(k).toContain("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    expect(k).toBe(
      "domain-claim-challenge:example.com:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    );
  });

  it("buildChallengeKey lowercases the domain portion", () => {
    const upper = buildChallengeKey("EXAMPLE.COM", "Wal123");
    const lower = buildChallengeKey("example.com", "Wal123");
    expect(upper).toBe(lower);
  });

  it("buildChallengeKey trims domain whitespace", () => {
    const padded = buildChallengeKey("  example.com  ", "Wal123");
    const clean = buildChallengeKey("example.com", "Wal123");
    expect(padded).toBe(clean);
  });

  it("TODO buildChallengeKey does NOT normalize wallet casing — spec is silent. Same wallet typed two ways would mint two separate challenges. Pinning current behavior; flag for review when admin tooling lands.", () => {
    const lowerWallet = buildChallengeKey("example.com", "wal123");
    const upperWallet = buildChallengeKey("example.com", "WAL123");
    expect(lowerWallet).not.toBe(upperWallet);
  });

  it("buildBindingKey is domain-only (no wallet)", () => {
    const k = buildBindingKey("example.com");
    expect(k).toBe("domain-wallet:example.com");
    expect(k.includes("wallet:")).toBe(true);
    // No wallet token appended after the domain.
    expect(k.split(":").length).toBe(2);
  });

  it("buildBindingKey lowercases the domain", () => {
    expect(buildBindingKey("EXAMPLE.COM")).toBe(buildBindingKey("example.com"));
  });

  it("buildRateLimitKey is domain-only (no wallet)", () => {
    const k = buildRateLimitKey("example.com");
    expect(k).toBe("domain-claim-rl:example.com");
    expect(k.split(":").length).toBe(2);
  });

  it("buildRateLimitKey lowercases the domain", () => {
    expect(buildRateLimitKey("EXAMPLE.COM")).toBe(buildRateLimitKey("example.com"));
  });

  it("same domain in different casings produces the same key across all three builders", () => {
    const wallet = "Wal123";
    expect(buildChallengeKey("Example.Com", wallet)).toBe(
      buildChallengeKey("example.com", wallet),
    );
    expect(buildBindingKey("Example.Com")).toBe(buildBindingKey("example.com"));
    expect(buildRateLimitKey("Example.Com")).toBe(buildRateLimitKey("example.com"));
  });
});

// ---------------------------------------------------------------------------
// isValidApexDomain
// ---------------------------------------------------------------------------

describe("isValidApexDomain", () => {
  it("accepts a plain apex example.com", () => {
    expect(isValidApexDomain("example.com")).toBe(true);
  });

  it("accepts a two-level TLD example.co.uk (per regex shape)", () => {
    expect(isValidApexDomain("example.co.uk")).toBe(true);
  });

  it("rejects www.example.com (subdomain prefix list)", () => {
    expect(isValidApexDomain("www.example.com")).toBe(false);
  });

  it("rejects api.example.com (subdomain prefix list)", () => {
    expect(isValidApexDomain("api.example.com")).toBe(false);
  });

  it("rejects every prefix in the REJECTED_SUBDOMAIN_PREFIXES table", () => {
    const cases = [
      "app.example.com",
      "blog.example.com",
      "docs.example.com",
      "mail.example.com",
      "static.example.com",
      "assets.example.com",
      "cdn.example.com",
      "m.example.com",
    ];
    for (const c of cases) {
      expect(isValidApexDomain(c)).toBe(false);
    }
  });

  it("accepts EXAMPLE.COM after internal lowercasing (firmament-step2.md L186)", () => {
    expect(isValidApexDomain("EXAMPLE.COM")).toBe(true);
  });

  it("rejects bare label with no dot", () => {
    expect(isValidApexDomain("example")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidApexDomain("")).toBe(false);
  });

  it("accepts surrounding whitespace by trimming internally", () => {
    // Pinning behavior: trim is done inside the helper, so padded input is accepted.
    expect(isValidApexDomain("  example.com  ")).toBe(true);
  });

  it("accepts punycode-shaped xn--example.com (regex permits hyphens in labels)", () => {
    expect(isValidApexDomain("xn--example.com")).toBe(true);
  });

  it("rejects trailing dot example.com. (regex anchors disallow empty final label)", () => {
    // Note: divergence with buildTxtName, which does NOT strip the trailing dot.
    // The validator catches it; the namer does not. Callers must validate first.
    expect(isValidApexDomain("example.com.")).toBe(false);
  });

  it("rejects labels with leading hyphen", () => {
    expect(isValidApexDomain("-bad.com")).toBe(false);
  });

  it("rejects labels with trailing hyphen", () => {
    expect(isValidApexDomain("bad-.com")).toBe(false);
  });

  it("rejects a domain longer than 253 chars", () => {
    // 5 labels of 60 chars + 4 dots = 304 chars total. Each label still <=63.
    const long = ["a", "b", "c", "d", "e"].map((c) => c.repeat(60)).join(".");
    expect(long.length).toBeGreaterThan(253);
    expect(isValidApexDomain(long)).toBe(false);
  });

  it("rejects a label longer than 63 chars", () => {
    const big = "a".repeat(64) + ".com";
    expect(isValidApexDomain(big)).toBe(false);
  });

  it("rejects non-string input safely", () => {
    expect(isValidApexDomain(undefined as unknown as string)).toBe(false);
    expect(isValidApexDomain(null as unknown as string)).toBe(false);
    expect(isValidApexDomain(123 as unknown as string)).toBe(false);
  });
});
// ---------------------------------------------------------------------------
// isValidSolanaPubkey
// ---------------------------------------------------------------------------

describe("isValidSolanaPubkey", () => {
  it("accepts a 44-char base58 string (real Solana pubkey length)", () => {
    expect(isValidSolanaPubkey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBe(true);
  });

  it("accepts a 32-char base58 string (minimum boundary)", () => {
    // 32 chars from the base58 alphabet (no 0, O, I, l).
    const s = "abcdefghijkmnpqrstuvwxyzABCDEFGH";
    expect(s.length).toBe(32);
    expect(isValidSolanaPubkey(s)).toBe(true);
  });

  it("rejects 31-char string (below minimum)", () => {
    const s = "abcdefghijkmnpqrstuvwxyzABCDEFG";
    expect(s.length).toBe(31);
    expect(isValidSolanaPubkey(s)).toBe(false);
  });

  it("rejects 45-char string (above maximum)", () => {
    const s = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVW";
    expect(s.length).toBe(45);
    expect(isValidSolanaPubkey(s)).toBe(false);
  });

  it("rejects strings containing '0' (not in base58 alphabet)", () => {
    const s = "0bcdefghijkmnpqrstuvwxyzABCDEFGH"; // length 32
    expect(s.length).toBe(32);
    expect(isValidSolanaPubkey(s)).toBe(false);
  });

  it("rejects strings containing 'O' (not in base58 alphabet)", () => {
    const s = "Obcdefghijkmnpqrstuvwxyzabcdefgh"; // length 32
    expect(s.length).toBe(32);
    expect(isValidSolanaPubkey(s)).toBe(false);
  });

  it("rejects strings containing 'I' (not in base58 alphabet)", () => {
    const s = "Ibcdefghijkmnpqrstuvwxyzabcdefgh"; // length 32
    expect(s.length).toBe(32);
    expect(isValidSolanaPubkey(s)).toBe(false);
  });

  it("rejects strings containing 'l' (not in base58 alphabet)", () => {
    const s = "lbcdefghijkmnpqrstuvwxyzabcdefgh"; // length 32
    expect(s.length).toBe(32);
    expect(isValidSolanaPubkey(s)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidSolanaPubkey("")).toBe(false);
  });

  it("rejects strings with special characters", () => {
    expect(isValidSolanaPubkey("abcdefghijkmnpqrstuvwxyzABCDEFG!")).toBe(false);
    expect(isValidSolanaPubkey("abcdefghijkmnpqrstuvwxyzABCDEF-G")).toBe(false);
    expect(isValidSolanaPubkey("abcdefghijkmnpqrstuvwxyzABCDE F G")).toBe(false);
  });

  it("rejects non-string input safely", () => {
    expect(isValidSolanaPubkey(undefined as unknown as string)).toBe(false);
    expect(isValidSolanaPubkey(null as unknown as string)).toBe(false);
    expect(isValidSolanaPubkey(123 as unknown as string)).toBe(false);
  });

  it("rejects 'xxx' (the malformed wallet used in the routes skeleton test)", () => {
    expect(isValidSolanaPubkey("xxx")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mintChallenge
// ---------------------------------------------------------------------------

describe("mintChallenge", () => {
  it("returns a string of exactly 64 chars (32 bytes hex-encoded)", () => {
    const c = mintChallenge();
    expect(typeof c).toBe("string");
    expect(c.length).toBe(64);
  });

  it("only contains [0-9a-f]", () => {
    const c = mintChallenge();
    expect(/^[0-9a-f]{64}$/.test(c)).toBe(true);
  });

  it("two consecutive calls produce different challenges (randomness sanity)", () => {
    const a = mintChallenge();
    const b = mintChallenge();
    expect(a).not.toBe(b);
  });

  it("100 consecutive calls produce 100 unique challenges (no collision in small batch)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      seen.add(mintChallenge());
    }
    expect(seen.size).toBe(100);
  });

  it("output is compatible with the regex the routes contract pins (/^[0-9a-f]{64}$/)", () => {
    const c = mintChallenge();
    expect(c).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// verifyTxtBothProviders stub
// ---------------------------------------------------------------------------

describe("verifyTxtBothProviders (step 2 stub)", () => {
  it("returns { ok: false, reason: 'not_implemented' } today", async () => {
    const r = await verifyTxtBothProviders("_unbrowse-claim.example.com", "unbrowse-claim=x;wallet=y");
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toBe("not_implemented");
    }
  });

  it("returns a Promise (async signature)", () => {
    const p = verifyTxtBothProviders("a", "b");
    expect(p).toBeInstanceOf(Promise);
  });

  it("returns the same not_implemented reason regardless of args (stub is arg-agnostic)", async () => {
    const r1 = await verifyTxtBothProviders("", "");
    const r2 = await verifyTxtBothProviders("_unbrowse-claim.x.com", "unbrowse-claim=abc;wallet=def");
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (r1.ok === false && r2.ok === false) {
      expect(r1.reason).toBe(r2.reason);
      expect(r1.reason).toBe("not_implemented");
    }
  });
});
