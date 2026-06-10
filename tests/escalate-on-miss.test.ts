/**
 * Layer-3 witness (the descent / auto-escalate on resolve MISS).
 *
 * Proves the missing orchestration: a non-empty shortlist short-circuits (use the
 * highest layer that works); an EMPTY shortlist descends → captures the real
 * request down to the packet layer → obfuscates it into a privacy-safe route →
 * indexes it back. The DESCENT (browser/packet capture) and the PUBLISH (ledger
 * append) are injected external transports — the same standard the Layer-1 ledger
 * witness uses for the KV transport — so the escalation decision + obfuscate→route
 * wiring under test runs for real.
 */
import { describe, it, expect } from "bun:test";
import { getWalletPubkey } from "../src/values/signer.js";
import { resolveOrEscalate, type DiscoveredRoute } from "../src/capture/escalate-on-miss.js";
import { verifyHoleAttested } from "../src/capture/zk-bound-hole.js";
import type { RawRequest } from "../src/capture/index.js";

function capturedRequest(secret: string): RawRequest {
  return {
    method: "GET",
    url: "https://api.example.com/v1/search?q=x",
    request_headers: { authorization: `Bearer ${secret}` },
    request_body: undefined,
    response_headers: {},
    response_body: undefined,
  } as RawRequest;
}

describe("Layer 3 — auto-descend on resolve MISS", () => {
  it("HIT: a non-empty shortlist short-circuits — no descent, no capture, no publish", async () => {
    let captured = false;
    let published = false;
    const res = await resolveOrEscalate(
      [{ endpoint_id: "ep-existing" }], // server already has a route
      "https://api.example.com/v1/search",
      "search",
      {
        capture: async () => { captured = true; return []; },
        publishRoute: async () => { published = true; },
      },
    );
    expect(res.escalated).toBe(false);
    expect(res.shortlist.length).toBe(1);
    expect(captured).toBe(false); // highest layer worked → never descended
    expect(published).toBe(false);
  });

  it("MISS: an empty shortlist descends → captures → obfuscates → indexes the route back", async () => {
    const secret = "tok-discovered-001";
    let publishedRoute: DiscoveredRoute | null = null;

    const res = await resolveOrEscalate(
      [], // MISS — server has no route for this intent
      "https://api.example.com/v1/search?q=x",
      "search products",
      {
        capture: async (url, intent) => {
          expect(url).toContain("api.example.com");
          expect(intent).toBe("search products");
          return [capturedRequest(secret)]; // the packet-layer descent (injected)
        },
        publishRoute: async (route) => { publishedRoute = route; },
        secrets: [secret],
      },
    );

    expect(res.escalated).toBe(true);
    expect(publishedRoute).not.toBeNull();
    expect(publishedRoute!.domain).toBe("api.example.com");
    expect(publishedRoute!.templates.length).toBe(1);
    // the auth header became a hole, not a literal value
    const authHole = publishedRoute!.templates[0].holes.find((h) => h.name === "authorization");
    expect(authHole).toBeDefined();
  });

  it("PRIVACY: the captured secret is never plaintext in the indexed route", async () => {
    const secret = "tok-must-not-leak-9999";
    let publishedRoute: DiscoveredRoute | null = null;
    await resolveOrEscalate([], "https://api.example.com/v1/me", "whoami", {
      capture: async () => [capturedRequest(secret)],
      publishRoute: async (route) => { publishedRoute = route; },
      secrets: [secret],
    });
    expect(JSON.stringify(publishedRoute)).not.toContain(secret); // no plaintext crosses to the server
  });

  it("WALLET: with a wallet, the discovered route's secret hole carries a real ZK binding (Layer 2 ties in)", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "tok-zk-bound-route";
    let publishedRoute: DiscoveredRoute | null = null;

    await resolveOrEscalate([], "https://api.example.com/v1/me", "whoami", {
      capture: async () => [capturedRequest(secret)],
      publishRoute: async (route) => { publishedRoute = route; },
      walletPubkey: wallet,
      secrets: [secret],
    });

    const authHole = publishedRoute!.templates[0].holes.find((h) => h.name === "authorization")!;
    expect(authHole.bound?.startsWith("zkbind:")).toBe(true);
    expect(verifyHoleAttested(authHole)).toBe(true); // wallet really bound the discovered slot
    expect(JSON.stringify(publishedRoute)).not.toContain(secret);
  });
});
