/**
 * Tests for the SDK helper modules — pure-function decisions, no I/O.
 * Each helper stays hermetic; no real network, no real file IO, no real
 * wallet.
 */
import { describe, it, expect } from "bun:test";
import {
  tier1RouteCacheLookup,
  tier2PreferenceBias,
  tier3IqAttestationLookup,
  composeOnChainDecision,
  etldPlusOne,
  type RouteCacheRow,
  type PreferenceBias,
  type IqAttestationRow,
} from "../packages/sdk-v2/src/onchain.js";
import {
  resolveCaptchaDispatch,
  detectCaptchaVendor,
  extractSitekey,
  categorizeSolverOutcome,
  VENDOR_TASK_TYPE,
} from "../packages/sdk-v2/src/captcha.js";
import {
  resolveProxyUrl,
  resolveEgressProxy,
  applyIproyalOverrides,
  formatIproyalUrl,
  redactProxyUrl,
  type IproyalCreds,
} from "../packages/sdk-v2/src/iproyal.js";

const NOW = 1_700_000_000_000;

describe("onchain — tier1RouteCacheLookup", () => {
  const rows: RouteCacheRow[] = [
    { endpoint_id: "e1", intent: "listings", context_url: "https://example.com/", commitment: "sha256:1", captured_at: NOW - 1000, score: 0.8 },
    { endpoint_id: "e2", intent: "listings", context_url: "https://example.com/", commitment: "sha256:2", captured_at: NOW - 500, score: 0.6 },
    { endpoint_id: "e3", intent: "search", context_url: "https://example.com/", commitment: "sha256:3", captured_at: NOW - 100, score: 0.9 },
  ];

  it("returns the freshest matching row within the staleness window", () => {
    const hit = tier1RouteCacheLookup(rows, "listings", "https://example.com/", 86_400_000, NOW);
    expect(hit?.endpoint_id).toBe("e2"); // 500ms ago beats 1000ms ago
  });

  it("returns null when intent doesn't match", () => {
    expect(tier1RouteCacheLookup(rows, "nonexistent", "https://example.com/", 86_400_000, NOW)).toBeNull();
  });

  it("returns null when context_url doesn't match", () => {
    expect(tier1RouteCacheLookup(rows, "listings", "https://other.com/", 86_400_000, NOW)).toBeNull();
  });

  it("returns null when the only match is stale", () => {
    const staleRows: RouteCacheRow[] = [
      { ...rows[0], captured_at: NOW - 200_000 }, // > 24h window
    ];
    expect(tier1RouteCacheLookup(staleRows, "listings", "https://example.com/", 100_000, NOW)).toBeNull();
  });
});

describe("onchain — tier2PreferenceBias", () => {
  const prefs: PreferenceBias = {
    strong: new Set(["example.com", "github.com"]),
    weak: new Set(["reddit.com", "news.ycombinator.com"]),
  };

  it("returns 'strong' when the eTLD+1 is bookmarked", () => {
    expect(tier2PreferenceBias("https://www.example.com/path?query", prefs)).toBe("strong");
  });

  it("returns 'weak' when the eTLD+1 is recently visited", () => {
    expect(tier2PreferenceBias("https://old.reddit.com/r/x", prefs)).toBe("weak");
  });

  it("returns null when the eTLD+1 is neither", () => {
    expect(tier2PreferenceBias("https://unknown.org/", prefs)).toBeNull();
  });

  it("strips subdomain/path/query — only eTLD+1 leaves the function", () => {
    expect(tier2PreferenceBias("https://deep.sub.example.com/anywhere", prefs)).toBe("strong");
  });
});

describe("onchain — tier3IqAttestationLookup", () => {
  const attestations: IqAttestationRow[] = [
    { commitment: "sha256:1", attested_at: NOW - 1000, signed_by_child: true },
    { commitment: "sha256:2", attested_at: NOW - 500, signed_by_child: false }, // unsigned
    { commitment: "sha256:3", attested_at: NOW - 100, signed_by_child: true },
  ];

  it("returns the signed attestation matching the commitment", () => {
    const hit = tier3IqAttestationLookup(attestations, "sha256:1");
    expect(hit?.commitment).toBe("sha256:1");
    expect(hit?.signed_by_child).toBe(true);
  });

  it("skips unsigned attestations", () => {
    expect(tier3IqAttestationLookup(attestations, "sha256:2")).toBeNull();
  });

  it("returns null when commitment doesn't match", () => {
    expect(tier3IqAttestationLookup(attestations, "sha256:nope")).toBeNull();
  });
});

describe("onchain — composeOnChainDecision", () => {
  const tier1Hit: RouteCacheRow = {
    endpoint_id: "e1", intent: "x", context_url: "y",
    commitment: "sha256:1", captured_at: NOW - 100, score: 0.8,
  };
  const tier3Match: IqAttestationRow = {
    commitment: "sha256:1", attested_at: NOW - 1000, signed_by_child: true,
  };

  it("returns 'replay' on tier-1 hit", () => {
    const d = composeOnChainDecision(tier1Hit, null, null);
    expect(d.action).toBe("replay");
    expect(d.endpoint_id).toBe("e1");
    expect(d.commitment).toBe("sha256:1");
  });

  it("boosts score +50% when tier-1 hit + tier-2 strong", () => {
    const d = composeOnChainDecision(tier1Hit, "strong", null);
    expect(d.action).toBe("replay");
    expect(d.preference_bias).toBe("strong");
    expect(d.reason).toMatch(/strong-pref/);
  });

  it("sets attested_on_chain when tier-3 matches tier-1 commitment", () => {
    const d = composeOnChainDecision(tier1Hit, null, tier3Match);
    expect(d.action).toBe("replay");
    expect(d.attested_on_chain).toBe(true);
  });

  it("returns 'live_fetch_direct' on tier-1 miss + bookmarked (strong)", () => {
    const d = composeOnChainDecision(null, "strong", null);
    expect(d.action).toBe("live_fetch_direct");
    expect(d.preference_bias).toBe("strong");
  });

  it("returns 'live_fetch_iproyal' on tier-1 miss + visited (weak)", () => {
    const d = composeOnChainDecision(null, "weak", null);
    expect(d.action).toBe("live_fetch_iproyal");
    expect(d.preference_bias).toBe("weak");
  });

  it("returns 'live_fetch_iproyal' on tier-1 + tier-2 miss + tier-3 attestation exists", () => {
    const d = composeOnChainDecision(null, null, tier3Match);
    expect(d.action).toBe("live_fetch_iproyal");
    expect(d.attested_on_chain).toBe(true);
  });

  it("returns 'live_fetch_with_captcha' on all-miss (unknown frontier)", () => {
    const d = composeOnChainDecision(null, null, null);
    expect(d.action).toBe("live_fetch_with_captcha");
    expect(d.preference_bias).toBeNull();
  });
});

describe("onchain — etldPlusOne", () => {
  it("returns the registrable domain for a two-label host", () => {
    expect(etldPlusOne("https://example.com/path")).toBe("example.com");
  });

  it("strips subdomains", () => {
    expect(etldPlusOne("https://deep.sub.example.com/x")).toBe("example.com");
  });

  it("returns null for an invalid URL", () => {
    expect(etldPlusOne("not a url")).toBeNull();
  });
});

describe("captcha — resolveCaptchaDispatch", () => {
  it("returns null when auto_solve is false", () => {
    expect(resolveCaptchaDispatch({ auto_solve: false }, {})).toBeNull();
  });

  it("turnkey: routes to capzy when UNBROWSE_CAPZY_KEY is set", () => {
    const cfg = resolveCaptchaDispatch(
      { auto_solve: true, detected_vendor: "cloudflare" },
      { UNBROWSE_CAPZY_KEY: "k" },
    );
    expect(cfg?.mode).toBe("turnkey");
    if (cfg?.mode === "turnkey") {
      expect(cfg.payment_through).toBe("capzy_balance");
      expect(cfg.task_type).toBe("TurnstileTaskProxyless");
    }
  });

  it("turnkey: routes to paysponge/2captcha when no capzy key", () => {
    const cfg = resolveCaptchaDispatch(
      { auto_solve: true, detected_vendor: "recaptcha" },
      {},
    );
    expect(cfg?.mode).toBe("turnkey");
    if (cfg?.mode === "turnkey") {
      expect(cfg.payment_through).toBe("x402_paysponge");
      expect(cfg.task_type).toBe("RecaptchaV2TaskProxyless");
    }
  });

  it("byok: requires api_key", () => {
    expect(resolveCaptchaDispatch({ auto_solve: true, mode: "byok", vendor: "capsolver" }, {})).toBeNull();
  });

  it("byok: capsolver endpoint and auth header", () => {
    const cfg = resolveCaptchaDispatch(
      { auto_solve: true, mode: "byok", vendor: "capsolver", api_key: "CAP-xxx", detected_vendor: "hcaptcha" },
      {},
    );
    expect(cfg?.mode).toBe("byok");
    if (cfg?.mode === "byok") {
      expect(cfg.vendor).toBe("capsolver");
      expect(cfg.endpoint).toBe("https://api.capsolver.com/createTask");
      expect(cfg.task_type).toBe("HCaptchaTaskProxyless");
    }
  });

  it("byok: 2captcha endpoint when explicitly chosen", () => {
    const cfg = resolveCaptchaDispatch(
      { auto_solve: true, mode: "byok", vendor: "2captcha", api_key: "k", detected_vendor: "funcaptcha" },
      {},
    );
    if (cfg?.mode === "byok") {
      expect(cfg.vendor).toBe("2captcha");
      expect(cfg.endpoint).toBe("https://2captcha.com/in.php");
      expect(cfg.task_type).toBe("FunCaptchaTaskProxyless");
    }
  });

  it("narrow_first task type surfaces when captcha_vendor is ambiguous", () => {
    const cfg = resolveCaptchaDispatch(
      { auto_solve: true, detected_vendor: "captcha_vendor" },
      {},
    );
    if (cfg?.mode === "turnkey") {
      expect(cfg.task_type).toBe("narrow_first");
      expect(cfg.narrow_first).toBe(true);
    }
  });
});

describe("captcha — detectCaptchaVendor", () => {
  it("detects cloudflare turnstile", () => {
    expect(detectCaptchaVendor('<div class="cf-turnstile" data-sitekey="x"></div>')).toBe("cloudflare");
  });

  it("detects recaptcha v2", () => {
    expect(detectCaptchaVendor('<div class="g-recaptcha" data-sitekey="x"></div>')).toBe("recaptcha");
  });

  it("detects hcaptcha", () => {
    expect(detectCaptchaVendor('<div class="h-captcha" data-sitekey="x"></div>')).toBe("hcaptcha");
  });

  it("detects arkoselabs via funcaptcha", () => {
    expect(detectCaptchaVendor('<iframe src="https://client-api.arkoselabs.com/fc/api/?session=x"></iframe>')).toBe("arkoselabs");
  });

  it("returns null on plain body with no captcha marker", () => {
    expect(detectCaptchaVendor("<html><body>hello</body></html>")).toBeNull();
  });

  it("returns 'captcha_vendor' on bare data-sitekey match (ambiguous)" , () => {
    expect(detectCaptchaVendor('<input data-sitekey="abc">')).toBe("captcha_vendor");
  });
});

describe("captcha — extractSitekey", () => {
  it("extracts double-quoted sitekey", () => {
    expect(extractSitekey('<div data-sitekey="0xabc123"></div>')).toBe("0xabc123");
  });

  it("extracts single-quoted sitekey", () => {
    expect(extractSitekey("<div data-sitekey='0xdef'></div>")).toBe("0xdef");
  });

  it("returns null when no sitekey present", () => {
    expect(extractSitekey("<div></div>")).toBeNull();
  });
});

describe("captcha — categorizeSolverOutcome", () => {
  it("maps each known status", () => {
    expect(categorizeSolverOutcome("dispatched")).toBe("solved");
    expect(categorizeSolverOutcome("token_received")).toBe("solved");
    expect(categorizeSolverOutcome("replay_success")).toBe("replayed");
    expect(categorizeSolverOutcome("failed_no_sitekey")).toBe("no_sitekey");
    expect(categorizeSolverOutcome("failed_no_wallet")).toBe("no_wallet");
    expect(categorizeSolverOutcome("failed_solver_error")).toBe("solver_failed");
    expect(categorizeSolverOutcome("failed_replay_blocked")).toBe("replay_blocked");
    expect(categorizeSolverOutcome("byok_dispatched")).toBe("solved");
  });

  it("defaults to 'not_dispatched' on missing/unknown status", () => {
    expect(categorizeSolverOutcome(undefined)).toBe("not_dispatched");
    expect(categorizeSolverOutcome(null)).toBe("not_dispatched");
    expect(categorizeSolverOutcome("")).toBe("not_dispatched");
    expect(categorizeSolverOutcome("nonsense")).toBe("not_dispatched");
  });
});

describe("iproyal — resolveProxyUrl", () => {
  it("returns undefined when UNBROWSE_DIRECT_EGRESS=1", () => {
    expect(resolveProxyUrl({ UNBROWSE_DIRECT_EGRESS: "1", IPROYAL_USER: "u", IPROYAL_PASS: "p" })).toBeUndefined();
  });

  it("returns UNBROWSE_PROXY_URL when set", () => {
    expect(resolveProxyUrl({ UNBROWSE_PROXY_URL: "http://other:8080" })).toBe("http://other:8080");
  });

  it("builds IPRoyal URL from env creds", () => {
    expect(resolveProxyUrl({ IPROYAL_USER: "u1", IPROYAL_PASS: "p1_country-my" })).toBe(
      "http://u1:p1_country-my@geo.iproyal.com:12321",
    );
  });

  it("falls back to file creds when env is empty", () => {
    const fileCreds: IproyalCreds = { username: "fu", password: "fp", host: "geo.iproyal.com", port: 12321 };
    expect(resolveProxyUrl({}, () => fileCreds)).toBe("http://fu:fp@geo.iproyal.com:12321");
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveProxyUrl({})).toBeUndefined();
  });
});

describe("iproyal — resolveEgressProxy", () => {
  const fileCreds: IproyalCreds = { username: "fu", password: "fp", host: "geo.iproyal.com", port: 12321 };

  it("per-call override 'direct' short-circuits to undefined", () => {
    expect(resolveEgressProxy({ IPROYAL_USER: "u", IPROYAL_PASS: "p" }, { mode: "direct" })).toBeUndefined();
  });

  it("per-call override 'residential' forces IPRoyal even with UNBROWSE_DIRECT_EGRESS set", () => {
    const url = resolveEgressProxy(
      { UNBROWSE_DIRECT_EGRESS: "1", IPROYAL_USER: "u", IPROYAL_PASS: "p" },
      { mode: "residential" },
    );
    expect(url).toContain("geo.iproyal.com:12321");
  });

  it("per-call override country/session appends to password", () => {
    const url = resolveEgressProxy(
      { IPROYAL_USER: "u", IPROYAL_PASS: "p" },
      { mode: "residential", country: "my", session_id: "s1" },
    );
    expect(url).toBe("http://u:p_country-my_session-s1@geo.iproyal.com:12321");
  });

  it("falls back to file creds under residential override", () => {
    const url = resolveEgressProxy({}, { mode: "residential" }, () => fileCreds);
    expect(url).toBe("http://fu:fp@geo.iproyal.com:12321");
  });

  it("precedence: DIRECT > PROXY_URL > IPRoyal(file)", () => {
    expect(resolveEgressProxy({ UNBROWSE_DIRECT_EGRESS: "1" }, null, () => fileCreds)).toBeUndefined();
    expect(resolveEgressProxy({ UNBROWSE_PROXY_URL: "http://x:y@h:1" }, null, () => fileCreds)).toBe("http://x:y@h:1");
    expect(resolveEgressProxy({}, null, () => fileCreds)).toContain("geo.iproyal.com:12321");
  });
});

describe("iproyal — applyIproyalOverrides", () => {
  const creds: IproyalCreds = { username: "u", password: "p", host: "h", port: 1 };

  it("appends country suffix", () => {
    expect(applyIproyalOverrides(creds, { country: "my" }).password).toBe("p_country-my");
  });

  it("appends session suffix", () => {
    expect(applyIproyalOverrides(creds, { session_id: "s1" }).password).toBe("p_session-s1");
  });

  it("appends both in order country, session", () => {
    expect(applyIproyalOverrides(creds, { country: "my", session_id: "s1" }).password).toBe("p_country-my_session-s1");
  });

  it("returns the creds unchanged when no overrides", () => {
    expect(applyIproyalOverrides(creds, null).password).toBe("p");
  });
});

describe("iproyal — format + redact", () => {
  it("formatIproyalUrl builds the canonical http://user:pass@host:port form", () => {
    expect(formatIproyalUrl({ username: "u", password: "p", host: "h", port: 1 })).toBe("http://u:p@h:1");
  });

  it("redactProxyUrl redacts credentials", () => {
    const url = formatIproyalUrl({ username: "secret_user", password: "secret_pass", host: "h", port: 1 });
    const redacted = redactProxyUrl(url);
    expect(redacted).not.toContain("secret_user");
    expect(redacted).not.toContain("secret_pass");
    expect(redacted).toContain("h:1");
  });

  it("redactProxyUrl returns undefined for undefined input", () => {
    expect(redactProxyUrl(undefined)).toBeUndefined();
  });
});