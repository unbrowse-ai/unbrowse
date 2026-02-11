const API_INTENT_PATTERNS = [
  /\binternal\s+api\b/i,
  /\bprivate\s+api\b/i,
  /\breverse[-\s]?engineer\b.*\bapi\b/i,
  /\bcapture\b.*\bapi\b/i,
  /\bdiscover\b.*\bapi\b/i,
  /\bapi\s+endpoint(s)?\b/i,
  /\bunbrowse(_|\s)?(capture|replay|login|skills|do)\b/i,
  /\bauth\s+(token|header|cookie|cookies)\b/i,
  /\bprogrammatic(ally)?\s+access\b/i,
  /\bautomate\b.*\bwebsite\b/i,
];

function extractMessageContentText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => extractMessageContentText(item))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content !== "object") return "";

  const c = content as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof c.text === "string") parts.push(c.text);
  if (typeof c.value === "string") parts.push(c.value);
  if (typeof c.content === "string") parts.push(c.content);
  if (c.content && typeof c.content !== "string") {
    const nested = extractMessageContentText(c.content);
    if (nested) parts.push(nested);
  }
  return parts.join("\n");
}

export function extractPromptText(event: unknown): string {
  if (!event) return "";
  if (typeof event === "string") return event;
  if (Array.isArray(event)) {
    return event
      .map((item) => extractPromptText(item))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof event !== "object") return "";

  const e = event as Record<string, unknown>;
  const parts: string[] = [];

  const directFields = ["prompt", "userPrompt", "input", "query", "text", "message"] as const;
  for (const field of directFields) {
    const value = e[field];
    if (typeof value === "string") parts.push(value);
  }

  const messageArrays = ["messages", "conversation"] as const;
  for (const key of messageArrays) {
    const value = e[key];
    if (!Array.isArray(value)) continue;
    for (const message of value) {
      if (!message || typeof message !== "object") continue;
      const m = message as Record<string, unknown>;
      if (m.role === "assistant" || m.role === "system") continue;
      const text = extractMessageContentText(m.content ?? m.text ?? m.value);
      if (text) parts.push(text);
    }
  }

  return parts.join("\n").trim();
}

export function hasApiIntent(event: unknown): boolean {
  const promptText = extractPromptText(event);
  if (!promptText) return false;
  return API_INTENT_PATTERNS.some((pattern) => pattern.test(promptText));
}
