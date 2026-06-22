/* POST /api/aiko-waitlist — capture an Aiko early-bird waitlist email.
 *
 * Mirrors the route shape used across the app (see api/aiko-chat/route.ts):
 * runtime=nodejs, parse JSON, validate, Response.json. Persists to the
 * AIKO_WAITLIST KV namespace when bound (added to wrangler*.jsonc); falls back
 * to a log line so the form is testable before the binding is provisioned. */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { contractVerdictFromEnvelope } from "@/lib/contract-shape";

export const runtime = "nodejs";
export const maxDuration = 15;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface WaitlistBody {
  email?: string;
}

// Minimal structural shape of a KV namespace (avoids a hard dep on
// @cloudflare/workers-types just for one put()).
interface KVPut {
  put(key: string, value: string): Promise<void>;
}

export async function POST(req: Request): Promise<Response> {
  let body: WaitlistBody;
  try {
    body = (await req.json()) as WaitlistBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const raw = body.email;
  const email = (typeof raw === "string" ? raw : "").trim().toLowerCase();
  // RFC 5321 caps an address at 254 chars; reject longer BEFORE the regex so a
  // giant local-part can never produce an oversized KV key (>512B) or value.
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return Response.json({ error: "a valid email is required" }, { status: 400 });
  }

  const record = JSON.stringify({ email, ts: new Date().toISOString(), source: "aiko-landing" });

  // Acquire the KV binding. getCloudflareContext() throws outside the Worker
  // (e.g. plain `next dev`) — that fallback is fine. But a real kv.put() failure
  // must NOT masquerade as success, or leads vanish behind a green checkmark.
  let kv: KVPut | undefined;
  try {
    kv = (getCloudflareContext().env as Record<string, unknown>).AIKO_WAITLIST as KVPut | undefined;
  } catch {
    kv = undefined; // not on the Worker — accept + log below
  }

  if (kv) {
    try {
      await kv.put(`waitlist:${email}`, record);
    } catch (err) {
      console.error(`[aiko-waitlist] KV put failed: ${(err as Error).message}`);
      return Response.json({ error: "could not save that right now, please retry" }, { status: 503 });
    }
  } else {
    console.log(`[aiko-waitlist] (no KV bound) ${record}`);
  }

  // /contract: the frontend's API op settles as the same three-shape verdict — the frontend layer
  // is /contract-shaped natively, identical verdict shape to the CLI + backend.
  const _envelope = { ok: true, route: "aiko-waitlist" };
  return Response.json({ ..._envelope, _contract: contractVerdictFromEnvelope(_envelope) });
}
