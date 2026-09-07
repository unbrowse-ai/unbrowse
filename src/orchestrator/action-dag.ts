export const CANONICAL_ACTION_DAG = [
  { id: "direct", depends_on: [] },
  { id: "discover", depends_on: ["direct:miss"] },
  { id: "execute", depends_on: ["direct:hit", "discover"] },
  { id: "publish", depends_on: ["execute:success"] },
  { id: "subsequent_direct", depends_on: ["publish:settled"] },
] as const;

/** True only for routes whose evidence says replay is read-only. */
export function isEvidenceBackedReadEndpoint(endpoint: object | undefined): boolean {
  if (!endpoint) return false;
  const value = endpoint as Record<string, unknown>;
  const method = String(value.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return true;
  if (method !== "POST") return false;
  if (value.idempotency === "unsafe") return false;
  const semantic = value.semantic as Record<string, unknown> | undefined;
  const kind = String(value.action_kind ?? semantic?.action_kind ?? "").toLowerCase();
  const description = String(value.description ?? "").toLowerCase();
  const readSignal = /^(read|search|list|lookup|fetch|query|detail|timeline)$/.test(kind)
    || /\b(search|list|lookup|fetch|query|read|get|find)\b/.test(description);
  const mutationSignal = /\b(create|update|delete|remove|submit|apply|purchase|send|write|mutat|book|cancel)\b/.test(`${kind} ${description}`);
  return readSignal && !mutationSignal && !!value.trigger_url && !!value.response_schema;
}
