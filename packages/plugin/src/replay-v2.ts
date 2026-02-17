import type { CapturedExchange } from "./types.js";
import type { CorrelationGraphV1 } from "./correlation-engine.js";
import { planChainForTarget } from "./correlation-engine.js";
import { prepareRequestForStep, type StepResponseRuntime } from "./sequence-executor.js";
import { safeParseJson } from "./schema-inferrer.js";

export type PreparedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyText?: string;
};

export type TransportResult = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  contentType?: string;
};

export type TransportFn = (req: PreparedRequest) => Promise<TransportResult>;

export const DEFAULT_SESSION_HEADER_NAMES = new Set([
  "x-csrf-token", "x-xsrf-token", "csrf-token",
  "x-auth-token", "x-access-token", "authorization",
  "x-request-id", "x-session-id", "x-transaction-id",
]);

export function findBestCapturedTargetIndex(
  exchanges: CapturedExchange[],
  ep: { method: string; pathOrUrl: string },
): number | null {
  const wantMethod = ep.method.toUpperCase();
  const wantPath = normalizePathForKey(ep.pathOrUrl);
  const re = wantPath.includes("{") ? toTemplateRegex(wantPath) : null;

  let best: { idx: number; score: number; ts: number } | null = null;
  for (const ex of exchanges ?? []) {
    if (String(ex.request.method).toUpperCase() !== wantMethod) continue;
    const gotPath = capturedPathname(ex.request.url);
    let score = 0;
    if (gotPath === wantPath) score = 3;
    else if (re && re.test(gotPath)) score = 2;
    else continue;

    const ts = typeof ex.timestamp === "number" ? ex.timestamp : 0;
    if (!best || score > best.score || (score === best.score && ts > best.ts)) {
      best = { idx: ex.index, score, ts };
    }
  }

  return best?.idx ?? null;
}

function normalizePathForKey(input: string): string {
  const raw = String(input || "/").trim();
  if (!raw) return "/";
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return new URL(raw).pathname || "/";
    }
  } catch { /* ignore */ }
  const noQuery = raw.split("?")[0]?.split("#")[0] ?? raw;
  return noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
}

function toTemplateRegex(pathTemplate: string): RegExp | null {
  const pth = normalizePathForKey(pathTemplate);
  const escaped = pth.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\\\{[^}]+\\\}/g, "[^/]+");
  try {
    return new RegExp(`^${pattern}$`);
  } catch {
    return null;
  }
}

function capturedPathname(urlStr: string): string {
  try { return new URL(urlStr).pathname || "/"; } catch { return normalizePathForKey(urlStr); }
}

export async function executeCaptureChainForTarget(
  exchanges: CapturedExchange[],
  graph: CorrelationGraphV1,
  targetIndex: number,
  transport: TransportFn,
  opts?: {
    sessionHeaders?: Record<string, string>;
    bodyOverrideText?: string;
    promoteHeaderNames?: Set<string>;
  },
): Promise<{
  chain: number[];
  final: StepResponseRuntime | null;
  perStep: Array<{ index: number; ok: boolean; status: number }>;
  sessionHeaders: Record<string, string>;
}> {
  const chain = planChainForTarget(graph, targetIndex);
  const runtimeByIndex = new Map<number, StepResponseRuntime>();
  const perStep: Array<{ index: number; ok: boolean; status: number }> = [];

  const promote = opts?.promoteHeaderNames ?? DEFAULT_SESSION_HEADER_NAMES;
  const sessionHeaders: Record<string, string> = { ...(opts?.sessionHeaders ?? {}) };

  let final: StepResponseRuntime | null = null;

  for (const stepIdx of chain) {
    const prepared = prepareRequestForStep(exchanges, graph, stepIdx, runtimeByIndex, {
      sessionHeaders,
      bodyOverrideText: (stepIdx === targetIndex) ? opts?.bodyOverrideText : undefined,
    });
    if (!prepared) continue;
    if (!prepared.bodyText && ["POST", "PUT", "PATCH"].includes(prepared.method)) {
      prepared.bodyText = "{}";
    }

    const resp = await transport(prepared);
    const ct = resp.contentType ?? (resp.headers["content-type"] ?? resp.headers["Content-Type"] ?? "");
    const bodyJson = (() => {
      const text = resp.bodyText ?? "";
      const trimmed = text.trim();
      if (String(ct).toLowerCase().includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
        const parsed = safeParseJson(trimmed);
        return parsed !== null ? parsed : undefined;
      }
      return undefined;
    })();

    // Promote session headers (csrf/auth refresh) for subsequent requests.
    for (const [k, v] of Object.entries(resp.headers ?? {})) {
      if (promote.has(k.toLowerCase())) {
        sessionHeaders[k.toLowerCase()] = String(v);
      }
    }

    const runtime: StepResponseRuntime = {
      status: resp.status,
      headers: resp.headers ?? {},
      bodyText: resp.bodyText ?? "",
      contentType: ct,
      bodyJson,
    };
    runtimeByIndex.set(stepIdx, runtime);
    perStep.push({ index: stepIdx, ok: resp.status >= 200 && resp.status < 300, status: resp.status });

    if (stepIdx === targetIndex) final = runtime;
  }

  return { chain, final, perStep, sessionHeaders };
}

