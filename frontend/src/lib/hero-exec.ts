/*
 * Shared execution + extraction logic for the hero agent.
 *
 * Used by three call sites:
 *   - /api/hero-chat        (server-only full loop: no-JS / SSR / witness fallback)
 *   - /api/hero-chat/exec   (worker fallback proxy: client-first, this is the fallback)
 *   - /api/hero-chat/step    LLM round only (does not execute; see executeFetch here)
 *
 * The product principle (Internal APIs Are All You Need, §3.2 + "credentials
 * never leave your machine"): execution should run on the USER'S OWN CLIENT
 * first — their IP, their cookies — and only fall back to the worker when the
 * browser can't make the call (CORS, mixed-content). The browser does the
 * client-first attempt in hero-chat.tsx; this module is the worker side.
 */

export const FETCH_TIMEOUT_MS = 9000;
export const BODY_CAP = 7000; // chars of tool output fed back to the model

export interface ExecResult {
  output: string;
  label: string;
  ok: boolean;
  status: number;
}

export function truncate(s: string, n = BODY_CAP): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s;
}

/* ---- embedded-SSR extraction: pull structured data out of an HTML page ---- */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function embeddedJsonBlobs(html: string): Json[] {
  const blobs: Json[] = [];
  const scriptRe = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const raw: string[] = [];
  while ((m = scriptRe.exec(html)) !== null) {
    if (m[1] && m[1].length > 2000) raw.push(m[1]);
  }
  const nextData = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (nextData?.[1]) raw.push(nextData[1]);
  raw.sort((a, b) => b.length - a.length);
  for (const r of raw.slice(0, 3)) {
    try {
      blobs.push(JSON.parse(r) as Json);
    } catch {
      /* not valid JSON */
    }
  }
  return blobs;
}

const SIGNAL = /name|title|price|rating|listing|review|url|label/i;

function flattenItem(o: Record<string, Json>, depth = 0): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith("__")) continue;
    if (v === null) continue;
    if (typeof v === "string") {
      if (v.length > 0 && v.length <= 220 && !v.startsWith("data:")) out[k] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (depth < 3 && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(flattenItem(v as Record<string, Json>, depth + 1))) {
        out[`${k}.${k2}`] = v2;
      }
    }
  }
  return out;
}

function collectLists(node: Json, depth = 0, out: { list: Record<string, Json>[]; score: number }[] = []): { list: Record<string, Json>[]; score: number }[] {
  if (depth > 14 || node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    const objs = node.filter((x): x is Record<string, Json> => !!x && typeof x === "object" && !Array.isArray(x));
    if (objs.length >= 3) {
      const flatKeys = Object.keys(flattenItem(objs[0]));
      const signal = new Set(
        flatKeys.filter((k) => SIGNAL.test(k)).map((k) => (k.toLowerCase().match(SIGNAL) as RegExpMatchArray)[0]),
      ).size;
      const keys = new Set<string>();
      for (const o of objs.slice(0, 5)) for (const k of Object.keys(o)) keys.add(k);
      out.push({ list: objs, score: objs.length * keys.size * (1 + 3 * signal) });
    }
    for (const x of node) collectLists(x, depth + 1, out);
  } else {
    for (const v of Object.values(node)) collectLists(v, depth + 1, out);
  }
  return out;
}

export function extractFromHtml(html: string): string | null {
  const blobs = embeddedJsonBlobs(html);
  if (!blobs.length) return null;
  const lists = blobs.flatMap((b) => collectLists(b)).sort((a, b) => b.score - a.score);
  if (!lists.length) return null;
  const picked: Record<string, string | number | boolean>[] = [];
  for (const { list } of lists.slice(0, 2)) {
    for (const item of list.slice(0, 12)) {
      const flat = flattenItem(item);
      if (Object.keys(flat).length >= 2) picked.push(flat);
      if (picked.length >= 16) break;
    }
    if (picked.length >= 8) break;
  }
  if (!picked.length) return null;
  return JSON.stringify({ extracted_from: "embedded SSR state", items: picked });
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** SSRF guard: https only, no localhost/private-looking hosts. ALL methods allowed. */
export function urlAllowed(raw: string): { ok: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "https only" };
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ||
    host.includes("[")
  ) {
    return { ok: false, reason: "host not allowed" };
  }
  return { ok: true };
}

/** Report a real execution outcome to the marketplace trust loop. Best-effort. */
export async function reportExecution(
  apiOrigin: string,
  skillId: string,
  endpointId: string,
  ok: boolean,
  statusCode: number,
  startedAt: string,
): Promise<void> {
  const key = process.env.UNBROWSE_AGENT_KEY;
  if (!key || !skillId || !endpointId) return;
  try {
    await fetch(`${apiOrigin}/v1/stats/execution`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        skill_id: skillId,
        endpoint_id: endpointId,
        trace: {
          trace_id: `hero-${Date.now()}-${endpointId.slice(0, 6)}`,
          skill_id: skillId,
          endpoint_id: endpointId,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          success: ok,
          status_code: statusCode,
          api_call_count: 1,
        },
      }),
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    /* trust feedback is best-effort */
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface ExecuteFetchOpts {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  skill_id?: string;
  endpoint_id?: string;
  apiOrigin: string;
  via?: "worker" | "client-fallback";
}

/** Execute a route from the worker (any method incl. POST), with SSRF guard,
 * SSR extraction, and trust feedback. This is the FALLBACK path; the client
 * tries its own fetch first (hero-chat.tsx). */
export async function executeFetch(opts: ExecuteFetchOpts): Promise<ExecResult> {
  const method = (opts.method ?? "GET").toUpperCase();
  const url = opts.url;
  const gate = urlAllowed(url);
  const viaTag = opts.via === "client-fallback" ? " · via worker (CORS fallback)" : " · via worker";
  if (!gate.ok) return { output: `blocked: ${gate.reason}`, label: `${method} ${url.slice(0, 70)}`, ok: false, status: 0 };

  const hdrs: Record<string, string> = {
    accept: "application/json, text/html;q=0.5",
    "user-agent": BROWSER_UA,
  };
  for (const [k, v] of Object.entries(opts.headers ?? {}).slice(0, 12)) {
    const key = k.toLowerCase();
    // Never forward auth/cookie/host from the model; the worker has no user creds anyway.
    if (key === "cookie" || key === "authorization" || key === "host" || key === "content-length") continue;
    hdrs[k] = String(v).slice(0, 800);
  }
  const host = new URL(url).host;
  const hasBody = method !== "GET" && method !== "HEAD" && opts.body != null;
  if (hasBody && !hdrs["content-type"] && !hdrs["Content-Type"]) hdrs["content-type"] = "application/json";

  const startedAt = new Date().toISOString();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: hdrs,
      body: hasBody ? opts.body : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (e) {
    return { output: `fetch failed: ${e instanceof Error ? e.message : String(e)}`, label: `${method} ${host}${viaTag}`, ok: false, status: 0 };
  }
  const text = await res.text();

  if (opts.skill_id && opts.endpoint_id) {
    await reportExecution(opts.apiOrigin, opts.skill_id, opts.endpoint_id, res.ok, res.status, startedAt);
  }

  const ct = res.headers.get("content-type") ?? "";
  const looksHtml = ct.includes("html") || text.trimStart().startsWith("<");
  if (looksHtml) {
    const extracted = extractFromHtml(text);
    if (extracted) return { output: `HTTP ${res.status}\n${truncate(extracted)}`, label: `${method} ${host} · extracted SSR data${viaTag}`, ok: res.ok, status: res.status };
    return { output: `HTTP ${res.status}\n${truncate(htmlToText(text))}`, label: `${method} ${host} · page text${viaTag}`, ok: res.ok, status: res.status };
  }
  return { output: `HTTP ${res.status}\n${truncate(text)}`, label: `${method} ${host}${viaTag}`, ok: res.ok, status: res.status };
}
