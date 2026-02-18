import { createRequire } from "node:module";

export type StealthProfile = "Chrome" | "Edge" | "Firefox" | "Safari";

type NodeLibcurlJa3Module = {
  Browser?: Record<string, number>;
  impersonate: (profileId: number) => any;
  CurlHttpVersion?: { V1_1?: number };
};

const curlRequire = createRequire(import.meta.url);
let libcurlLoadAttempted = false;
let nodeLibcurlModule: NodeLibcurlJa3Module | null = null;

function getNodeLibcurlModule(): NodeLibcurlJa3Module | null {
  if (libcurlLoadAttempted) return nodeLibcurlModule;
  libcurlLoadAttempted = true;
  try {
    nodeLibcurlModule = curlRequire("node-libcurl-ja3");
    return nodeLibcurlModule;
  } catch {
    return null;
  }
}

const clients = new Map<StealthProfile, any>();

function getClient(profile: StealthProfile): any | null {
  const mod = getNodeLibcurlModule();
  if (!mod?.Browser) return null;
  const profileId = mod.Browser[profile];
  if (!profileId) return null;
  if (!clients.has(profile)) clients.set(profile, mod.impersonate(profileId));
  return clients.get(profile) ?? null;
}

function cleanHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const name = String(k || "").trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (lower.startsWith(":")) continue;
    if (lower === "host" || lower === "connection" || lower === "content-length" || lower === "transfer-encoding") continue;
    out[name] = String(v ?? "");
  }
  return out;
}

export async function fetchViaNodeStealth(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    bodyText?: string;
    timeoutMs?: number;
    profile?: StealthProfile;
  },
): Promise<{
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  usedStealth: boolean;
} | null> {
  const profile = init.profile ?? "Chrome";
  const client = getClient(profile);
  if (!client) return null;

  const method = String(init.method ?? "GET").toUpperCase();
  const headers = cleanHeaders(init.headers);
  const httpHeader = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);

  const options: any = {
    httpHeader,
    followLocation: true,
    maxRedirs: 5,
    timeout: typeof init.timeoutMs === "number" ? init.timeoutMs : 30_000,
    verbose: false,
    curlyResponseBodyParser: false,
  };

  if (init.bodyText && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    options.postFields = init.bodyText;
  }

  const requestFn = (client as any)[method.toLowerCase()] || (client as any).get;
  try {
    const result = await requestFn(url, options);
    const status = Number(result?.statusCode ?? 0);
    const rawHeaders = result?.headers;
    const respHeaders: Record<string, string> = {};
    if (Array.isArray(rawHeaders)) {
      for (const h of rawHeaders) {
        if (!h) continue;
        const key = String((h as any).key ?? "").trim();
        if (!key) continue;
        respHeaders[key] = String((h as any).value ?? "");
      }
    } else if (rawHeaders && typeof rawHeaders === "object") {
      for (const [k, v] of Object.entries(rawHeaders)) respHeaders[String(k)] = String(v ?? "");
    }

    const data = result?.data;
    const bodyText = Buffer.isBuffer(data)
      ? data.toString("utf-8")
      : typeof data === "string"
        ? data
        : (() => { try { return JSON.stringify(data ?? ""); } catch { return String(data ?? ""); } })();

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: respHeaders,
      bodyText,
      usedStealth: true,
    };
  } catch {
    return null;
  }
}

