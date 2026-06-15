/**
 * src/lib/infer-write-method.ts — infer the HTTP verb for an agent-native write.
 *
 * The agent expresses INTENT, never an HTTP method. Unbrowse infers the verb from
 * the intent verbs and whether a request body is present (a body ⇒ a write). An
 * explicit method always wins; a resolved/indexed endpoint's own method wins over
 * this entirely (that decision lives in the resolver, not here). Returns `undefined`
 * for a read, so the caller keeps the existing GET path.
 *
 * Pure + dependency-free → unit-testable without a CLI or network.
 */
export type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Ordered, most-specific first. Each entry: [verb, intent-keyword regex].
const INTENT_RULES: Array<[WriteMethod, RegExp]> = [
  ["DELETE", /\b(delete|remove|destroy|cancel|unsubscribe|revoke|deregister)\b/i],
  ["PUT", /\b(replace|overwrite|put|set\s+the\s+entire)\b/i],
  ["PATCH", /\b(update|edit|modify|change|rename|patch|adjust|toggle)\b/i],
  ["POST", /\b(create|post|add|submit|new|register|sign\s*up|send|upload|publish|insert|book|order|comment|reply|like|upvote|vote)\b/i],
];

/**
 * @param explicit  the caller's --method, if any (highest precedence).
 * @param intent    the agent's intent text.
 * @param hasBody   whether a request body was supplied.
 * @returns the write verb, or undefined for a read (caller defaults to GET).
 */
export function inferWriteMethod(
  explicit: string | undefined,
  intent: string,
  hasBody: boolean,
): WriteMethod | undefined {
  if (explicit) {
    const m = explicit.toUpperCase();
    if (WRITE_METHODS.has(m)) return m as WriteMethod;
    if (READ_METHODS.has(m)) return undefined; // explicit read — honour it
  }
  const text = intent || "";
  for (const [verb, re] of INTENT_RULES) {
    if (re.test(text)) return verb;
  }
  // A body with no read-leaning intent implies a create.
  if (hasBody) return "POST";
  return undefined;
}

/**
 * Extract a JSON request body the agent embedded in a natural-language intent, e.g.
 * `create a record by POSTing {"name":"x","n":1}` → `{"name":"x","n":1}`. Returns the
 * raw JSON substring (valid JSON only) or undefined. Used by the one-hole write path so
 * `unbrowse "<intent with JSON>" --url …` writes natively, without a separate --body flag.
 *
 * Pure + dependency-free. The CALLER must still confirm a write verb before treating the
 * result as a body, so a read intent that merely contains braces is never mis-routed.
 */
export function extractEmbeddedJsonBody(intent: string): string | undefined {
  if (!intent) return undefined;
  // First {…} object or […] array in the text (greedy to the matching outer brace).
  const m = intent.match(/[{[][\s\S]*[}\]]/);
  if (!m) return undefined;
  try {
    const parsed = JSON.parse(m[0]);
    // Only an object/array is a plausible request body; a bare number/string in braces is not.
    if (parsed && typeof parsed === "object") return m[0];
  } catch { /* not valid JSON */ }
  return undefined;
}
