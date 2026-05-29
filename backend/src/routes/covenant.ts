/**
 * covenant.ts — the ONE unified write surface `POST /v1/covenant` (W26-C,
 * 2026-05-28).
 *
 * Eph 4:4 — *"one body, and one Spirit."* Lewis: "they should share the same
 * database lol and endpoint lol its the same shape of everything." The 8 POST
 * append handlers across audit/session/trace/settings all do the identical
 * dance (json → validate → verify → derive → persist → respond,
 * CONVERGENCE_MAP §2). This route is the single covenant-shaped front door:
 *
 *     POST /v1/covenant
 *       { kind, params, witness?, identity, signature, signatureScheme? }
 *
 * `kind` is a `covenant_base_kind:action` (e.g. "actuate:navigate",
 * "observe:snap", "build:skill") OR a raw covenant base kind. The base kind
 * (actuate/observe/build) discriminates which sibling service the dispatcher
 * calls INTO; the `action` discriminates the specific handler within it
 * (kind-map collapse — CONVERGENCE_MAP §4, src/cli-v7/kind-map.ts).
 *
 * ─── BLAST RADIUS (W26-C contract) ──────────────────────────────────────────
 *
 * This file + services/covenant-peer.ts + the mount in index.ts + 2 Env fields
 * are the ENTIRE W26-C surface. The 5 sibling service files (audit.ts,
 * session-state.ts, trace-state.ts, settings-state.ts, screenshot-blob.ts) are
 * owned by W26-A/W26-B — this route IMPORTS and CALLS INTO them, never edits
 * them. The legacy `/v1/audit/*`, `/v1/session/*`, `/v1/trace/*`,
 * `/v1/settings/*` routes stay mounted as read-sugar + back-compat aliases that
 * already produce the same covenant-shaped sig-keyed receipts internally.
 *
 * ─── Dispatch table (base-kind → handler) ───────────────────────────────────
 *
 *   actuate:navigate|fill|...|breath-acts  → audit.ts persistAuditRow (variant
 *                                            fill/header-inject/payload-field/
 *                                            breath-act, action in params)
 *   actuate:session_park                   → session-state.ts persistParkedSession
 *   observe:<surface>                      → audit.ts eval-read row (readKind=action)
 *   observe:trace                          → trace-state.ts persistTraceRow
 *   build:skill|template|value-source      → audit.ts breath-act row
 *                                            (actType=build-<action>), the
 *                                            declare receipt
 *   build:settings (settings_set)          → settings-state.ts persistSettingsRow
 *
 * ─── Peer federation (W26-C) ────────────────────────────────────────────────
 *
 * After the unbrowse KV write, the route fires `ctx.waitUntil(
 * mirrorToCovenantLedger(env, receipt))` — fire-and-forget; NEVER blocks the
 * user response (Gen 2:18 — ezer kenegdo; the covenant binary is the facing
 * helper). The mirror is an honest no-op when COVENANT_LEDGER_URL is unset.
 *
 * ─── Shared content-address ("same database") ───────────────────────────────
 *
 * `covenantReceiptPtr = deriveCovenantReceiptPtr(canonical)` is computed ONCE
 * and is identical to (a) the value echoed to the caller, (b) the value
 * mirrored to the covenant ledger as `params.unbrowse_receipt_ptr`. The
 * unbrowse KV row's own receipt id (from the sibling persist) uses the SAME
 * sha256-over-canonical mechanism, so the two stores join on one content
 * address — CONVERGENCE_MAP §3 (option a + c).
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import {
  canonicalize,
  deriveCovenantReceiptPtr,
} from "../services/covenant-core.js";
import { safeExecutionCtx } from "../services/kv-cache.js";
import { mirrorToCovenantLedger } from "../services/covenant-peer.js";
import {
  persistAuditRow,
  verifyAuditSignature,
  deriveReceiptId as deriveAuditReceiptId,
  BindingMissingError as AuditBindingMissing,
  type AuditFillBody,
  type AuditVariant,
} from "../services/audit.js";
import { __evalReadInternal } from "./audit.js";
import {
  persistParkedSession,
  verifySessionParkSignature,
  deriveReceiptId as deriveSessionReceiptId,
  BindingMissingError as SessionBindingMissing,
  type SessionParkBody,
} from "../services/session-state.js";
import {
  persistTraceRow,
  verifyTraceAppendSignature,
  deriveCacheKeyHex as deriveTraceCacheKeyHex,
  BindingMissingError as TraceBindingMissing,
  type TraceAppendBody,
} from "../services/trace-state.js";
import {
  persistSettingsRow,
  verifySettingsSetSignature,
  deriveCacheKeyHex as deriveSettingsCacheKeyHex,
  BindingMissingError as SettingsBindingMissing,
  type SettingsSetBody,
} from "../services/settings-state.js";

type CovenantEnv = { Bindings: Env; Variables: Record<string, never> };

export const covenantRoutes = new Hono<CovenantEnv>();

// ─── Witness defaults (the KindSpec default_witness, supplied server-side ────
// when the wire omits it — COVENANT_SUBSTRATE_MAP §6 honest gap #3: no
// unbrowse body carries a real witness, so the base kind supplies one).

const DEFAULT_WITNESS: Record<string, string> = {
  actuate: "verse:Genesis 1:3", // "Let there be light" — the breath act
  observe: "verse:Genesis 1:4", // "God saw the light, that it was good" — the read
  build: "verse:Genesis 1:11",  // "bearing fruit after their kind" — the declare
};

const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Mechanism actions that must NEVER be dispatchable from the PUBLIC
 * surface — even smuggled behind a valid base (e.g. `observe:revealed_context`).
 *
 *   Genesis 1:9 — *"the waters gathered... and the dry land appear."* The
 *   internet ops are the dry land; the mechanism stays below the waters.
 *
 * These are aiko-only (the sovereign covenant binary + aiko-proxy). A public
 * caller naming one gets `unknown_op` (Mark 4:11 — parables to them without);
 * an aiko-key caller is allowed through. Mirrors the CLI/MCP allowlist gate in
 * `src/cli-v7/dispatch/index.ts` (`PUBLIC_OP_ALLOWLIST`). See
 * `.planning/v7-rip/INTERNET_LAYER_COVENANT_SURFACE.md` §1 (HIDDEN) + §5.
 */
const MECHANISM_ACTIONS: ReadonlySet<string> = new Set([
  "revealed_context", // leak-guard:allow — boundary CONTROL (deny-list), not a leak
  "diffusion_populate", // leak-guard:allow
  "diffuse", // leak-guard:allow
  "ebm_route", // leak-guard:allow
  "ebm_train", // leak-guard:allow
  "ebm_loop", // leak-guard:allow
  "energy_score", // leak-guard:allow
  "canon_witness", // leak-guard:allow
  "rules_for_identity", // leak-guard:allow
  "establishment_query", // leak-guard:allow
  "recall_episode", // leak-guard:allow
  "lineage", // leak-guard:allow
  "lineage_query", // leak-guard:allow
  "cache_verify", // leak-guard:allow
]);

/** Timing-safe equality — never leak the configured key length via timing. */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Is this an AIKO-AUTHENTICATED (insider) caller? Mark 4:11 — *"the mystery to
 * you; parables to them without."* Insiders see the full mechanism (`kind` /
 * `action`); the public sees only the opaque receipt-ptr. The gate accepts a
 * dedicated `AIKO_KEY` OR the `ADMIN_KEY` (reused so a fresh secret is optional)
 * via `Authorization: Bearer <key>`. Default — no key configured or no/mismatched
 * header — is STRIPPED (public). Never echoes the configured key.
 */
function isAikoCaller(c: Context<CovenantEnv>): boolean {
  const aikoKey = c.env.AIKO_KEY?.trim();
  const adminKey = c.env.ADMIN_KEY?.trim();
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  if (aikoKey && safeCompare(token, aikoKey)) return true;
  if (adminKey && safeCompare(token, adminKey)) return true;
  return false;
}

/** The covenant envelope this endpoint accepts. */
interface CovenantEnvelope {
  /** "base:action" or a raw base kind. */
  kind: string;
  /** The covenant params blob — carries the unbrowse-specific body fields. */
  params: Record<string, unknown>;
  /** Scripture/provenance ref; defaults per base kind when absent. */
  witness?: string;
  /** wallet:<hex> | did:key:hex:<hex> | bare 64-char hex pubkey. */
  identity: string;
  /** Ed25519 hex (the client-side seal). */
  signature: string;
  signatureScheme?: string;
}

/** Extract the 64-char hex Ed25519 pubkey from a DID/wallet identity string. */
function identityToPubkeyHex(identity: string): string | null {
  // Accept: "wallet:<hex>", "did:key:hex:<hex>", "wallet:lekt9"-style names
  // are NOT pubkeys (no verify possible), or a bare 64-char hex.
  const m = identity.match(/(?:^|:)([0-9a-fA-F]{64})$/);
  if (m) return m[1].toLowerCase();
  const bare = identity.replace(/^0x/, "");
  if (bare.length === 64 && HEX_RE.test(bare)) return bare.toLowerCase();
  return null;
}

/** Split "base:action" → { base, action }. A raw base kind yields action "". */
function splitKind(kind: string): { base: string; action: string } {
  const idx = kind.indexOf(":");
  if (idx < 0) return { base: kind, action: "" };
  return { base: kind.slice(0, idx), action: kind.slice(idx + 1) };
}

/** Coerce a params value to a string field, or undefined. */
function pStr(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Map an action → the audit variant + the breath actType (for breath-act and
 * build rows). The kind-map's actuate_* / build_* actions collapse onto audit
 * variants here.
 */
const ACTUATE_VALUE_VARIANTS: ReadonlySet<string> = new Set(["fill"]);
const ACTUATE_HEADER_VARIANTS: ReadonlySet<string> = new Set(["header-inject"]);
const ACTUATE_PAYLOAD_VARIANTS: ReadonlySet<string> = new Set(["payload-field"]);
const BREATH_ACT_ACTIONS: Record<string, string> = {
  click: "click",
  press: "press",
  scroll: "scroll",
  submit: "submit",
  type: "type-literal",
  select: "select-literal",
  navigate: "navigate",
  close: "teardown",
  auth_capture: "auth-capture-start",
  proxy_rotate: "proxy-rotate",
  session_restore: "session-restore",
  execute: "navigate", // execute is a non-value breath act at the audit layer
};
const BUILD_ACT_ACTIONS: Record<string, string> = {
  skill: "build-skill",
  template: "build-template",
  "value-source": "build-value-source",
  value_source: "build-value-source",
};

/**
 * The unified covenant write. Dispatches by base kind to the sibling service,
 * verifies the wallet signature, returns the unified receipt, and fires the
 * peer-ledger mirror via ctx.waitUntil (fire-and-forget).
 */
covenantRoutes.post("/v1/covenant", async (c: Context<CovenantEnv>) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", reason: "body must be JSON" }, 400);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return c.json({ error: "invalid_body", reason: "body must be a JSON object" }, 400);
  }
  const env = raw as Record<string, unknown>;
  const kindRaw = env.kind;
  if (typeof kindRaw !== "string" || kindRaw.length === 0) {
    return c.json({ error: "invalid_body", field: "kind", reason: "required string" }, 400);
  }
  const params =
    env.params && typeof env.params === "object" && !Array.isArray(env.params)
      ? (env.params as Record<string, unknown>)
      : {};
  const identity = env.identity;
  if (typeof identity !== "string" || identity.length === 0) {
    return c.json({ error: "invalid_body", field: "identity", reason: "required string" }, 400);
  }
  const signature = env.signature;
  if (typeof signature !== "string" || signature.length === 0) {
    return c.json({ error: "invalid_body", field: "signature", reason: "required string" }, 400);
  }
  const signatureScheme =
    typeof env.signatureScheme === "string" ? env.signatureScheme : undefined;

  const envelope: CovenantEnvelope = {
    kind: kindRaw,
    params,
    witness: typeof env.witness === "string" ? env.witness : undefined,
    identity,
    signature,
    signatureScheme,
  };

  // Mark 4:11 — insiders (aiko-authenticated) see the mechanism; the public
  // sees only the opaque receipt-ptr. Computed once, threaded to every response.
  const aiko = isAikoCaller(c);

  const { base, action } = splitKind(envelope.kind);

  // ─── Mechanism public-reject / aiko-allow gate (Genesis 1:9) ───────────
  // A mechanism action (revealed_context / diffusion_populate / ebm_route /
  // canon_witness / rules_for_identity / establishment_query / recall_episode /
  // ...) is NOT an internet-layer op — even when smuggled behind a valid base
  // (`observe:revealed_context`). The PUBLIC surface fails it CLOSED with the
  // opaque `unknown_op`; an aiko-key caller is allowed through to dispatch.
  if ((MECHANISM_ACTIONS.has(action) || MECHANISM_ACTIONS.has(base)) && !aiko) {
    return c.json({ error: "unknown_op", reason: "op kind not recognized" }, 400);
  }

  if (base !== "actuate" && base !== "observe" && base !== "build") {
    // Public callers get a generic `op` token; never the 3-verb vocabulary.
    return c.json(
      aiko
        ? {
            error: "unknown_kind",
            reason: `kind base must be actuate|observe|build (got '${base}')`,
            kind: envelope.kind,
          }
        : {
            error: "unknown_op",
            reason: "op kind not recognized",
          },
      400,
    );
  }

  const walletPubkey = identityToPubkeyHex(envelope.identity);
  if (!walletPubkey) {
    return c.json(
      {
        error: "invalid_identity",
        reason: "identity must resolve to a 32-byte Ed25519 hex pubkey (wallet:<hex> | did:key:hex:<hex> | <64-hex>)",
      },
      400,
    );
  }

  // ─── Cross-wallet guard ────────────────────────────────────────────────
  // If params carries an explicit walletPubkey, it MUST match the signing
  // identity. A request that signs as wallet-A but tries to write a row
  // bound to wallet-B is a cross-wallet write — 403 (Deut 19:15: the
  // identity and the body-bound wallet are two witnesses that must agree).
  const paramWallet = pStr(params, "walletPubkey");
  if (paramWallet && paramWallet.toLowerCase().replace(/^0x/, "") !== walletPubkey) {
    return c.json(
      {
        error: "cross_wallet_forbidden",
        reason: "params.walletPubkey does not match the signing identity",
      },
      403,
    );
  }

  // The canonical covenant body — fixed insertion order, pointer-only.
  // deriveCovenantReceiptPtr hashes THIS (covenant-core: insertion-order
  // JSON.stringify → sha256 → "sha256:"-prefixed). The SAME pointer is
  // echoed, mirrored, and content-addresses the unbrowse KV row.
  const canonicalBody = canonicalize({
    kind: base,
    action,
    params,
    witness: envelope.witness ?? DEFAULT_WITNESS[base],
    identity: `wallet:${walletPubkey}`,
    signatureScheme: envelope.signatureScheme ?? "ed25519-v7.0",
    signature: envelope.signature,
  });
  const covenantReceiptPtr = await deriveCovenantReceiptPtr(canonicalBody);

  // ─── Dispatch by base kind into the sibling services ───────────────────
  let dispatch: { ok: true; receiptId: string; verifyOk: boolean; idempotent: boolean }
    | { ok: false; status: 400 | 401 | 403 | 503; payload: Record<string, unknown> };

  try {
    if (base === "build" && (action === "settings" || action === "settings_set")) {
      dispatch = await dispatchSettings(c.env, params, walletPubkey, envelope.signature, envelope.signatureScheme);
    } else if (base === "actuate" && action === "session_park") {
      dispatch = await dispatchSessionPark(c.env, params, walletPubkey, envelope.signature, envelope.signatureScheme);
    } else if (base === "observe" && action === "trace") {
      dispatch = await dispatchTrace(c.env, params, walletPubkey, envelope.signature, envelope.signatureScheme);
    } else if (base === "observe") {
      dispatch = await dispatchEvalRead(c.env, action, params, walletPubkey, envelope.signature, envelope.signatureScheme);
    } else {
      // actuate (value/breath acts) + build (declares) → audit row.
      dispatch = await dispatchAudit(c.env, base, action, params, walletPubkey, envelope.signature, envelope.signatureScheme);
    }
  } catch (err) {
    if (
      err instanceof AuditBindingMissing ||
      err instanceof SessionBindingMissing ||
      err instanceof TraceBindingMissing ||
      err instanceof SettingsBindingMissing
    ) {
      return c.json(
        {
          ok: false,
          _binding_missing: bindingNameForBase(base, action),
          covenantReceiptPtr,
          // Mechanism (kind/action) only for aiko-authenticated callers.
          ...(aiko ? { kind: base, action } : {}),
          hint: "operator must run `bunx wrangler kv:namespace create <NS>` (and --preview), then paste the ids into backend/wrangler.toml.",
        },
        503,
      );
    }
    throw err;
  }

  if (!dispatch.ok) {
    return c.json(
      { ...dispatch.payload, covenantReceiptPtr, ...(aiko ? { kind: base, action } : {}) },
      dispatch.status,
    );
  }

  // ─── Fire-and-forget peer mirror (NEVER block the response) ────────────
  const ctx = safeExecutionCtx(c);
  const mirror = mirrorToCovenantLedger(c.env, {
    kind: base,
    action,
    params,
    witness: envelope.witness ?? DEFAULT_WITNESS[base],
    identity: `wallet:${walletPubkey}`,
    covenantReceiptPtr,
    sig: envelope.signature,
  });
  if (ctx) {
    ctx.waitUntil(mirror);
  } else {
    // No ExecutionContext (unit-test / inline). Don't await — keep the
    // response non-blocking; swallow any rejection so it never surfaces.
    void mirror.catch(() => {});
  }

  // Public response = OPAQUE: only the pointer-only, wallet-signed promise.
  // The covenant MECHANISM (kind/action) is gated behind the aiko-key (Mark 4:11).
  return c.json({
    ok: true,
    receiptId: dispatch.receiptId,
    covenantReceiptPtr,
    verify_ok: dispatch.verifyOk,
    idempotent: dispatch.idempotent,
    ...(aiko ? { kind: base, action } : {}),
  });
});

// ─── Which KV namespace a base/action maps to (for the 503 envelope) ───────
function bindingNameForBase(base: string, action: string): string {
  if (base === "build" && (action === "settings" || action === "settings_set")) return "SETTINGS_STATE";
  if (base === "actuate" && action === "session_park") return "SESSION_STATE";
  if (base === "observe" && action === "trace") return "TRACE_STATE";
  return "AUDIT_LOG";
}

// ─── Dispatchers — each builds the sibling's body, verifies, persists ──────

type DispatchOk = { ok: true; receiptId: string; verifyOk: boolean; idempotent: boolean };
type DispatchErr = { ok: false; status: 400 | 401 | 403 | 503; payload: Record<string, unknown> };
type DispatchResult = DispatchOk | DispatchErr;

/** actuate (value/breath acts) + build (declares) → audit.ts row. */
async function dispatchAudit(
  env: Env,
  base: string,
  action: string,
  params: Record<string, unknown>,
  walletPubkey: string,
  signature: string,
  scheme: string | undefined,
): Promise<DispatchResult> {
  // Determine the audit variant from the action.
  let variant: AuditVariant;
  let actType: string | undefined;
  if (base === "build") {
    variant = "breath-act";
    actType = BUILD_ACT_ACTIONS[action] ?? "build-skill";
  } else if (ACTUATE_VALUE_VARIANTS.has(action)) {
    variant = "fill";
  } else if (ACTUATE_HEADER_VARIANTS.has(action)) {
    variant = "header-inject";
  } else if (ACTUATE_PAYLOAD_VARIANTS.has(action)) {
    variant = "payload-field";
  } else {
    variant = "breath-act";
    actType = BREATH_ACT_ACTIONS[action] ?? "navigate";
  }

  const body: AuditFillBody = {
    pointer: pStr(params, "pointer") ?? "arg://breath/" + action,
    nonce: pStr(params, "nonce") ?? "",
    contextHash: pStr(params, "contextHash") ?? "",
    commitment: pStr(params, "commitment") ?? "",
    walletPubkey,
    signatureScheme: (scheme as AuditFillBody["signatureScheme"]) ?? "ed25519-v7.0",
    signature,
    variant,
    urlHash: pStr(params, "urlHash"),
    selectorHash: pStr(params, "selectorHash"),
    headerNameHash: pStr(params, "headerNameHash"),
    payloadPath: pStr(params, "payloadPath"),
    actType: actType as AuditFillBody["actType"],
  };

  const verifyOk = await verifyAuditSignature(body);
  const { idempotent } = await persistAuditRow(env, body, verifyOk);
  // receiptId from audit's deterministic derivation (same sha256 mechanism).
  const receiptId = await deriveAuditReceiptId(body);
  return { ok: true, receiptId, verifyOk, idempotent };
}

/** observe:<surface> → audit.ts eval-read row (readKind = action). */
async function dispatchEvalRead(
  env: Env,
  action: string,
  params: Record<string, unknown>,
  walletPubkey: string,
  signature: string,
  scheme: string | undefined,
): Promise<DispatchResult> {
  // The eval-read POST handler lives in routes/audit.ts; reuse its exported
  // internal validators/derivers (__evalReadInternal) so the schema + key
  // convention stay owned by the route, and write through the same KV
  // namespace with the audit eval-read key prefix.
  const body = {
    sessionId: pStr(params, "sessionId"),
    urlHash: pStr(params, "urlHash"),
    readKind: action,
    byteCount: typeof params.byteCount === "number" ? (params.byteCount as number) : 0,
    selectorHash: pStr(params, "selectorHash"),
    nonce: pStr(params, "nonce") ?? "",
    walletPubkey,
    signature,
    signatureScheme: (scheme as "ed25519-v7.0") ?? "ed25519-v7.0",
  };
  const validation = __evalReadInternal.validateEvalReadBody(body);
  if (validation) {
    return { ok: false, status: 400, payload: { error: "invalid_body", field: validation.field, reason: validation.reason } };
  }
  const kv = env.AUDIT_LOG;
  if (!kv) throw new AuditBindingMissing();
  const receiptId = await __evalReadInternal.deriveEvalReadReceiptId(body as never);
  const cacheKey = await __evalReadInternal.deriveEvalReadCacheKey(body.signature);
  const verifyOk = await __evalReadInternal.verifyEvalReadSignature(body as never);
  const wallet = walletPubkey;
  const stamp = (Number.MAX_SAFE_INTEGER - Date.now()).toString().padStart(16, "0");
  const primaryKey = `audit-eval-read:${wallet}:${stamp}:${receiptId}`;
  const pointerKey = `audit-eval-read:receipt:${receiptId}`;
  const existing = await kv.get(pointerKey);
  let idempotent = false;
  if (existing) {
    idempotent = true;
  } else {
    const row = JSON.stringify({ ...body, cacheKey, verify_ok: verifyOk, stored_at: Date.now(), kind: "eval-read" });
    await kv.put(pointerKey, row);
    await kv.put(primaryKey, row);
  }
  return { ok: true, receiptId, verifyOk, idempotent };
}

/** actuate:session_park → session-state.ts. */
async function dispatchSessionPark(
  env: Env,
  params: Record<string, unknown>,
  walletPubkey: string,
  signature: string,
  scheme: string | undefined,
): Promise<DispatchResult> {
  const body: SessionParkBody = {
    sessionId: pStr(params, "sessionId") ?? "",
    targetUrl: pStr(params, "targetUrl") ?? "",
    targetId: pStr(params, "targetId") ?? "",
    contextId: pStr(params, "contextId") ?? "",
    boundPointers: Array.isArray(params.boundPointers) ? (params.boundPointers as SessionParkBody["boundPointers"]) : [],
    capturedEndpointsHash: pStr(params, "capturedEndpointsHash") ?? "",
    specHitRef: pStr(params, "specHitRef"),
    cookiesInventoryRef: pStr(params, "cookiesInventoryRef"),
    walletPubkey,
    signatureScheme: (scheme as SessionParkBody["signatureScheme"]) ?? "ed25519-v7.2",
    signature,
    parked_at: typeof params.parked_at === "number" ? (params.parked_at as number) : Date.now(),
  };
  const verifyOk = await verifySessionParkSignature(body);
  if (!verifyOk) {
    return { ok: false, status: 401, payload: { error: "signature_invalid", reason: "Ed25519 verify failed against canonical signed-fragment" } };
  }
  const receiptId = await deriveSessionReceiptId(body);
  const { idempotent } = await persistParkedSession(env, body, verifyOk);
  return { ok: true, receiptId, verifyOk, idempotent };
}

/** observe:trace → trace-state.ts. */
async function dispatchTrace(
  env: Env,
  params: Record<string, unknown>,
  walletPubkey: string,
  signature: string,
  scheme: string | undefined,
): Promise<DispatchResult> {
  const body: TraceAppendBody = {
    walletPubkey,
    signatureScheme: (scheme as TraceAppendBody["signatureScheme"]) ?? "ed25519-v7.0",
    signature,
    nonce: pStr(params, "nonce") ?? "",
    sessionId: pStr(params, "sessionId") ?? "",
    domain: pStr(params, "domain") ?? "",
    traces: Array.isArray(params.traces) ? (params.traces as TraceAppendBody["traces"]) : [],
  };
  const verifyOk = await verifyTraceAppendSignature(body);
  if (!verifyOk) {
    return { ok: false, status: 401, payload: { error: "signature_invalid", reason: "Ed25519 verify failed against canonical signed-fragment" } };
  }
  const cacheKey = await deriveTraceCacheKeyHex(body.signature);
  const { idempotent } = await persistTraceRow(env, body, verifyOk);
  return { ok: true, receiptId: cacheKey, verifyOk, idempotent };
}

/** build:settings → settings-state.ts. */
async function dispatchSettings(
  env: Env,
  params: Record<string, unknown>,
  walletPubkey: string,
  signature: string,
  scheme: string | undefined,
): Promise<DispatchResult> {
  const body: SettingsSetBody = {
    walletPubkey,
    signatureScheme: (scheme as SettingsSetBody["signatureScheme"]) ?? "ed25519-v7.0",
    signature,
    nonce: pStr(params, "nonce") ?? "",
    settingKey: pStr(params, "settingKey") ?? "",
    settingValuePointer: pStr(params, "settingValuePointer") ?? "",
  };
  const verifyOk = await verifySettingsSetSignature(body);
  if (!verifyOk) {
    return { ok: false, status: 401, payload: { error: "signature_invalid", reason: "Ed25519 verify failed against canonical signed-fragment" } };
  }
  const cacheKey = await deriveSettingsCacheKeyHex(body.signature);
  const { idempotent } = await persistSettingsRow(env, body, verifyOk);
  return { ok: true, receiptId: cacheKey, verifyOk, idempotent };
}

// Re-export helpers for tests (the cross-wallet + identity-parse logic).
export const __covenantInternal = {
  identityToPubkeyHex,
  splitKind,
  DEFAULT_WITNESS,
};
