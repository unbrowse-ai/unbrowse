export type HarnessTerminalState = "pass" | "fail" | "skip" | "blocked";

export type HarnessAuthContext = {
  domain: string;
  persona?: string;
  role?: string;
  session?: string;
};

export type HarnessCaseValidation = {
  entity_type?: string;
  min_rows?: number;
  side_effect?: string;
  echo_params?: string[];
  terminal_ok?: HarnessTerminalState[];
};

export type HarnessCase = {
  id: string;
  intent: string;
  url: string;
  auth?: string;
  auth_context?: HarnessAuthContext;
  params?: Record<string, unknown>;
  expected_fields: string[];
  validate?: HarnessCaseValidation;
};

export type DeferredEndpoint = {
  endpoint_id?: string;
  score?: number;
  schema_summary?: unknown;
  trigger_url?: string | null;
  url?: string;
};

export type ReviewQueueCandidate = {
  rank: number;
  endpoint_id: string;
  score?: number;
  description?: string;
  url?: string;
  trigger_url?: string | null;
  signals: string[];
  cli?: string[];
};

const TRACKING_OR_ADTECH = /\b(doubleverify|optable|liadm|privacymanager|crwdcntrl|demdex|teads|rubicon|pubmatic|adnxs|taboola|outbrain|adsystem|adserver|adtech|tracking|telemetry|analytics|beacon|pixel|impression|click[-_]?tracking|consent|witness|targeting|identify)\b/i;

function endpointDescription(endpoint: DeferredEndpoint): string {
  const description = (endpoint as DeferredEndpoint & { description?: unknown }).description;
  return typeof description === "string" ? description : "";
}

function isApiLikeUrl(url?: string): boolean {
  if (!url) return false;
  return /\/api\/|graphql|\.json(?:$|\?)|\/v\d+\//i.test(url);
}

function isPageArtifact(endpoint: DeferredEndpoint): boolean {
  const description = endpointDescription(endpoint);
  if (description.startsWith("Captured page artifact")) return true;
  if (!endpoint.url) return false;
  const apiLike = isApiLikeUrl(endpoint.url);
  if (apiLike) return false;
  try {
    const parsed = new URL(endpoint.url);
    return parsed.pathname === "/" || parsed.pathname === "" || parsed.pathname === new URL(endpoint.trigger_url ?? endpoint.url).pathname;
  } catch {
    return false;
  }
}

function registrableHost(url?: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 2) return host;
    const tail = parts.slice(-2).join(".");
    const cctldTail = parts.slice(-3).join(".");
    if (/^[a-z]{2}$/.test(parts[parts.length - 1] ?? "") && (parts[parts.length - 2]?.length ?? 0) <= 3) {
      return cctldTail;
    }
    return tail;
  } catch {
    return null;
  }
}

function isThirdPartyRelativeToTrigger(endpoint: DeferredEndpoint): boolean {
  const endpointHost = registrableHost(endpoint.url);
  const triggerHost = registrableHost(endpoint.trigger_url ?? undefined);
  return !!endpointHost && !!triggerHost && endpointHost !== triggerHost;
}

function looksLikeTrackingOrAdtech(endpoint: DeferredEndpoint): boolean {
  return TRACKING_OR_ADTECH.test(`${endpoint.url ?? ""} ${endpointDescription(endpoint)}`);
}

function endpointOrderingWeight(endpoint: DeferredEndpoint): number {
  const description = endpointDescription(endpoint);
  let weight = 0;
  if (description.startsWith("Structured replay")) weight += 90;
  if (description.startsWith("Canonical document replay")) weight += 80;
  if (isApiLikeUrl(endpoint.url)) weight += 60;
  if (endpoint.url?.includes("{")) weight += 20;
  if (endpoint.schema_summary) weight += 15;
  if (endpoint.trigger_url) weight += 5;
  if (isPageArtifact(endpoint)) weight -= 120;
  if (isThirdPartyRelativeToTrigger(endpoint)) weight -= 45;
  if ((endpoint.score ?? 0) < 0) weight -= 80;
  if (looksLikeTrackingOrAdtech(endpoint)) weight -= 180;
  return weight;
}

export function compactForArtifact(value: unknown, depth = 0): unknown {
  if (depth > 3 || value == null) return value;
  if (typeof value === "string") return value.length > 280 ? `${value.slice(0, 280)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 4).map((item) => compactForArtifact(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 12)
        .map(([key, next]) => [key, compactForArtifact(next, depth + 1)]),
    );
  }
  return String(value);
}

export function fallbackEndpointOrder(endpoints: DeferredEndpoint[]): string[] {
  return [...endpoints]
    .filter((endpoint): endpoint is DeferredEndpoint & { endpoint_id: string } => typeof endpoint.endpoint_id === "string" && endpoint.endpoint_id.length > 0)
    .sort((lhs, rhs) => {
      const weightDelta = endpointOrderingWeight(rhs) - endpointOrderingWeight(lhs);
      if (weightDelta !== 0) return weightDelta;
      return (rhs.score ?? 0) - (lhs.score ?? 0);
    })
    .map((endpoint) => endpoint.endpoint_id);
}

export function buildAgentExecuteCliArgs(
  skillId: string,
  endpointId: string,
  testCase: Pick<HarnessCase, "intent" | "url" | "params">,
): string[] {
  return [
    "bun",
    "src/cli.ts",
    "execute",
    "--skill",
    skillId,
    "--endpoint",
    endpointId,
    "--intent",
    testCase.intent,
    "--url",
    testCase.url,
    ...(testCase.params ? ["--params", JSON.stringify(testCase.params)] : []),
    "--raw",
  ];
}

export function deriveEndpointSignals(endpoint: DeferredEndpoint): string[] {
  const signals: string[] = [];
  const description = endpointDescription(endpoint);
  if (endpoint.schema_summary) signals.push("schema");
  if (endpoint.url?.includes("{")) signals.push("templated_url");
  if (endpoint.url && !endpoint.url.includes("{")) signals.push("concrete_url");
  if (endpoint.trigger_url) signals.push("trigger_url");
  if (description.startsWith("Structured replay")) signals.push("structured_replay");
  if (description.startsWith("Canonical document replay")) signals.push("document_replay");
  if (isApiLikeUrl(endpoint.url)) signals.push("api_like");
  if (isThirdPartyRelativeToTrigger(endpoint)) signals.push("third_party");
  if (looksLikeTrackingOrAdtech(endpoint)) signals.push("tracking_or_adtech");
  if (isPageArtifact(endpoint)) {
    signals.push("page_artifact_risk");
  }
  return signals;
}

export function normalizeHarnessCases(raw: unknown): HarnessCase[] {
  const entries = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { cases?: unknown[] }).cases)
      ? (raw as { cases: unknown[] }).cases
      : [];

  return entries.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const intent = typeof record.intent === "string" ? record.intent.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!intent || !url) return [];

    const id =
      (typeof record.id === "string" && record.id.trim()) ||
      (typeof record.name === "string" && record.name.trim()) ||
      `case-${index + 1}`;

    const directExpected = Array.isArray(record.expected_fields)
      ? record.expected_fields.filter((field): field is string => typeof field === "string" && field.length > 0)
      : [];
    const nestedValidate = record.validate && typeof record.validate === "object"
      ? record.validate as {
          expected_fields?: unknown;
          require_auth?: unknown;
          entity_type?: unknown;
          min_rows?: unknown;
          side_effect?: unknown;
          echo_params?: unknown;
          terminal_ok?: unknown;
        }
      : undefined;
    const nestedExpected = Array.isArray(nestedValidate?.expected_fields)
      ? nestedValidate.expected_fields.filter((field): field is string => typeof field === "string" && field.length > 0)
      : [];

    const authObject = record.auth && typeof record.auth === "object" && !Array.isArray(record.auth)
      ? record.auth as Record<string, unknown>
      : null;
    const authContext = authObject
      ? {
          domain: typeof authObject.domain === "string" && authObject.domain.trim()
            ? authObject.domain.trim()
            : (() => {
                try {
                  return new URL(url).hostname.replace(/^www\./, "");
                } catch {
                  return "";
                }
              })(),
          ...(typeof authObject.persona === "string" && authObject.persona.trim() ? { persona: authObject.persona.trim() } : {}),
          ...(typeof authObject.role === "string" && authObject.role.trim() ? { role: authObject.role.trim() } : {}),
          ...(typeof authObject.session === "string" && authObject.session.trim() ? { session: authObject.session.trim() } : {}),
        }
      : undefined;

    const auth =
      typeof record.auth === "string" && record.auth.trim()
        ? record.auth.trim()
        : authContext?.domain
          ? authContext.domain
          : nestedValidate?.require_auth
            ? (() => {
                try {
                  return new URL(url).hostname.replace(/^www\./, "");
                } catch {
                  return undefined;
                }
              })()
            : undefined;

    const params =
      record.params && typeof record.params === "object" && !Array.isArray(record.params)
        ? { ...(record.params as Record<string, unknown>) }
        : undefined;

    const entityType = typeof nestedValidate?.entity_type === "string" && nestedValidate.entity_type.trim()
      ? nestedValidate.entity_type.trim()
      : undefined;
    const minRows = typeof nestedValidate?.min_rows === "number" && Number.isFinite(nestedValidate.min_rows)
      ? Math.max(0, Math.trunc(nestedValidate.min_rows))
      : undefined;
    const sideEffect = typeof nestedValidate?.side_effect === "string" && nestedValidate.side_effect.trim()
      ? nestedValidate.side_effect.trim()
      : undefined;
    const echoParams = Array.isArray(nestedValidate?.echo_params)
      ? nestedValidate.echo_params.filter((field): field is string => typeof field === "string" && field.trim().length > 0)
      : [];
    const terminalOk = Array.isArray(nestedValidate?.terminal_ok)
      ? nestedValidate.terminal_ok.filter((state): state is HarnessTerminalState =>
          typeof state === "string" && ["pass", "fail", "skip", "blocked"].includes(state),
        )
      : [];
    const validate =
      entityType || minRows != null || sideEffect || echoParams.length > 0 || terminalOk.length > 0
        ? {
            ...(entityType ? { entity_type: entityType } : {}),
            ...(minRows != null ? { min_rows: minRows } : {}),
            ...(sideEffect ? { side_effect: sideEffect } : {}),
            ...(echoParams.length > 0 ? { echo_params: echoParams } : {}),
            ...(terminalOk.length > 0 ? { terminal_ok: [...new Set(terminalOk)] } : {}),
          }
        : undefined;

    return [{
      id,
      intent,
      url,
      auth,
      ...(authContext?.domain ? { auth_context: authContext } : {}),
      ...(params ? { params } : {}),
      expected_fields: [...new Set([...directExpected, ...nestedExpected])],
      ...(validate ? { validate } : {}),
    }];
  });
}

function looksJunkFollowUrl(url: string): boolean {
  return /#google_vignette\b|about:blank|chrome-error:|^javascript:/i.test(url);
}

function safePathDepth(url: string): number {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function pickFreeformFollowUpUrl(
  currentUrl: string,
  endpoints: DeferredEndpoint[],
  visitedUrls: Iterable<string>,
): string | null {
  const visited = new Set([...visitedUrls]);
  const currentHost = registrableHost(currentUrl);

  const ranked = [...endpoints]
    .filter((endpoint): endpoint is DeferredEndpoint & { trigger_url: string } =>
      typeof endpoint.trigger_url === "string" &&
      endpoint.trigger_url.length > 0 &&
      !looksJunkFollowUrl(endpoint.trigger_url) &&
      !visited.has(endpoint.trigger_url) &&
      endpoint.trigger_url !== currentUrl,
    )
    .sort((lhs, rhs) => {
      const hostBonus = Number(registrableHost(rhs.trigger_url) === currentHost) - Number(registrableHost(lhs.trigger_url) === currentHost);
      if (hostBonus !== 0) return hostBonus;
      const templatedBonus = Number((rhs.url ?? "").includes("{")) - Number((lhs.url ?? "").includes("{"));
      if (templatedBonus !== 0) return templatedBonus;
      const depthBonus = safePathDepth(rhs.trigger_url) - safePathDepth(lhs.trigger_url);
      if (depthBonus !== 0) return depthBonus;
      const weightBonus = endpointOrderingWeight(rhs) - endpointOrderingWeight(lhs);
      if (weightBonus !== 0) return weightBonus;
      return (rhs.score ?? 0) - (lhs.score ?? 0);
    });

  return ranked[0]?.trigger_url ?? null;
}

// --- Eval repeatability (#93) ---

export interface EvalCase {
  id: string;
  intent: string;
  url: string;
  expected_outcome: "resolve" | "capture" | "fail";
  auth_required: boolean;
  tags: string[];
}

export interface EvalResult {
  case_id: string;
  status: "pass" | "fail" | "skip";
  duration_ms: number;
  error?: string;
}

/**
 * Returns true if all results for the same case produced a consistent status
 * across two or more runs — used to gate flaky eval cases from the CI suite.
 */
export function isRepeatableEval(results: EvalResult[]): boolean {
  if (results.length < 2) return false;
  const statuses = results.map((r) => r.status);
  return statuses.every((s) => s === statuses[0]);
}
