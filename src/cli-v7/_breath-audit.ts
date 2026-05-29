/**
 * Day-6 Dominion worker 1 (2026-05-28) — shared breath-act audit emitter
 * for the 6 non-value-bearing breath handlers (click, press, scroll,
 * submit, type-literal-path, select-literal-path).
 *
 * Gen 1:26 — *"let them have dominion."*
 * A2 invariant: every act produces a sig-keyed KV row, even when no
 * value is filled. The breath-act variant of the audit log
 * (backend/src/services/audit.ts) is the substrate row; this module
 * is the CLI-side covenant emitter.
 *
 * Why a shared helper instead of inlining the same 30 lines six times:
 *   - John 15:2 — *"every branch that beareth fruit, he purgeth it":*
 *     six copies of the same canonicalization / wallet sign / POST
 *     dance is dead weight; one helper is the pruned form.
 *   - The selector-hash invariant (NEVER raw selector → KV) is enforced
 *     here, in ONE place, so a future handler that forgets to sha256
 *     its selector can't slip through.
 *   - Mirrors the structure of `breath/fill.ts` + `breath/select.ts`
 *     value-bearing audit emit, but for the non-value variant.
 *
 * Discipline:
 *   - W24.6 (2026-05-28, Lewis: "stateless is the only path, why is that
 *     an env"): the legacy no-op branch is purged — every invocation
 *     emits. `skipped` stays on the result envelope for shape stability
 *     and is always `false`. The KV row IS the truth on every call.
 *   - On binding-missing 503: surfaces the failure via the result and
 *     logs a stderr warning. The caller MUST NOT block the user's
 *     gesture on a missing audit binding (Day-6 brief: "warn to stderr,
 *     continue").
 *   - The pointer for a non-value act is `unbrowse-act://<actType>` —
 *     a deterministic synthetic so the AuditFillBody.pointer schema
 *     gate passes without claiming a real value reference.
 *   - The commitment for a non-value act is
 *     `sha256(actType || ":" || sessionId || ":" || contextHash)` —
 *     deterministic, value-free, satisfies the 32-byte-hex gate, and
 *     binds the row to its act+session+context so two clicks on the
 *     same selector at the same epoch produce the SAME receipt id
 *     (idempotent on the wire, same as fill.ts).
 */

import { createHash } from "node:crypto";

import { postStateless } from "./_stateless.js";

const FIVE_MINUTES_MS = 300_000;

/**
 * The allowed BreathActType values — mirror of backend
 * `BREATH_ACT_TYPES`. Closed enum; adding a new breath handler means
 * extending BOTH sides (and the schema-gate test catches drift).
 *
 * Day-6 W24.2 (2026-05-28) — extended for A2 coverage closure across
 * the remaining breath + build kinds. New entries:
 *   navigate              — breath/go.ts (Page.navigate landed)
 *   teardown              — breath/close.ts (target/context closed)
 *   auth-capture-start    — breath/auth-capture.ts (HEADED Chrome spawned)
 *   auth-capture-finish   — breath/auth-capture.ts (keychain write landed)
 *   proxy-rotate          — breath/proxy-rotate.ts (new proxied Chrome up)
 *   session-restore       — breath/session-restore.ts (KV row → fresh tab)
 *   build-skill           — build/skill.ts (skill_declare witness)
 *   build-template        — build/template.ts (fill_template_declare witness)
 *   build-value-source    — build/value-source.ts (value_source_declare witness)
 *
 * The build-* entries witness DECLARATIONS — they do not yet carry the
 * real write side-effect (W3.1 wave). Even so, the witness IS the act:
 * an LLM that asks "did the agent declare X" gets a sig-keyed row back.
 */
export type BreathActType =
  | "click"
  | "press"
  | "scroll"
  | "submit"
  | "type-literal"
  | "select-literal"
  | "navigate"
  | "teardown"
  | "auth-capture-start"
  | "auth-capture-finish"
  | "proxy-rotate"
  | "session-restore"
  | "build-skill"
  | "build-template"
  | "build-value-source";

export interface EmitBreathActInput {
  /** Resolved session id (rec.sessionId from resolveSession). */
  readonly sessionId: string;
  /** Which non-value act fired. */
  readonly actType: BreathActType;
  /**
   * Optional CSS selector — will be sha256-hashed before it leaves
   * this function. NEVER passed raw to the wire. For acts without a
   * selector (focus-bound press), pass undefined / null.
   */
  readonly selector?: string | null;
  /** Live URL at the time of the act (from Page.getNavigationHistory). */
  readonly currentUrl: string;
  /** Override Date.now() — tests pin this for deterministic contextHash. */
  readonly nowMs?: number;
  /** Override backend URL — tests use the mock backend URL. */
  readonly apiBaseUrl?: string;
}

export interface EmitBreathActResult {
  /** True iff the POST returned 2xx. */
  readonly ok: boolean;
  /**
   * W24.6: always `false` (the legacy no-op branch was purged). Kept on
   * the envelope so existing call sites that ternary on `.skipped`
   * compile without churn; the field semantics narrowed to "this was a
   * no-op" — and post-purge no-op never happens.
   */
  readonly skipped: boolean;
  /** True iff the backend reported the row already existed (re-post). */
  readonly idempotent: boolean;
  /** True iff the backend returned 503 with `_binding_missing`. */
  readonly bindingMissing: boolean;
  /** Receipt id, when the POST landed 2xx. */
  readonly receiptId?: string;
  /** HTTP status from the POST. `0` on network error. */
  readonly httpStatus: number;
  /** sha256(signature).slice(0, 32) hex — stable pointer to the truth-claim. */
  readonly cacheKey: string;
  /** contextHash hex used in the body (exposed for tests / receipt lookup). */
  readonly contextHash: string;
  /** Sanitized error hint when ok=false (NEVER carries cleartext). */
  readonly errorHint?: string;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Derive the breath-act contextHash. Mirrors fill.ts:deriveContextHash
 * but uses the `actType` as the second slot in place of selector
 * (selector is hashed separately into selectorHash). 5-minute epoch
 * bucket so two clicks on the same selector at the same act-type +
 * URL within 5 minutes collapse to ONE receipt id (idempotent KV
 * write).
 *
 *   contextHash = hex( sha256(
 *     sessionId || ":" || actType || ":" || selectorOrEmpty || ":" ||
 *     url || ":" || floor(nowMs / 300_000)
 *   ) )
 */
export function deriveBreathActContextHash(
  sessionId: string,
  actType: BreathActType,
  selector: string | null | undefined,
  url: string,
  nowMs: number = Date.now(),
): string {
  const bucket = Math.floor(nowMs / FIVE_MINUTES_MS).toString();
  const sel = selector ?? "";
  const payload = `${sessionId}:${actType}:${sel}:${url}:${bucket}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Emit a breath-act audit row. Pointer-only + selector-hashed — the
 * wire body NEVER carries raw selector text or any value. Returns the
 * result envelope so the caller can warn on binding-missing and continue
 * (DO NOT block the user act). W24.6: the prior conditional no-op branch
 * was purged — stateless is the sole path.
 *
 * Heb 4:13 — every act witnessed; the receipt is the witness.
 */
export async function emitBreathActStateless(
  input: EmitBreathActInput,
): Promise<EmitBreathActResult> {
  const nowMs = input.nowMs ?? Date.now();
  const contextHash = deriveBreathActContextHash(
    input.sessionId,
    input.actType,
    input.selector ?? null,
    input.currentUrl,
    nowMs,
  );
  // Synthetic commitment — deterministic over (actType, sessionId,
  // contextHash). Satisfies the 32-byte-hex schema gate without
  // claiming a real value commitment exists. Two identical acts at
  // the same epoch collide to the SAME commitment, which means the
  // receipt id is also the SAME — idempotent on the wire.
  const commitment = sha256Hex(
    `${input.actType}:${input.sessionId}:${contextHash}`,
  );
  // Synthetic pointer — `unbrowse-act://<actType>` is the URI-shape
  // pointer for a non-value act. Satisfies the AuditFillBody.pointer
  // gate (must be `<scheme>://<rest>`) without claiming a value-store
  // reference exists.
  const pointer = `unbrowse-act://${input.actType}`;
  // Selector is sha256-hashed BEFORE crossing the firmament. The
  // adapter's FORBIDDEN_FIELDS_LC gate guards against raw `selector`
  // sneaking into signableFields; we never put the raw form into the
  // body in the first place.
  const selectorHash = input.selector
    ? sha256Hex(input.selector)
    : undefined;
  const urlHash = input.currentUrl ? sha256Hex(input.currentUrl) : undefined;

  // Build the body the adapter will sign + POST. We assemble the same
  // AuditFillBody shape as fill.ts / select.ts but with the breath-act
  // discriminator + actType + (optional) selectorHash. The adapter
  // adds {walletPubkey, signature, signatureScheme, nonce} on top.
  const body: Record<string, unknown> = {
    pointer,
    contextHash,
    commitment,
    variant: "breath-act" as const,
    actType: input.actType,
  };
  if (selectorHash) body.selectorHash = selectorHash;
  if (urlHash) body.urlHash = urlHash;

  // signableFields: the order MUST match backend's
  // canonicalizeSignedFragment ({pointer, nonce, contextHash, commitment}).
  // The adapter canonicalizes in fields-array order; this list is
  // BYTE-EQUIVALENT to what the audit backend re-derives.
  const result = await postStateless({
    namespace: "audit",
    route: "/v1/audit/breath-act",
    body,
    signableFields: ["pointer", "nonce", "contextHash", "commitment"],
    apiBaseUrl: input.apiBaseUrl,
  });

  if (result.bindingMissing) {
    // 1 Cor 14:8 — uncertain trumpet: a missing binding surfaces as a
    // visible warning, not a silent swallow. The handler decides what
    // to do; the Day-6 contract is "continue, don't block".
    try {
      // eslint-disable-next-line no-console -- stderr warning is the spec
      process.stderr.write(
        `unbrowse: audit binding missing (${result.bindingMissing}); breath-act receipt skipped, gesture succeeded\n`,
      );
    } catch {
      /* stderr.write may fail in some test harnesses — best-effort */
    }
    return {
      ok: false,
      skipped: false,
      idempotent: false,
      bindingMissing: true,
      httpStatus: result.httpStatus,
      cacheKey: result.cacheKey,
      contextHash,
    };
  }

  return {
    ok: result.ok,
    skipped: false,
    idempotent: result.idempotent,
    bindingMissing: false,
    receiptId: result.receiptId,
    httpStatus: result.httpStatus,
    cacheKey: result.cacheKey,
    contextHash,
    errorHint: result.errorHint,
  };
}
