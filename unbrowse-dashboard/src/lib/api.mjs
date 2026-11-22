// The Worker's HTTP doors besides the page: CI posts a run (signed), anyone reads the runs.
import { listRuns, listSites, saveRun } from "./db.mjs";
import { checkRecord } from "./record.mjs";
import { verify } from "./sign.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const isBranch = (b) => typeof b === "string" && /^[\w./-]{1,100}$/.test(b);

export async function handleApi(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(received_at) AS last FROM runs").first();
    return json({ ok: true, runs: row?.n ?? 0, last_received: row?.last ?? null });
  }
  if (url.pathname === "/api/ingest") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const body = await request.text();
    if (body.length > 1_000_000) return json({ error: "too large" }, 413);
    const refused = await verify(env.INGEST_KEY, body, request.headers.get("x-dashboard-time"), request.headers.get("x-dashboard-signature"));
    if (refused) return json({ error: refused }, 401);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json({ error: "not JSON" }, 400);
    }
    const { record, error } = checkRecord(parsed);
    if (error) return json({ error }, 400);
    await saveRun(env.DB, record);
    return json({ ok: true, run_id: record.run_id });
  }
  if (url.pathname === "/api/runs" && request.method === "GET") {
    const branch = isBranch(url.searchParams.get("branch")) ? url.searchParams.get("branch") : "staging";
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 60, 1), 365);
    return json({ runs: await listRuns(env.DB, { branch, days }) });
  }
  if (url.pathname === "/api/sites" && request.method === "GET") {
    const run = Number(url.searchParams.get("run"));
    if (!Number.isSafeInteger(run)) return json({ error: "run" }, 400);
    return json({ sites: await listSites(env.DB, run) });
  }
  return null;
}
