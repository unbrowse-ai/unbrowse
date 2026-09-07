/**
 * src/lib/write-receipt.ts — a contract-shaped receipt for an agent write.
 *
 * A write IS a contract: declare intent → execute → satisfy with proof. This builds
 * the receipt in unbrowse's OWN vocabulary (OperationBinding requires/provides, hash
 * commitments) — NOT by shelling out to any external ledger. It is what lets writes
 * compose in the route DAG exactly like reads:
 *
 *   - requires : the inputs the write consumes (body fields + auth). Sensitive leaves
 *                carry their sha256 commitment, not the value (privacy-preserving edge).
 *   - provides : what the write YIELDS — the created-resource id(s) parsed from the
 *                response — so a downstream op can chain on the new resource.
 *   - response_commitment : sha256 of the response body (proof-of-result).
 *
 * Pure + dependency-light → unit-testable without a CLI or network.
 */
import { censorInputBody, commitValue, isSensitiveFieldName } from "../proof/input-censor.js";
import { hashResponseBody } from "../proof/commitment.js";
import type { OperationBinding } from "../types/skill.js";

export type WriteReceipt = {
  claim: string;
  input_commitments: Record<string, string>;
  response_commitment: string;
  requires: OperationBinding[];
  provides: OperationBinding[];
};

/** requires bindings — one per top-level body field. Sensitive values are committed. */
export function bindingsFromBody(body: unknown): OperationBinding[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const out: OperationBinding[] = [];
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const sensitive = isSensitiveFieldName(k);
    out.push({
      key: k,
      required: true,
      source: "body",
      ...(sensitive
        ? { semantic_type: "secret", example_value: commitValue(String(v)) }
        : typeof v === "string" || typeof v === "number" || typeof v === "boolean"
          ? { example_value: String(v) }
          : {}),
    });
  }
  return out;
}

const ID_KEY = /^(id|uuid|_id|.+_id|.+Id|slug|key|name)$/;

/** provides (yields) — created-resource identifiers parsed from a write response. */
export function yieldsFromResponse(responseBody: unknown): OperationBinding[] {
  let obj: unknown = responseBody;
  if (typeof responseBody === "string") {
    try { obj = JSON.parse(responseBody); } catch { return []; }
  }
  // unwrap a common { data: {...} } / { json: {...} } envelope
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    const inner = (rec.data ?? rec.json ?? rec.result) as unknown;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) obj = inner;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const out: OperationBinding[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (ID_KEY.test(k) && (typeof v === "string" || typeof v === "number")) {
      out.push({ key: k, source: "response", semantic_type: "resource_id", example_value: String(v) });
    }
  }
  return out;
}

export function buildWriteReceipt(input: {
  intent?: string;
  method: string;
  url: string;
  body?: unknown;
  responseBody?: unknown;
}): WriteReceipt {
  const { commitments } = censorInputBody(input.body ?? {});
  return {
    claim: input.intent?.trim() || `${input.method.toUpperCase()} ${input.url}`,
    input_commitments: commitments,
    response_commitment: hashResponseBody(
      typeof input.responseBody === "string"
        ? input.responseBody
        : input.responseBody == null
          ? ""
          : JSON.stringify(input.responseBody),
    ),
    requires: bindingsFromBody(input.body),
    provides: yieldsFromResponse(input.responseBody),
  };
}
