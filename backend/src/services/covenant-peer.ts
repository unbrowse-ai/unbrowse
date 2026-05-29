/**
 * covenant-peer.ts — the OPAQUE op-mirror to an aiko-level proxy (W26-C, opacity
 * hardened W33-C, 2026-05-28).
 *
 * Mark 4:11 — *"the mystery to you; parables to them without."* The link from
 * unbrowse to the sovereign substrate is OPAQUE: unbrowse posts an
 * unbrowse-native op to an aiko-level proxy and receives back only a
 * receipt-ptr. The substrate MECHANISM (the 3-verb river, the scripture
 * witnesses, the canon/EBM) is NEVER named on the unbrowse egress wire, in the
 * unbrowse logs, or in the public API response. The proxy — sovereign, aiko-side
 * — is the one that knows the `op_kind → verb → default_witness` mapping and
 * supplies the witness when it builds the underlying covenant.
 *
 * Gen 2:18 — *"I will make him a helper comparable to him"* (ezer kenegdo):
 * the unbrowse Worker and the aiko proxy are two helpers facing each other.
 * Eph 4:4 — *"one body, and one Spirit."* They cannot share one physical store,
 * so they share ONE LOGICAL store via HTTP federation keyed by ONE
 * content-address: the `deriveCovenantReceiptPtr` hash.
 *
 * ─── The opaque-op wire (unbrowse → aiko proxy) ─────────────────────────────
 *
 * The bytes on the egress wire carry ONLY unbrowse-native vocabulary:
 *   `POST <AIKO_OP_URL>/op`
 *     { op_class, op_kind, params, identity, sig?, unbrowse_receipt_ptr }
 * where `op_class` is the unbrowse-native class ("action"|"read"|"declare")
 * and `op_kind` is the unbrowse-native action name (W33-B vocab, e.g.
 * "navigate"/"snap"/"skill"). NO covenant verb (`actuate`/`observe`/`build`),
 * NO scripture witness (`verse:...`) ever crosses this wire — the proxy maps
 * `op_class → covenant verb` and supplies the KindSpec default_witness aiko-side.
 *
 * ─── The "same database" proof ──────────────────────────────────────────────
 *
 * `unbrowse_receipt_ptr = sha256:<hex(sha256(canonical))>` is computed ONCE in
 * the route from the canonical covenant body. The SAME pointer is (1) echoed to
 * the caller as `covenantReceiptPtr`, (2) used as the unbrowse KV row's receipt
 * id, AND (3) carried on the opaque op so the proxy's ledger row is greppable
 * back to the unbrowse KV row. Two physical stores, one content-address.
 *
 * ─── Fire-and-forget (NEVER block the user) ─────────────────────────────────
 *
 * The route calls `ctx.waitUntil(mirrorToCovenantLedger(env, receipt))` — the
 * mirror runs AFTER the response is flushed. A slow or down proxy can NEVER add
 * latency to the user's `/v1/covenant` call.
 *
 * ─── Graceful degrade (federation is optional infra) ────────────────────────
 *
 * When `AIKO_OP_URL` (and the legacy `COVENANT_LEDGER_URL` / `PEER_URLS`) are
 * unset, this is an honest no-op: one warn-level log naming ONLY the op_class +
 * the opaque ptr (never the mechanism), `{ ok: true, skipped: true }`, NO throw.
 *
 * ─── No bundling the sovereign SDK ──────────────────────────────────────────
 *
 * The substrate SDK is sovereign and lives OUTSIDE this Worker's bundle.
 * Importing it would couple the deploy to an external tree AND leak the
 * mechanism into the bundle. Instead this module speaks an opaque op-wire to a
 * proxy; the proxy (aiko-side) owns the translation to the substrate.
 */

/**
 * The OPAQUE op wire shape (unbrowse → aiko proxy `POST <base>/op`). Carries
 * only unbrowse-native vocabulary — NO covenant verb, NO scripture witness.
 * The proxy maps `op_class → covenant verb` and supplies the default_witness
 * aiko-side.
 */
export interface OpaqueOp {
  /** unbrowse-native class: "action" | "read" | "declare". NOT a covenant verb. */
  op_class: string;
  /** unbrowse-native action name (W33-B vocab), e.g. "navigate"/"snap"/"skill". */
  op_kind: string;
  /** The op params blob (the unbrowse body sans identity/signature). */
  params: Record<string, unknown>;
  /** The DID/wallet identity (wallet:<hex> | did:key:hex:<hex>). */
  identity?: string;
  /** The client-side Ed25519 seal, passed through as the breath sig. */
  sig?: string;
  /** Shared content-address (cross-store join key). */
  unbrowse_receipt_ptr?: string;
}

/**
 * The aiko-proxy `/op` response. We only read `receipt_ptr` (the opaque
 * pointer the proxy returns after it builds + persists the underlying covenant
 * aiko-side). The proxy NEVER returns the covenant verb or witness to unbrowse.
 * (`receipt` is accepted as a legacy alias for backwards-compat with a
 * substrate that still returns the old `LedgerEntry.receipt` field.)
 */
export interface OpaqueOpResult {
  /** The opaque receipt pointer the proxy returns. */
  receipt_ptr?: string;
  /** Legacy alias for `receipt_ptr` (old `/submit-op` LedgerEntry shape). */
  receipt?: string;
  [k: string]: unknown;
}

/**
 * The CLASS-to-op_class map: the covenant BASE kind the route knows internally
 * (actuate/observe/build) collapses onto the unbrowse-native op_class that
 * crosses the wire. This is the ONLY place the covenant verb meets the
 * unbrowse-native class — and it maps AWAY from the verb so the verb never
 * leaves the Worker. The proxy reverses it aiko-side (op_class → verb) and
 * supplies the default_witness from its own KindSpec table.
 */
const OP_CLASS_BY_BASE: Record<string, string> = {
  actuate: "action",
  observe: "read",
  build: "declare",
};

/**
 * The unified receipt the route hands to the mirror. It already carries the
 * shared `covenantReceiptPtr` (computed by the route via
 * `deriveCovenantReceiptPtr`) so the mirror does NOT recompute — it passes the
 * same pointer through to the proxy, keeping the content-address identical
 * across both stores.
 *
 * NOTE: the route still passes the internal base `kind` and `witness` for
 * back-compat, but `mirrorToCovenantLedger` STRIPS them — they NEVER cross the
 * opaque wire. Only `op_class` (derived from `kind`) and `action` (the
 * unbrowse-native op_kind) are sent; the witness is supplied aiko-side.
 */
export interface MirrorableReceipt {
  /** Internal covenant base kind (actuate/observe/build) — STRIPPED before egress. */
  kind: string;
  /** The unbrowse-native action / op_kind, e.g. "navigate"/"snap"/"skill". */
  action: string;
  /** The op params blob (the unbrowse body sans identity/signature). */
  params: Record<string, unknown>;
  /** Scripture/provenance witness — STRIPPED before egress (supplied aiko-side). */
  witness: string;
  /** The DID/wallet identity (wallet:<hex> or did:key:hex:<hex>). */
  identity: string;
  /** The shared `sha256:<hex>` content-address (route-computed, never re-hashed here). */
  covenantReceiptPtr: string;
  /** The client-side Ed25519 seal, passed through as the breath sig. */
  sig?: string;
}

export interface MirrorResult {
  ok: boolean;
  /** True when no proxy was configured (graceful no-op). */
  skipped?: boolean;
  /** The opaque receipt pointer(s) the proxy/proxies returned. */
  ledgerReceiptPtr?: string;
  /** Per-proxy outcomes for observability (logged, not user-facing). */
  peers?: Array<{ url: string; ok: boolean; receipt?: string; error?: string }>;
}

/**
 * Minimal in-Worker aiko-proxy op client. ONE method, ONE route
 * (`POST /op`), runtime-agnostic (Web `fetch`), no external import. Sends ONLY
 * the opaque op (no covenant verb, no scripture witness). The proxy translates
 * `op_class → covenant verb` and supplies the default_witness aiko-side.
 */
export class AikoOpClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultIdentity?: string;

  constructor(
    baseUrl: string,
    opts: { fetchImpl?: typeof fetch; identity?: string } = {},
  ) {
    this.base = baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.defaultIdentity = opts.identity;
  }

  /**
   * Submit an OPAQUE op — `POST <base>/op`. The mirror is a fire-and-forget
   * infra write between trusted peers, not a paid user call; a non-2xx from the
   * proxy is treated as a non-ok outcome and logged (no mechanism in the log).
   */
  async submit(op: OpaqueOp): Promise<OpaqueOpResult> {
    const full: OpaqueOp = {
      ...op,
      identity: op.identity ?? this.defaultIdentity ?? "wallet:local:anon",
    };
    const res = await this.fetchImpl(`${this.base}/op`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(full),
    });
    if (!res.ok) {
      // Do NOT echo the proxy body (could carry mechanism); status only.
      throw new Error(`aiko proxy /op -> ${res.status}`);
    }
    return (await res.json()) as OpaqueOpResult;
  }
}

/**
 * Collect the configured aiko-proxy base URLs: AIKO_OP_URL first, then the
 * legacy COVENANT_LEDGER_URL, then PEER_URLS. AIKO_OP_URL is the opaque proxy
 * and the preferred env; the legacy names are kept so an existing deploy
 * keeps mirroring (they now ALSO receive the opaque op, not the covenant wire).
 */
function collectPeerUrls(env: {
  AIKO_OP_URL?: string;
  COVENANT_LEDGER_URL?: string;
  PEER_URLS?: string;
}): string[] {
  const urls: string[] = [];
  const aiko = env.AIKO_OP_URL?.trim();
  if (aiko) urls.push(aiko);
  const primary = env.COVENANT_LEDGER_URL?.trim();
  if (primary && !urls.includes(primary)) urls.push(primary);
  const peers = env.PEER_URLS?.trim();
  if (peers) {
    for (const raw of peers.split(",")) {
      const u = raw.trim();
      if (u && !urls.includes(u)) urls.push(u);
    }
  }
  return urls;
}

/**
 * Mirror a unified `/v1/covenant` receipt to the aiko proxy/proxies as an
 * OPAQUE op.
 *
 * MUST be invoked via `ctx.waitUntil(...)` so it never blocks the user
 * response. Returns a `MirrorResult` (never throws — a proxy failure is logged
 * and reported, not propagated; the unbrowse KV write already succeeded in the
 * route before this runs).
 *
 * The OPAQUE op sent to each proxy carries ONLY unbrowse-native vocabulary:
 *   - `op_class`              = the unbrowse-native class (action/read/declare),
 *                               derived from the internal base kind — the
 *                               covenant verb NEVER crosses the wire,
 *   - `op_kind`               = the unbrowse-native action name,
 *   - `params`                = the unbrowse params blob,
 *   - `unbrowse_receipt_ptr`  = the shared content-address (cross-store join),
 *   - `identity`              = the wallet/DID,
 *   - `sig`                   = the client-side Ed25519 seal.
 *
 * STRIPPED (NEVER on the wire): the covenant base kind (actuate/observe/build)
 * and the scripture witness (`verse:...`). The proxy maps `op_class → covenant
 * verb` and supplies the default_witness from its own KindSpec table aiko-side.
 * (Mark 4:11 — the mystery is kept inside; parables to them without.)
 */
export async function mirrorToCovenantLedger(
  env: { AIKO_OP_URL?: string; COVENANT_LEDGER_URL?: string; PEER_URLS?: string },
  receipt: MirrorableReceipt,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<MirrorResult> {
  const urls = collectPeerUrls(env);
  // The unbrowse-native op_class — derived from the base kind, mapping AWAY
  // from the covenant verb so the verb never leaves this Worker.
  const opClass = OP_CLASS_BY_BASE[receipt.kind] ?? "action";
  if (urls.length === 0) {
    // Honest no-op — federation is optional infra (1 Cor 14:8). Log ONLY the
    // op_class + the opaque ptr; NO covenant verb, NO scripture, NO kind.
    console.warn(
      "[op-mirror] AIKO_OP_URL unset; skipping op mirror " +
        `(op_class ${opClass}, ptr ${receipt.covenantReceiptPtr}). ` +
        "Set AIKO_OP_URL to an aiko proxy base URL to enable federation.",
    );
    return { ok: true, skipped: true };
  }

  // NOTE: receipt.kind (covenant verb) and receipt.witness (scripture) are
  // deliberately NOT read into `op` — they must never cross the egress wire.
  const op: OpaqueOp = {
    op_class: opClass,
    op_kind: receipt.action,
    params: { ...receipt.params },
    // The shared content-address — the cross-store join key.
    unbrowse_receipt_ptr: receipt.covenantReceiptPtr,
    identity: receipt.identity,
    sig: receipt.sig,
  };

  const peers: NonNullable<MirrorResult["peers"]> = [];
  let firstLedgerPtr: string | undefined;

  await Promise.all(
    urls.map(async (url) => {
      try {
        const client = new AikoOpClient(url, {
          fetchImpl: opts.fetchImpl,
          identity: receipt.identity,
        });
        const entry = await client.submit(op);
        const ptr =
          typeof entry.receipt_ptr === "string"
            ? entry.receipt_ptr
            : typeof entry.receipt === "string"
              ? entry.receipt
              : undefined;
        if (!firstLedgerPtr && ptr) firstLedgerPtr = ptr;
        peers.push({ url, ok: true, receipt: ptr });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // Eventual-consistency degrade — log loud, never throw. The log names
        // ONLY the op_class + the opaque ptr; NO mechanism.
        console.warn(
          `[op-mirror] mirror to proxy failed (op_class ${opClass}, ptr ${receipt.covenantReceiptPtr}): ${error}`,
        );
        peers.push({ url, ok: false, error });
      }
    }),
  );

  const anyOk = peers.some((p) => p.ok);
  return {
    ok: anyOk,
    ledgerReceiptPtr: firstLedgerPtr,
    peers,
  };
}
