/* Marketplace tool helpers shared by the worker loop and the client loop.
 * Browser-safe: pure fetch + format, no env, no node APIs. beta-api is
 * CORS-`*` so the browser can call these directly. */

export interface SearchRow {
  skill_id: string;
  endpoint_id: string;
  domain: string;
  title: string;
  score: number;
}

export async function searchRoutes(apiOrigin: string, intent: string, timeoutMs = 9000): Promise<{ output: string; ok: boolean }> {
  const q = intent.slice(0, 300);
  try {
    const res = await fetch(`${apiOrigin}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: q }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { output: `search failed: HTTP ${res.status}`, ok: false };
    const data = (await res.json()) as { results?: { id?: string; score?: number; metadata?: Record<string, unknown> }[] };
    const rows: SearchRow[] = (data.results ?? []).slice(0, 6).map((r) => {
      const m = r.metadata ?? {};
      let inner: Record<string, unknown> = {};
      try {
        inner = JSON.parse(String(m.content ?? "{}"));
      } catch {
        /* not json */
      }
      return {
        skill_id: String(inner.skill_id ?? (r.id ?? "").split(":")[0] ?? ""),
        endpoint_id: String(inner.endpoint_id ?? (r.id ?? "").split(":")[1] ?? ""),
        domain: String(inner.domain ?? m.source_url ?? ""),
        title: String(m.title ?? inner.name ?? ""),
        score: Number((r.score ?? 0).toFixed(3)),
      };
    });
    return {
      output: JSON.stringify(rows.length ? rows : { results: [], note: "no captured routes matched this intent" }),
      ok: true,
    };
  } catch (e) {
    return { output: `search failed: ${e instanceof Error ? e.message : String(e)}`, ok: false };
  }
}

export async function getRoute(apiOrigin: string, skillId: string, timeoutMs = 9000): Promise<{ output: string; ok: boolean; domain: string }> {
  const id = encodeURIComponent(skillId);
  try {
    const res = await fetch(`${apiOrigin}/v1/skills/${id}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 402) return { output: "this skill is payment-gated for anonymous calls", ok: false, domain: skillId };
    if (!res.ok) return { output: `manifest fetch failed: HTTP ${res.status}`, ok: false, domain: skillId };
    const skill = (await res.json()) as Record<string, unknown>;
    const endpoints = (Array.isArray(skill.endpoints) ? skill.endpoints : []).slice(0, 10).map((e) => {
      const ep = e as Record<string, unknown>;
      return {
        endpoint_id: ep.endpoint_id ?? ep.id,
        method: ep.method,
        url: ep.url ?? ep.url_template ?? ep.path,
        description: ep.description ?? ep.intent ?? "",
        headers: ep.headers ?? ep.headers_template ?? undefined,
        query: ep.query ?? undefined,
        params: ep.params ?? ep.query_params ?? undefined,
      };
    });
    return {
      output: JSON.stringify({ skill_id: skill.skill_id, domain: skill.domain, endpoints }),
      ok: true,
      domain: String(skill.domain ?? skillId),
    };
  } catch (e) {
    return { output: `manifest fetch failed: ${e instanceof Error ? e.message : String(e)}`, ok: false, domain: skillId };
  }
}
