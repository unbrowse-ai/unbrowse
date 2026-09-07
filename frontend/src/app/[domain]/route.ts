import { NextResponse } from "next/server";
import { getConfiguredApiOrigin } from "@/lib/api-base";
import { contractProxy, type LedgerLayer } from "@/lib/contract-proxy";

// unbrowse.ai/<domain> — the website as a THIN PROXY to the on-chain/backend stuff.
//
// This route is a wrapper: it recalls the per-domain skill.md through the LAYERED
// contract backing FIRST (isolate → KV → emergentDB → graph), and fetches the
// on-chain/backend SOURCE (`/v1/skills/by-domain/.../skill.md`) only on a miss —
// "thin frontend + proxies to on-chain with kv/emergentdb/graph on top." Only a
// real 200 is committed to muscle memory (an error response is never memoized —
// no false witness).
//
// Static Next.js segments (e.g. /agents, /blog) win over this dynamic route, so
// /github.com / /api.openai.com / /reddit.com fall here while existing product
// pages are unaffected. Domain-shaped segments only; non-domains 404 cleanly.
//
// Runs on the opennextjs-cloudflare worker runtime (not Next `edge` — that combo
// produced a bare 21-byte 500 in prod, observed 2026-05-27 v7.0.2).

function looksLikeDomain(s: string): boolean {
  return /^[a-z0-9.-]+$/i.test(s) && s.includes(".") && !s.startsWith(".") && !s.endsWith(".");
}

// In-isolate L0 recall tier (the fastest layer of the kv→emergentDB→graph stack).
// A CF worker isolate serves many requests before eviction, so a warm isolate
// recalls a domain's skill.md with NO backend round-trip. Bounded + TTL'd so a
// long-lived isolate cannot grow unbounded. The DURABLE cross-isolate layers
// (KV / emergentDB / graph) prepend ahead of this one at deploy (the thin-proxy seam).
type Entry = { v: unknown; exp: number };
const _isolate = new Map<string, Entry>();
function isolateLayer(ttlMs: number): LedgerLayer {
  return {
    name: "isolate",
    get: async (k) => {
      const e = _isolate.get(k);
      return e && e.exp > Date.now() ? e.v : null;
    },
    put: async (k, v) => {
      if (_isolate.size > 256) _isolate.clear(); // bounded — never leak on a long-lived isolate
      _isolate.set(k, { v, exp: Date.now() + ttlMs });
    },
  };
}

type SkillMd = { md: string; status: number; indexed: string };

export async function GET(_req: Request, ctx: { params: Promise<{ domain: string }> }) {
  try {
    const { domain: raw } = await ctx.params;
    const domain = decodeURIComponent(raw).toLowerCase();
    if (!looksLikeDomain(domain)) {
      return new NextResponse("Not Found", { status: 404 });
    }

    // Resolve at request time (worker-bundling read process.env empty at module eval).
    const backend = getConfiguredApiOrigin();
    const upstream = `${backend}/v1/skills/by-domain/${encodeURIComponent(domain)}/skill.md`;

    let proxied;
    try {
      proxied = await contractProxy<SkillMd>({
        intent: `skill-md:${domain}`,
        layers: [isolateLayer(120_000)], // KV / emergentDB / graph prepend here at deploy
        source: async () => {
          const res = await fetch(upstream, {
            headers: { Accept: "text/markdown" },
            next: { revalidate: 120 }, // upstream KV is already 120s-cached; mirror it
          });
          if (!res.ok && res.status !== 200) {
            return { md: `# ${domain}\n\nUpstream error ${res.status}.\n`, status: res.status, indexed: "0" };
          }
          return { md: await res.text(), status: 200, indexed: res.headers.get("X-Unbrowse-Indexed") ?? "0" };
        },
        cacheable: (v) => v.status === 200, // only memoize a real 200 — never an error
      });
    } catch {
      // fetch / read threw → the on-chain/backend source is unreachable
      return new NextResponse(`# ${domain}\n\nUnbrowse backend is unreachable. Try again in a moment.\n`, {
        status: 502,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    const v = proxied.value;
    return new NextResponse(v.md, {
      status: v.status,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=120, s-maxage=120",
        "X-Unbrowse-Indexed": v.indexed,
        // fallbacks-visible: which contract tier served this (recall vs on-chain source)
        "X-Contract-Recall": proxied.recalled ? "1" : "0",
        "X-Contract-Layer": proxied.layer,
        "X-Robots-Tag": "noindex",
      },
    });
  } catch (err) {
    // Outer guard so the worker never returns the bare CF "Internal Server Error".
    const msg = err instanceof Error ? err.message : String(err);
    return new NextResponse(`# error\n\nHandler crashed: ${msg}\n`, {
      status: 500,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
}
