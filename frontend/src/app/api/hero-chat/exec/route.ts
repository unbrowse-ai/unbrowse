/*
 * POST /api/hero-chat/exec — the worker FALLBACK execution proxy.
 *
 * The browser tries to execute a route itself first (client-first: the user's
 * own IP + cookies). When the browser can't — CORS, mixed content — it posts
 * the route here and the worker makes the call server-side. Any method,
 * including POST. SSRF-guarded; SSR-extracted; trust-reported.
 */

import { getConfiguredApiOrigin } from "@/lib/api-base";
import { executeFetch } from "@/lib/hero-exec";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: Request): Promise<Response> {
  let body: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    skill_id?: string;
    endpoint_id?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.url || typeof body.url !== "string") {
    return Response.json({ error: "url required" }, { status: 400 });
  }
  const result = await executeFetch({
    url: body.url,
    method: body.method,
    headers: body.headers,
    body: body.body,
    skill_id: body.skill_id,
    endpoint_id: body.endpoint_id,
    apiOrigin: getConfiguredApiOrigin(),
    via: "client-fallback",
  });
  return Response.json(result);
}
