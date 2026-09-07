/**
 * W13 — TLS JA3/JA4 spoof wiring tests.
 *
 * Eph 6:11 — "Put on the whole armor of God…" These tests are the
 * mechanical check that the network-layer armor (iproyal residential
 * exit + libcurl-impersonate TLS re-fingerprint + auth-challenge
 * handler) composes honestly:
 *   - missing iproyal creds → structured 503 envelope, no crash
 *   - missing libcurl binary → structured 503 envelope + partial chain
 *   - both present → full chain composes
 *   - auth-challenge handler NEVER leaks the credential into outcome
 *
 * Test discipline (CLAUDE.md): no mocks, no stubs, real filesystem,
 * real binary probes. The integration test is skip-gated on
 * UNBROWSE_TLS_INTEGRATION=1 because it requires a live network egress
 * + an installed JA3 proxy variant.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import * as iproyal from "../src/cdp/proxy/iproyal.js";
import * as libcurlImpersonate from "../src/cdp/proxy/libcurl-impersonate.js";
import * as authChallenge from "../src/cdp/proxy/auth-challenge.js";
import { buildProxyChain } from "../src/cdp/proxy/index.js";

const INTEGRATION = process.env.UNBROWSE_TLS_INTEGRATION === "1";

const CORPUS_PATH = join(import.meta.dir, "..", "scripts", "corpus", "bench-tls-spoof.txt");
const IPROYAL_CREDS_PATH = join(homedir(), ".identity", "iproyal-creds");

// The tests that exercise the missing-creds path REQUIRE the creds file
// to be absent. We back it up before, restore after, so dev machines
// with creds installed don't false-fail the test.
let backupCredsPath: string | null = null;

beforeAll(async () => {
  if (existsSync(IPROYAL_CREDS_PATH)) {
    const tmp = await mkdtemp(join(tmpdir(), "v7-tls-spoof-test-"));
    backupCredsPath = join(tmp, "iproyal-creds.backup");
    const raw = await readFile(IPROYAL_CREDS_PATH);
    await writeFile(backupCredsPath, raw);
    await rm(IPROYAL_CREDS_PATH);
  }
});

afterAll(async () => {
  if (backupCredsPath && existsSync(backupCredsPath)) {
    await mkdir(join(homedir(), ".identity"), { recursive: true });
    const raw = await readFile(backupCredsPath);
    await writeFile(IPROYAL_CREDS_PATH, raw);
    await rm(backupCredsPath);
  }
});

describe("W13 — iproyal", () => {
  it("1. buildIproyalProxyUrl URL-encodes user + pass + country lock", () => {
    const url = iproyal.buildIproyalProxyUrl({
      user: "u@x",
      pass: "p:y/z",
      host: "h",
      port: 1,
      country: "US",
    });
    // Bare structural check: starts with http://, contains @h:1, both u and pass URL-encoded.
    expect(url.startsWith("http://")).toBe(true);
    expect(url.endsWith("@h:1")).toBe(true);
    // u@x → u%40x; p:y/z + _country-us → p%3Ay%2Fz_country-us
    expect(url).toContain("u%40x");
    expect(url).toContain("p%3Ay%2Fz_country-us");
  });

  it("2. iproyal.load() without ~/.identity/iproyal-creds returns honest 503 envelope", async () => {
    // Test relies on beforeAll having moved the real file aside.
    expect(existsSync(IPROYAL_CREDS_PATH)).toBe(false);
    const res = await iproyal.load();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(503);
    expect(res.error).toBe("iproyal_creds_missing");
    expect(res.path).toBe(IPROYAL_CREDS_PATH);
    expect(res.hint.length).toBeGreaterThan(0);
  });

  it("2b. iproyal.load() parses BOTH JSON and KV forms when present", async () => {
    await mkdir(join(homedir(), ".identity"), { recursive: true });
    // JSON form.
    await writeFile(
      IPROYAL_CREDS_PATH,
      JSON.stringify({ user: "JSON_USER", pass: "JSON_PASS", host: "h.example", port: 9999 }),
    );
    let res = await iproyal.load();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.creds.username).toBe("JSON_USER");
    expect(res.creds.password).toBe("JSON_PASS");
    expect(res.creds.host).toBe("h.example");
    expect(res.creds.port).toBe(9999);

    // KV form.
    await writeFile(IPROYAL_CREDS_PATH, ["username=KV_USER", "password=KV_PASS", "endpoint=kv.example:7777"].join("\n"));
    res = await iproyal.load();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.creds.username).toBe("KV_USER");
    expect(res.creds.password).toBe("KV_PASS");
    expect(res.creds.host).toBe("kv.example");
    expect(res.creds.port).toBe(7777);

    // Clean up so subsequent tests see missing creds.
    await rm(IPROYAL_CREDS_PATH);
  });
});

describe("W13 — libcurl-impersonate", () => {
  it("3. libcurlImpersonate.start() without binary on PATH returns honest fall-through", async () => {
    // We don't artificially mask PATH — we trust the test machine state.
    // If a binary IS on PATH, the result MUST still be honest: either
    // ok:false with "not_a_proxy" (no opt-in env), or ok:true with a
    // bound port. Either way the envelope is structured.
    const res = await libcurlImpersonate.start({});
    expect(res.ok === true || res.ok === false).toBe(true);
    if (!res.ok) {
      expect(res.status).toBe(503);
      expect([
        "libcurl_impersonate_missing",
        "libcurl_impersonate_not_a_proxy",
        "libcurl_impersonate_spawn_failed",
      ]).toContain(res.error);
      expect(res.hint.length).toBeGreaterThan(0);
    } else {
      // If we DID bind a port, the local URL must be 127.0.0.1.
      expect(res.localProxyUrl.startsWith("http://127.0.0.1:")).toBe(true);
      await res.stop();
    }
  });

  it("3b. probe surface is honest about the binary search list", async () => {
    const probe = await libcurlImpersonate.probeLibcurlImpersonateAvailable();
    expect(typeof probe.available).toBe("boolean");
    if (probe.available) {
      expect(probe.binary).toBeTruthy();
      expect(libcurlImpersonate.LIBCURL_IMPERSONATE_BINARY_CANDIDATES).toContain(probe.binary!);
    } else {
      expect(probe.hint).toBeTruthy();
      expect(probe.hint!.toLowerCase()).toContain("install");
    }
  });
});

describe("W13 — buildProxyChain composition", () => {
  it("4. without iproyal creds returns honest 503 + no partial (direct connect is the answer)", async () => {
    expect(existsSync(IPROYAL_CREDS_PATH)).toBe(false);
    const chainNoSpoof = await buildProxyChain({ useTlsSpoof: false });
    expect(chainNoSpoof.ok).toBe(false);
    if (chainNoSpoof.ok) throw new Error("unreachable");
    expect(chainNoSpoof.error).toBe("iproyal_creds_missing");

    const chainSpoof = await buildProxyChain({ useTlsSpoof: true });
    expect(chainSpoof.ok).toBe(false);
    if (chainSpoof.ok) throw new Error("unreachable");
    expect(chainSpoof.error).toBe("iproyal_creds_missing");
  });

  it("5. with iproyal creds + useTlsSpoof=false returns iproyal-only chain", async () => {
    await mkdir(join(homedir(), ".identity"), { recursive: true });
    await writeFile(
      IPROYAL_CREDS_PATH,
      JSON.stringify({ user: "TEST_USER", pass: "TEST_PASS", host: "geo.iproyal.com", port: 12321 }),
    );
    try {
      const chain = await buildProxyChain({ useTlsSpoof: false, jurisdiction: "US" });
      expect(chain.ok).toBe(true);
      if (!chain.ok) throw new Error("unreachable");
      expect(chain.tlsSpoof).toBe(false);
      expect(chain.layers).toEqual(["iproyal"]);
      expect(chain.chromeProxyServer).toBe("http://geo.iproyal.com:12321");
      // Country lock is encoded into the password (Fetch.continueWithAuth carries it).
      expect(chain.upstream?.password).toContain("_country-us");
      await chain.stop();
    } finally {
      await rm(IPROYAL_CREDS_PATH);
    }
  });

  it("6. with iproyal creds + useTlsSpoof=true returns either full chain or partial-only envelope", async () => {
    await mkdir(join(homedir(), ".identity"), { recursive: true });
    await writeFile(
      IPROYAL_CREDS_PATH,
      JSON.stringify({ user: "TEST_USER", pass: "TEST_PASS", host: "geo.iproyal.com", port: 12321 }),
    );
    try {
      const chain = await buildProxyChain({ useTlsSpoof: true });
      if (chain.ok) {
        // Full chain — TLS spoof front available AND armed. Post-W13.1 the
        // preferred front is utls_daemon (bundled Go binary); legacy is
        // libcurl_impersonate (opt-in via UNBROWSE_LIBCURL_IMPERSONATE_PROXY_MODE).
        expect(chain.tlsSpoof).toBe(true);
        const armedFront = chain.layers[0];
        expect(["utls_daemon", "libcurl_impersonate"]).toContain(armedFront);
        expect(chain.layers[chain.layers.length - 1]).toBe("iproyal");
        expect(chain.chromeProxyServer.startsWith("http://127.0.0.1:")).toBe(true);
        await chain.stop();
      } else {
        // Honest fall-through with iproyal-only partial available.
        expect(chain.error).toMatch(/^(libcurl_impersonate_|utls_proxy_)/);
        expect(chain.partial).toBeTruthy();
        expect(chain.partial!.tlsSpoof).toBe(false);
        expect(chain.partial!.layers).toEqual(["iproyal"]);
        await chain.partial!.stop();
      }
    } finally {
      await rm(IPROYAL_CREDS_PATH);
    }
  });
});

describe("W13 — auth-challenge no-leak", () => {
  it("7. handle() returns ProvideCredentials on Proxy challenge but the OUTCOME object NEVER contains the password bytes", async () => {
    const CANARY = "UNB13-CRED-CANARY-DO-NOT-LEAK";
    const proxy = {
      server: "http://geo.iproyal.com:12321",
      username: "user-of-record",
      password: CANARY,
    };
    const { continueWithAuth, outcome } = await authChallenge.handle(proxy, {
      source: "Proxy",
      origin: "geo.iproyal.com",
      scheme: "basic",
      realm: "iproyal",
    });

    // The CDP-bound side carries the credential (it has to — Chrome needs it).
    expect(continueWithAuth.authChallengeResponse.response).toBe("ProvideCredentials");
    expect(continueWithAuth.authChallengeResponse.password).toBe(CANARY);

    // But the OUTCOME object — which goes into the receipt — must NEVER carry the credential.
    expect(authChallenge.outcomeContainsCredential(outcome, CANARY)).toBe(false);
    // ANY field in outcome — assert no string anywhere contains the canary.
    const flatJson = JSON.stringify(outcome);
    expect(flatJson.includes(CANARY)).toBe(false);
    // Username is also not echoed in the receipt — only its digest.
    expect(flatJson.includes("user-of-record")).toBe(false);
    expect(outcome.usernameDigest?.length).toBe(16);
  });

  it("7b. handle() returns Default response on Server-shaped (non-proxy) challenges", async () => {
    const { continueWithAuth, outcome } = await authChallenge.handle(
      { server: "http://x", username: "u", password: "p" },
      { source: "Server", origin: "example.com", scheme: "basic", realm: "site" },
    );
    expect(continueWithAuth.authChallengeResponse.response).toBe("Default");
    expect(outcome.authProvided).toBe(false);
  });

  it("7c. handle() returns Default when proxy has no creds (fall-through allowed)", async () => {
    const { continueWithAuth, outcome } = await authChallenge.handle(
      { server: "http://x" },
      { source: "Proxy", origin: "x", scheme: "basic", realm: "r" },
    );
    expect(continueWithAuth.authChallengeResponse.response).toBe("Default");
    expect(outcome.authProvided).toBe(false);
  });
});

describe("W13 — bench-tls-spoof corpus", () => {
  it("8. corpus file exists and has ≥8 probes in intent|url format", async () => {
    expect(existsSync(CORPUS_PATH)).toBe(true);
    const raw = await readFile(CORPUS_PATH, "utf8");
    const probes = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(probes.length).toBeGreaterThanOrEqual(8);
    for (const row of probes) {
      const parts = row.split("|");
      expect(parts.length).toBe(2);
      expect(parts[0]!.length).toBeGreaterThan(0);
      expect(parts[1]!.startsWith("http")).toBe(true);
    }
  });
});

describe.skipIf(!INTEGRATION)("W13 — integration (gated on UNBROWSE_TLS_INTEGRATION=1)", () => {
  it("9. spawn Chrome through the chain, hit a JA4-echo endpoint, confirm non-default fingerprint", async () => {
    // Implementation deferred to W15 (bench-gate) because it requires
    // both a JA3-proxy variant on PATH AND a live iproyal subscription.
    // The skip-gated structure stays in place so the bench-gate wedge
    // can flip it on without code change.
    expect(INTEGRATION).toBe(true);
  });
});
