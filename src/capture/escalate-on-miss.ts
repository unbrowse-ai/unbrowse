/**
 * escalate-on-miss — Layer 3 (the descent): when a route resolve returns an
 * EMPTY shortlist (the server has no endpoint for this intent), escalate down the
 * stack — open the browser, drive to the layer that works, capture the real
 * request down to the network packet — then obfuscate the capture into a
 * privacy-safe hole-template route and index it back to the server so the next
 * agent reuses it instead of re-deriving it.
 *
 * This is the orchestration that was missing: `resolve` previously returned the
 * empty shortlist to the agent and stopped. Here a MISS instead triggers
 * capture → obfuscate (secrets become wallet-bound holes, never plaintext) →
 * publish (the route lands in the signed route ledger, Layer 1).
 *
 * The DESCENT itself (browser → curl-impersonate / JA3-JA4 packet layer) and the
 * PUBLISH (the HTTP POST to /v1/skills that appends the ledger leaf) are EXTERNAL
 * transports, injected as `deps` — exactly as the Layer-1 ledger witness injects
 * the KV HTTP transport. The escalation DECISION and the obfuscate→route wiring
 * under test run for real.
 */
import type { RawRequest } from "./index.js";
import { obfuscateRequestForReveng } from "./obfuscate.js";
import { extractHoles, type HoleTemplate } from "./hole-template.js";
import { zkBindKnownSecrets } from "./zk-bound-hole.js";

/** A route discovered by descending on a resolve miss: the domain plus the
 *  privacy-safe hole-templates (structure + holes, every secret a wallet-bound
 *  placeholder — no plaintext). This is what gets indexed back to the server. */
export interface DiscoveredRoute {
  domain: string;
  templates: HoleTemplate[];
}

export interface EscalationDeps {
  /** The descent: open a browser, drive to the right layer, and capture the real
   *  request(s) down to the network packet (curl-impersonate / JA3-JA4). The live
   *  capture pipeline; injected so the escalation logic is witnessable without a
   *  real browser, the same way the L1 witness injects the KV transport. */
  capture: (url: string, intent: string) => Promise<RawRequest[]>;
  /** Index the discovered route back to the server (POST /v1/skills → the signed
   *  route ledger, Layer 1). Injected external transport. */
  publishRoute: (route: DiscoveredRoute) => Promise<void>;
  /** Wallet pubkey for binding captured secrets to holes (Layer 2). When set, the
   *  obfuscation emits wallet-bound `[bound:<sha16>]` placeholders and the real ZK
   *  bindings are minted over the exact bound values. */
  walletPubkey?: string;
  /** Known vault secrets to guarantee-strip from the captured request. */
  secrets?: string[];
}

export interface EscalationResult {
  /** true iff a MISS triggered the descent + capture + publish. */
  escalated: boolean;
  /** the discovered route, present iff escalated. */
  route?: DiscoveredRoute;
  /** the resolve shortlist (unchanged when not a miss). */
  shortlist: unknown[];
}

/**
 * If `shortlist` is non-empty the highest layer already worked — return it
 * unchanged (the end-to-end-argument rule: use the highest layer that can do the
 * job; descend only on a real miss). On an EMPTY shortlist, descend: capture the
 * request down to the packet layer, obfuscate it into a privacy-safe route
 * (secrets → wallet-bound holes, optionally ZK-bound), and index it back.
 */
export async function resolveOrEscalate(
  shortlist: unknown[],
  url: string,
  intent: string,
  deps: EscalationDeps,
): Promise<EscalationResult> {
  if (Array.isArray(shortlist) && shortlist.length > 0) {
    return { escalated: false, shortlist };
  }

  // MISS — descend to the packet layer and capture the real request(s).
  const raw = await deps.capture(url, intent);

  // Obfuscate each captured request into a hole-template route. Every secret
  // becomes a wallet-bound placeholder; no plaintext crosses to the server.
  const boundSink = new Set<string>();
  const templates: HoleTemplate[] = raw.map((r) => {
    const skeleton = obfuscateRequestForReveng(r, {
      walletPubkey: deps.walletPubkey,
      secrets: deps.secrets,
      boundSink: deps.walletPubkey ? boundSink : undefined,
    });
    return extractHoles(skeleton);
  });

  // When a wallet is present, mint the real ZK bindings over the exact bound
  // values and upgrade each template's holes (Layer 2). Re-extract with bindings
  // so Hole.bound carries the real `zkbind:` tag, reviving backend attestation.
  let finalTemplates = templates;
  if (deps.walletPubkey && boundSink.size > 0) {
    const bindings = await zkBindKnownSecrets([...boundSink], deps.walletPubkey);
    finalTemplates = raw.map((r) => {
      const skeleton = obfuscateRequestForReveng(r, {
        walletPubkey: deps.walletPubkey,
        secrets: deps.secrets,
        boundSink: new Set<string>(),
      });
      return extractHoles(skeleton, bindings);
    });
  }

  let domain: string;
  try {
    domain = new URL(url).hostname;
  } catch {
    domain = url;
  }
  const route: DiscoveredRoute = { domain, templates: finalTemplates };

  await deps.publishRoute(route);
  return { escalated: true, route, shortlist: [] };
}
