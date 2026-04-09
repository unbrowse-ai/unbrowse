function sanitizeBindingKey(key: string): string {
  return key
    .replace(/\[\]/g, "_item")
    .replace(/\[([^\]]+)\]/g, (_m, inner: string) => `_${inner}`)
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeQueryBindingKey(key: string): string {
  const normalized = sanitizeBindingKey(key);
  if (!normalized) return "query";
  return /^[0-9]/.test(normalized) ? `query_${normalized}` : normalized;
}

export function buildQueryBindingMap(keys: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const rawKey of keys) {
    if (!rawKey || out[rawKey]) continue;
    const base = normalizeQueryBindingKey(rawKey);
    let next = base;
    let suffix = 2;
    while (used.has(next)) next = `${base}_${suffix++}`;
    used.add(next);
    out[rawKey] = next;
  }
  return out;
}

export function extractTemplateQueryBindings(urlTemplate: string): Record<string, string> {
  try {
    const templateUrl = new URL(urlTemplate);
    const out: Record<string, string> = {};
    for (const [key, value] of templateUrl.searchParams.entries()) {
      const placeholder = value.match(/^\{([^}]+)\}$/)?.[1];
      if (placeholder) out[key] = placeholder;
    }
    return out;
  } catch {
    return {};
  }
}

export function deriveTemplateParamsFromContextUrl(
  urlTemplate: string,
  contextUrl?: string,
): Record<string, string> {
  if (!contextUrl) return {};
  try {
    const templateUrl = new URL(urlTemplate);
    const actualUrl = new URL(contextUrl);
    const out: Record<string, string> = {};

    const templateParts = templateUrl.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    const actualParts = actualUrl.pathname.split("/").filter(Boolean);
    if (templateParts.length === actualParts.length) {
      let compatible = true;
      for (let i = 0; i < templateParts.length; i++) {
        const templatePart = templateParts[i];
        const actualPart = actualParts[i];
        const placeholder = templatePart.match(/^\{([^}]+)\}$/)?.[1];
        if (placeholder) {
          out[placeholder] = decodeURIComponent(actualPart);
          continue;
        }
        if (templatePart !== actualPart) {
          compatible = false;
          break;
        }
      }
      if (!compatible) {
        for (const key of Object.keys(out)) delete out[key];
      }
    }

    for (const [key, value] of templateUrl.searchParams.entries()) {
      const placeholder = value.match(/^\{([^}]+)\}$/)?.[1];
      if (!placeholder) continue;
      const actualValue = actualUrl.searchParams.get(key);
      if (actualValue != null && actualValue !== "") {
        out[placeholder] = actualValue;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function deriveSemanticTemplateParams(
  urlTemplate: string,
  contextUrl?: string,
): Record<string, string> {
  if (!contextUrl) return {};
  try {
    const templateNames = [...urlTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).filter(Boolean);
    if (templateNames.length === 0) return {};
    const actualUrl = new URL(contextUrl);
    const actualParts = actualUrl.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    const lowerParts = actualParts.map((part) => part.toLowerCase());
    const out: Record<string, string> = {};

    for (const name of templateNames) {
      const lower = name.toLowerCase();
      if (lower === "tag" || lower === "tags") {
        const prefixIndex = lowerParts.findIndex((part) => part === "t" || part === "tag" || part === "tags");
        if (prefixIndex >= 0 && actualParts[prefixIndex + 1]) out[name] = actualParts[prefixIndex + 1]!;
      }
    }

    return out;
  } catch {
    return {};
  }
}

export function mergeContextTemplateParams(
  params: Record<string, unknown>,
  urlTemplate: string,
  contextUrl?: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...params };
  const inferred = deriveTemplateParamsFromContextUrl(urlTemplate, contextUrl);
  for (const [key, value] of Object.entries(inferred)) {
    if (merged[key] == null || merged[key] === "") merged[key] = value;
  }
  for (const [key, value] of Object.entries(deriveSemanticTemplateParams(urlTemplate, contextUrl))) {
    if (merged[key] == null || merged[key] === "") merged[key] = value;
  }
  for (const [rawKey, placeholder] of Object.entries(extractTemplateQueryBindings(urlTemplate))) {
    if ((merged[placeholder] == null || merged[placeholder] === "") && merged[rawKey] != null && merged[rawKey] !== "") {
      merged[placeholder] = merged[rawKey];
    }
    if ((merged[rawKey] == null || merged[rawKey] === "") && merged[placeholder] != null && merged[placeholder] !== "") {
      merged[rawKey] = merged[placeholder];
    }
  }
  return merged;
}
