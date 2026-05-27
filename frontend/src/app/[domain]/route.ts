import { NextResponse } from "next/server";
import { getConfiguredApiOrigin } from "@/lib/api-base";

// unbrowse.ai/<domain> — llms.txt-style SKILL.md for any indexed domain.
//
// Static Next.js segments (e.g. /agents, /blog) win over this dynamic route,
// so /github.com / /api.openai.com / /reddit.com fall here while existing
// product pages are unaffected. We only accept domain-shaped segments
// (must contain a dot, ASCII letters/digits/dot/hyphen only) so any non-domain
// 404 cleanly via NextResponse.next() falling through to default 404.

// Run on the opennextjs-cloudflare worker runtime (default), not the Next.js
// `edge` runtime. Combining `runtime = "edge"` with `output: "standalone"`
// produced a bare 21-byte "Internal Server Error" in prod (observed
// 2026-05-27, v7.0.2) — likely an opennextjs adapter mismatch. The worker
// runtime supports the same fetch API and Web standards we need here.

function looksLikeDomain(s: string): boolean {
  return /^[a-z0-9.-]+$/i.test(s) && s.includes(".") && !s.startsWith(".") && !s.endsWith(".");
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ domain: string }> },
) {
  try {
    const { domain: raw } = await ctx.params;
    const domain = decodeURIComponent(raw).toLowerCase();
    if (!looksLikeDomain(domain)) {
      return new NextResponse("Not Found", { status: 404 });
    }

    // Resolve at request time, not at module load. Module-scope resolution
    // ran into worker-bundling edge cases where process.env was empty during
    // the initial worker eval; resolving per-request always reads through
    // the bound env binding.
    const backend = getConfiguredApiOrigin();
    const upstream = `${backend}/v1/skills/by-domain/${encodeURIComponent(domain)}/skill.md`;

    let res: Response;
    try {
      res = await fetch(upstream, {
        headers: { Accept: "text/markdown" },
        // Workers KV-backed responses are already cached upstream (120s TTL);
        // mirror that here.
        next: { revalidate: 120 },
      });
    } catch {
      return new NextResponse(`# ${domain}\n\nUnbrowse backend is unreachable. Try again in a moment.\n`, {
        status: 502,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    if (!res.ok && res.status !== 200) {
      return new NextResponse(`# ${domain}\n\nUpstream error ${res.status}.\n`, {
        status: res.status,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    let md: string;
    try {
      md = await res.text();
    } catch {
      return new NextResponse(`# ${domain}\n\nUnable to read upstream response. Try again in a moment.\n`, {
        status: 502,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    return new NextResponse(md, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=120, s-maxage=120",
        "X-Unbrowse-Indexed": res.headers.get("X-Unbrowse-Indexed") ?? "0",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch (err) {
    // Outer guard so the worker never returns the bare CF "Internal Server
    // Error" page. Return a markdown 500 the agent can read.
    const msg = err instanceof Error ? err.message : String(err);
    return new NextResponse(`# error\n\nHandler crashed: ${msg}\n`, {
      status: 500,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
}
