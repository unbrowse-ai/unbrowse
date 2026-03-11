export type HarnessCase = {
  id: string;
  intent: string;
  url: string;
  auth?: string;
  params?: Record<string, unknown>;
  expected_fields: string[];
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
      ? record.validate as { expected_fields?: unknown; require_auth?: unknown }
      : undefined;
    const nestedExpected = Array.isArray(nestedValidate?.expected_fields)
      ? nestedValidate.expected_fields.filter((field): field is string => typeof field === "string" && field.length > 0)
      : [];

    const auth =
      typeof record.auth === "string" && record.auth.trim()
        ? record.auth.trim()
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

    return [{
      id,
      intent,
      url,
      auth,
      ...(params ? { params } : {}),
      expected_fields: [...new Set([...directExpected, ...nestedExpected])],
    }];
  });
}
