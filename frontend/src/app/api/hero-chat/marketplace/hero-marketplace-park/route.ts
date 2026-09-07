/*
 * POST /api/hero-chat/marketplace — same-origin proxy for marketplace tools.
 *
 * The client-driven hero loop used to call beta-api.unbrowse.ai directly from
 * the browser. Custom release-attestation headers require a CORS preflight;
 * any allowlist drift (or network blip) surfaces as "search failed: network
 * error" with ok:false. Proxying through this worker:
 *   - avoids CORS entirely (same origin as unbrowse.ai)
 *   - always attaches official unbrowse@latest release attestation
 *   - keeps secrets (agent key) off the client
 */

import { getConfiguredApiOrigin } from "@/lib/api-base";
import { searchRoutes, getRoute } from "@/lib/hero-marketplace";

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
    const r = await searchRoutes(apiOrigin, intent, 14000);
    return Response.json({ output: r.output, ok: r.ok, label: `search · ${intent.slice(0, 60)}` });
  }

  if (body.action === "get") {
    const skillId = String(body.skill_id ?? "").trim();
    if (!skillId) return Response.json({ error: "skill_id required" }, { status: 400 });
    const r = await getRoute(apiOrigin, skillId, 12000);
    return Response.json({
      output: r.output,
      ok: r.ok,
      domain: r.domain,
      label: `manifest · ${r.domain}`,
    });
  }

  return Response.json({ error: "action must be search|get" }, { status: 400 });
}
