import { NextResponse } from "next/server";
import { getConfiguredApiOrigin } from "@/lib/api-base";

// unbrowse.ai/<domain> — llms.txt-style SKILL.md for any indexed domain.
//
// Static Next.js segments (e.g. /agents, /blog) win over this dynamic route,
// so /github.com / /api.openai.com / /reddit.com fall here while existing
// product pages are unaffected. We only accept domain-shaped segments
// (must contain a dot, ASCII letters/digits/dot/hyphen only) so any non-domain
// 404 cleanly via NextResponse.next() falling through to default 404.

export const runtime = "edge";

const BACKEND = getConfiguredApiOrigin();

function looksLikeDomain(s: string): boolean {
  return /^[a-z0-9.-]+$/i.test(s) && s.includes(".") && !s.startsWith(".") && !s.endsWith(".");
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ domain: string }> },
) {
  const { domain: raw } = await ctx.params;
  const domain = decodeURIComponent(raw).toLowerCase();
  if (!looksLikeDomain(domain)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const upstream = `${BACKEND}/v1/skills/by-domain/${encodeURIComponent(domain)}/skill.md`;
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

  const md = await res.text();
  return new NextResponse(md, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=120, s-maxage=120",
      "X-Unbrowse-Indexed": res.headers.get("X-Unbrowse-Indexed") ?? "0",
      "X-Robots-Tag": "noindex",
    },
  });
}
