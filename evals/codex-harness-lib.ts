export type HarnessTerminalState = "pass" | "fail" | "skip" | "blocked";

export type HarnessAuthContext = {
  domain: string;
  persona?: string;
  role?: string;
  session?: string;
};

export type EndpointExpectation = {
  endpoint_id?: string;
  url_includes?: string[];
  trigger_url_includes?: string[];
  description_includes?: string[];
  required_signals?: string[];
  forbidden_signals?: string[];
};

export type RetrievalExpectation = {
  max_rank?: number;
  any_of: EndpointExpectation[];
};

export type SelectionExpectation = {
  any_of: EndpointExpectation[];
};

export type HarnessCaseValidation = {
  entity_type?: string;
  min_rows?: number;
  side_effect?: string;
  echo_params?: string[];
  terminal_ok?: HarnessTerminalState[];
  retrieval?: RetrievalExpectation;
  selection?: SelectionExpectation;
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
  description?: string;
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

export type RetrievalExpectationResult = {
  ok: boolean;
  reason: string;
  matched_rank?: number;
  matched_endpoint_id?: string;
  max_rank: number;
};

export type SelectionExpectationResult = {
  ok: boolean;
  reason: string;
  matched_endpoint_id?: string;
};

const TRACKING_OR_ADTECH = /\b(doubleverify|optable|liadm|privacymanager|crwdcntrl|demdex|teads|rubicon|pubmatic|adnxs|taboola|outbrain|adsystem|adserver|adtech|tracking|telemetry|analytics|beacon|pixel|impression|click[-_]?tracking|consent|witness|targeting|identify)\b/i;

function toStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export function parseEndpointExpectation(value: unknown): EndpointExpectation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const parsed = {
    ...(typeof record.endpoint_id === "string" && record.endpoint_id.trim()
      ? { endpoint_id: record.endpoint_id.trim() }
      : {}),
    ...(toStringList(record.url_includes).length > 0
      ? { url_includes: toStringList(record.url_includes) }
      : {}),
    ...(toStringList(record.trigger_url_includes).length > 0
      ? { trigger_url_includes: toStringList(record.trigger_url_includes) }
      : {}),
    ...(toStringList(record.description_includes).length > 0
      ? { description_includes: toStringList(record.description_includes) }
      : {}),
    ...(toStringList(record.required_signals).length > 0
      ? { required_signals: toStringList(record.required_signals) }
      : {}),
    ...(toStringList(record.forbidden_signals).length > 0
      ? { forbidden_signals: toStringList(record.forbidden_signals) }
      : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseExpectationGroup(value: unknown): EndpointExpectation[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return Array.isArray(record.any_of)
    ? record.any_of.map((item) => parseEndpointExpectation(item)).filter((item): item is EndpointExpectation => !!item)
    : [];
}

function parseRetrievalExpectation(value: unknown): RetrievalExpectation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const anyOf = parseExpectationGroup(record);
  if (anyOf.length === 0) return undefined;
  const maxRank = typeof record.max_rank === "number" && Number.isFinite(record.max_rank)
    ? Math.max(1, Math.trunc(record.max_rank))
    : undefined;
  return {
    ...(maxRank != null ? { max_rank: maxRank } : {}),
    any_of: anyOf,
  };
}

function parseSelectionExpectation(value: unknown): SelectionExpectation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const anyOf = parseExpectationGroup(value);
  return anyOf.length > 0 ? { any_of: anyOf } : undefined;
}

export function parseHarnessValidation(value: unknown): HarnessCaseValidation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const validate = value as Record<string, unknown>;
  const entityType = typeof validate.entity_type === "string" && validate.entity_type.trim()
    ? validate.entity_type.trim()
    : undefined;
  const minRows = typeof validate.min_rows === "number" && Number.isFinite(validate.min_rows)
    ? Math.max(0, Math.trunc(validate.min_rows))
    : undefined;
  const sideEffect = typeof validate.side_effect === "string" && validate.side_effect.trim()
    ? validate.side_effect.trim()
    : undefined;
  const echoParams = toStringList(validate.echo_params);
  const terminalOk = Array.isArray(validate.terminal_ok)
    ? validate.terminal_ok.filter((state): state is HarnessTerminalState =>
        typeof state === "string" && ["pass", "fail", "skip", "blocked"].includes(state),
      )
    : [];
  const retrieval = parseRetrievalExpectation(validate.retrieval);
  const selection = parseSelectionExpectation(validate.selection);
  const parsed = {
    ...(entityType ? { entity_type: entityType } : {}),
    ...(minRows != null ? { min_rows: minRows } : {}),
    ...(sideEffect ? { side_effect: sideEffect } : {}),
    ...(echoParams.length > 0 ? { echo_params: echoParams } : {}),
    ...(terminalOk.length > 0 ? { terminal_ok: [...new Set(terminalOk)] } : {}),
    ...(retrieval ? { retrieval } : {}),
    ...(selection ? { selection } : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

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

export function endpointMatchesExpectation(endpoint: DeferredEndpoint | undefined, expectation: EndpointExpectation): boolean {
  if (!endpoint) return false;
  if (expectation.endpoint_id && endpoint.endpoint_id !== expectation.endpoint_id) return false;
  if (expectation.url_includes?.some((needle) => !(endpoint.url ?? "").toLowerCase().includes(needle.toLowerCase()))) return false;
  if (expectation.trigger_url_includes?.some((needle) => !(endpoint.trigger_url ?? "").toLowerCase().includes(needle.toLowerCase()))) return false;
  if (expectation.description_includes?.some((needle) => !(endpointDescription(endpoint) ?? "").toLowerCase().includes(needle.toLowerCase()))) return false;
  const signals = deriveEndpointSignals(endpoint);
  if (expectation.required_signals?.some((signal) => !signals.includes(signal))) return false;
  if (expectation.forbidden_signals?.some((signal) => signals.includes(signal))) return false;
  return true;
}

export function evaluateRetrievalExpectation(
  endpoints: DeferredEndpoint[],
  retrieval: RetrievalExpectation,
): RetrievalExpectationResult {
  const maxRank = retrieval.max_rank ?? endpoints.length;
  const scoped = endpoints.slice(0, maxRank);
  for (let index = 0; index < scoped.length; index += 1) {
    const endpoint = scoped[index]!;
    if (retrieval.any_of.some((expectation) => endpointMatchesExpectation(endpoint, expectation))) {
      return {
        ok: true,
        reason: "retrieval_match",
        matched_rank: index + 1,
        matched_endpoint_id: endpoint.endpoint_id,
        max_rank: Math.max(1, maxRank),
      };
    }
  }
  return {
    ok: false,
    reason: `retrieval_missing_top${Math.max(1, maxRank)}`,
    max_rank: Math.max(1, maxRank),
  };
}

export function evaluateSelectionExpectation(
  endpoint: DeferredEndpoint | undefined,
  selection: SelectionExpectation,
): SelectionExpectationResult {
  if (!endpoint) {
    return {
      ok: false,
      reason: "selection_missing_endpoint",
    };
  }
  if (selection.any_of.some((expectation) => endpointMatchesExpectation(endpoint, expectation))) {
    return {
      ok: true,
      reason: "selection_match",
      matched_endpoint_id: endpoint.endpoint_id,
    };
  }
  return {
    ok: false,
    reason: `selection_mismatch:${endpoint.endpoint_id ?? "unknown"}`,
    matched_endpoint_id: endpoint.endpoint_id,
  };
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
          retrieval?: unknown;
          selection?: unknown;
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

    const validate = parseHarnessValidation(nestedValidate);

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
