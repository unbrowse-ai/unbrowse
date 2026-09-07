/*
 * POST /api/hero-chat/exec/report — trust feedback for a CLIENT-SIDE execution.
 *
 * When the browser executes a captured route itself (client-first), it can't
 * hold the agent key, so it posts the outcome here and the worker reports the
 * execution trace to the marketplace trust loop (same as the worker exec path).
 */

import { getConfiguredApiOrigin } from "@/lib/api-base";
import { reportExecution } from "@/lib/hero-exec";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(req: Request): Promise<Response> {
  let body: { skill_id?: string; endpoint_id?: string; ok?: boolean; status?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.skill_id || !body.endpoint_id) return Response.json({ ok: false }, { status: 200 });
  await reportExecution(
    getConfiguredApiOrigin(),
    body.skill_id,
    body.endpoint_id,
    !!body.ok,
    typeof body.status === "number" ? body.status : 0,
    new Date().toISOString(),
  );
  return Response.json({ ok: true });
}
