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
  return merged;
}
