/*
 * POST /api/hero-chat/marketplace — same-origin proxy for marketplace tools.
 * Avoids browser CORS preflight failures that surface as "search failed: network error".
 */

import { getConfiguredApiOrigin } from "@/lib/api-base";
import { searchRoutesDirect, getRouteDirect } from "@/lib/hero-marketplace";

export const runtime = "nodejs";
export const maxDuration = 30;

type Body =
  | { action: "search"; intent?: string }
  | { action: "get"; skill_id?: string };

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const apiOrigin = getConfiguredApiOrigin();

  if (body.action === "search") {
    const intent = String(body.intent ?? "").trim();
    if (!intent) return Response.json({ error: "intent required" }, { status: 400 });
    const r = await searchRoutesDirect(apiOrigin, intent, 14000);
    return Response.json({ output: r.output, ok: r.ok, label: `search · ${intent.slice(0, 60)}` });
  }

  if (body.action === "get") {
    const skillId = String(body.skill_id ?? "").trim();
    if (!skillId) return Response.json({ error: "skill_id required" }, { status: 400 });
    const r = await getRouteDirect(apiOrigin, skillId, 12000);
    return Response.json({
      output: r.output,
      ok: r.ok,
      domain: r.domain,
      label: `manifest · ${r.domain}`,
    });
  }

  return Response.json({ error: "action must be search|get" }, { status: 400 });
}
