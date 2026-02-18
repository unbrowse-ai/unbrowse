import type { CsrfProvenance, CsrfProvenanceRule, CsrfSourceType } from "./types.js";

type Inputs = {
  authHeaders?: Record<string, string>;
  cookies?: Record<string, string>;
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  metaTokens?: Record<string, string>;
  authInfo?: Record<string, string>;
  existing?: CsrfProvenance;
};

function normalize(value: string): string {
  return value.trim();
}

function isCsrfName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("csrf") || lower.includes("xsrf");
}

function confidenceFor(source: CsrfSourceType): number {
  if (source === "cookie") return 0.95;
  if (source === "localStorage" || source === "sessionStorage" || source === "meta") return 0.9;
  if (source === "header") return 0.7;
  return 0.5;
}

function pickRuleFromValue(opts: {
  targetHeader: string;
  value: string;
  authHeaders: Record<string, string>;
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  metaTokens: Record<string, string>;
}): CsrfProvenanceRule {
  const targetHeaderLower = opts.targetHeader.toLowerCase();
  const targetValue = normalize(opts.value);

  const exactMatch = (obj: Record<string, string>, source: CsrfSourceType): CsrfProvenanceRule | null => {
    for (const [k, v] of Object.entries(obj)) {
      if (normalize(String(v)) === targetValue) {
        return {
          targetHeader: targetHeaderLower,
          sourceType: source,
          sourceKey: k,
          confidence: confidenceFor(source),
          observedAt: new Date().toISOString(),
        };
      }
    }
    return null;
  };

  return (
    exactMatch(opts.cookies, "cookie") ??
    exactMatch(opts.localStorage, "localStorage") ??
    exactMatch(opts.sessionStorage, "sessionStorage") ??
    exactMatch(opts.metaTokens, "meta") ?? {
      targetHeader: targetHeaderLower,
      sourceType: "header",
      sourceKey: targetHeaderLower,
      confidence: confidenceFor("header"),
      observedAt: new Date().toISOString(),
    }
  );
}

function mapByTargetHeader(provenance?: CsrfProvenance): Map<string, CsrfProvenanceRule> {
  const map = new Map<string, CsrfProvenanceRule>();
  for (const rule of provenance?.rules ?? []) {
    if (!rule?.targetHeader) continue;
    const key = rule.targetHeader.toLowerCase();
    const prev = map.get(key);
    if (!prev || (rule.confidence ?? 0) >= (prev.confidence ?? 0)) {
      map.set(key, rule);
    }
  }
  return map;
}

export function inferCsrfProvenance(input: Inputs): CsrfProvenance | undefined {
  const authHeaders = input.authHeaders ?? {};
  const cookies = input.cookies ?? {};
  const localStorage = input.localStorage ?? {};
  const sessionStorage = input.sessionStorage ?? {};
  const metaTokens = input.metaTokens ?? {};
  const authInfo = input.authInfo ?? {};

  const csrfHeaderEntries: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(authHeaders)) {
    if (isCsrfName(k)) csrfHeaderEntries.push([k.toLowerCase(), v]);
  }

  // Fallback: captured request auth info may include csrf headers even if current
  // authHeaders was pruned/rotated.
  if (csrfHeaderEntries.length === 0) {
    for (const [k, v] of Object.entries(authInfo)) {
      if (!k.startsWith("request_header_")) continue;
      const header = k.replace("request_header_", "").toLowerCase();
      if (isCsrfName(header)) csrfHeaderEntries.push([header, String(v)]);
    }
  }

  if (csrfHeaderEntries.length === 0) return input.existing;

  const byHeader = mapByTargetHeader(input.existing);
  for (const [headerName, value] of csrfHeaderEntries) {
    if (!value) continue;
    const next = pickRuleFromValue({
      targetHeader: headerName,
      value,
      authHeaders,
      cookies,
      localStorage,
      sessionStorage,
      metaTokens,
    });
    const prev = byHeader.get(headerName);
    if (!prev || next.confidence >= prev.confidence || prev.sourceType === "header") {
      byHeader.set(headerName, next);
    }
  }

  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    rules: [...byHeader.values()],
  };
}

export function applyCsrfProvenance(input: {
  authHeaders: Record<string, string>;
  cookies?: Record<string, string>;
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  metaTokens?: Record<string, string>;
  csrfProvenance?: CsrfProvenance;
}): { authHeaders: Record<string, string>; applied: string[] } {
  const authHeaders = { ...(input.authHeaders ?? {}) };
  const cookies = input.cookies ?? {};
  const localStorage = input.localStorage ?? {};
  const sessionStorage = input.sessionStorage ?? {};
  const metaTokens = input.metaTokens ?? {};
  const applied: string[] = [];

  for (const rule of input.csrfProvenance?.rules ?? []) {
    const target = rule.targetHeader.toLowerCase();
    let value: string | undefined;
    if (rule.sourceType === "cookie") value = cookies[rule.sourceKey];
    if (rule.sourceType === "localStorage") value = localStorage[rule.sourceKey];
    if (rule.sourceType === "sessionStorage") value = sessionStorage[rule.sourceKey];
    if (rule.sourceType === "meta") value = metaTokens[rule.sourceKey];
    if (rule.sourceType === "header") value = authHeaders[rule.sourceKey] ?? authHeaders[rule.sourceKey.toLowerCase()];
    if (!value) continue;
    if (authHeaders[target] !== value) {
      authHeaders[target] = value;
      applied.push(`${target}<=${rule.sourceType}:${rule.sourceKey}`);
    }
  }

  return { authHeaders, applied };
}
