/**
 * Local thin client over the cloud /v1/contract/* harness — stage B of
 * organ ddff0c96. Holds NO decision logic. Just dumb HTTP I/O + a
 * dispatcher that invokes the local capability registry when a cloud
 * response names one.
 *
 * The MCP server and the CLI both wrap this client (one transport
 * each — stdio MCP and argv CLI). The tool surface they expose to
 * their respective agents is itself cloud-advertised: the local has
 * no hardcoded list of "tools"; it asks /v1/contract/plan-for-intent
 * with the agent's intent and exposes whatever the cloud surfaces.
 *
 * Cf. contract:50d0419e (pointers over payload) — every value this
 * client returns is reachable from a cloud row; the client carries
 * none of it inline.
 */

import type { LocalCapabilityDispatcher } from "./local-capabilities";
import { canonicalizeViaWasm, signViaWasm } from "./core-wasm";

// ---------------------------------------------------------------------------
// Wire shapes — mirror backend/src/routes/contract.ts request/response.
// Any drift between this file and the cloud route is a fake-witness
// violation; consumers should be written against ONE canonical shape.
// Keep these two files in sync via the same isomorphism rule as the
// three EndpointDescriptor mirrors.
// ---------------------------------------------------------------------------

export interface ThinClientDeclareRequest {
  plan: string;
  action: string;
  parent_id?: string;
  learning?: string;
  /** Writer identity claimed for this declare. When a wallet is present
   *  this is the signed `agent` field; absent → null in the canonical body. */
  agent?: string;
}

/**
 * The unbrowse wallet signer surface this client needs to bind a declare to
 * the same one-key-signs-every-layer identity the rest of the CLI uses
 * (src/values/signer.ts). Injectable so tests can point at a hermetic wallet
 * (UNBROWSE_WALLET_DIR) or supply a stub; defaults to the real signer.
 */
export interface ThinClientSigner {
  getWalletPubkey(): Promise<Uint8Array>;
  signBytes(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  /**
   * Optional: run `fn` with the raw 64-byte Ed25519 SecretKey (seed||pubkey)
   * loaded transiently (zeroed after). Present on the real unbrowse signer so
   * the declare can route SIGN through the one Zig WASM core; absent on test
   * stubs, in which case signing stays on `signBytes`. Never retain the buffer.
   */
  withSecretKey?<T>(fn: (sk64: Uint8Array) => T): T;
}

export interface ThinClientIterateRequest {
  id: string;
  /** Filled by the dispatcher after invoking a local capability. */
  local_result?: {
    capability: string;
    success: boolean;
    body?: unknown;
    error?: string;
  };
}

export interface ThinClientIterateStep {
  step_id: string;
  description: string;
  required_local_capabilities: string[];
  cloud_payload?: unknown;
  result?: unknown;
}

export interface ThinClientIterateResponse {
  id: string;
  wave: number;
  action_result: string;
  pending_local_steps: ThinClientIterateStep[];
  key2_prompt: string;
}

export interface ThinClientStatusResponse {
  id: string;
  status: "pending" | "active" | "satisfied" | "merged";
  rows: Array<Record<string, unknown>>;
}

export interface ThinClientPlanMatch {
  id: string;
  plan: string;
  score: number;
  why: string;
}

export interface ThinClientContractSurface {
  paper: string;
  claim: string;
  node_shape: {
    subject: string;
    verb: "act";
    witness: string;
    parent: string;
  };
  layers: string[];
  cli_bridge: {
    tool: "unbrowse contract surface";
    exposes: "holes-only";
    canonical_verbs: Array<"create" | "act" | "read">;
    holes: Array<{
      name: string;
      kind: "intent" | "auth" | "approval" | "capability" | "pointer";
      fill: "llm" | "wallet" | "human" | "local-dispatcher" | "server-pointer";
      exposed_to: "client";
      carries_secret: false;
    }>;
    legacy_aliases?: Array<{
      legacy: string;
      canonical: string;
      reason: "backward-compatibility";
    }>;
    commands_source?: string;
  };
  compatibility: {
    result_contract: {
      name: "CapabilityResult";
      minimum_fields: string[];
      optional_extensions: string[];
      statuses: string[];
      sources: string[];
      invariant: "backward-compatible-minimum-shape";
    };
    fallback_hierarchy: Array<{
      rank: number;
      source: string;
      returns: "CapabilityResult";
      fallback_on: string[];
    }>;
    standards: string[];
    indexer_contribution: {
      format: "capability-knowledge-row";
      candidate_fields: string[];
      promotion_targets: string[];
      compiles_to: "CapabilityResult";
    };
  };
  roles: Array<{
    role: "server" | "client" | "cli" | "aiko";
    owns: string[];
    exposes: string[];
    hides: string[];
  }>;
  aiko_inverse: {
    repo: string;
    mapping: "1:-1";
    public_descriptor: string;
    private_runtime: string;
  };
}

// ---------------------------------------------------------------------------
// Factory + dumb I/O surface.
// ---------------------------------------------------------------------------

export interface ThinClientOptions {
  /** Base URL of the cloud Worker. The CLAUDE.md backend convention is
   *  beta-api.unbrowse.ai; override with UNBROWSE_API_URL. */
  baseUrl?: string;
  /** Optional API key for authenticated routes. */
  apiKey?: string;
  /** Optional local capability dispatcher. When present, iterate()
   *  auto-executes pending_local_steps and recursively re-iterates
   *  until pending_local_steps is empty or a capability fails. */
  dispatcher?: LocalCapabilityDispatcher;
  /** Optional fetch implementation (testing). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Optional wallet signer (testing). Defaults to the unbrowse signer
   *  (src/values/signer.ts) loaded lazily so offline use never needs a key. */
  signer?: ThinClientSigner;
}

export interface ThinClient {
  declare(req: ThinClientDeclareRequest): Promise<{ id: string }>;
  iterate(req: ThinClientIterateRequest): Promise<ThinClientIterateResponse>;
  status(id: string): Promise<ThinClientStatusResponse>;
  planForIntent(intent: string, limit?: number): Promise<ThinClientPlanMatch[]>;
  surface(): Promise<ThinClientContractSurface>;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Pure-TS canonical declare body — the FALLBACK. PREFER the Zig WASM core
 * (`canonicalizeViaWasm` in ./core-wasm) which is the ONE canonical
 * implementation shared with the backend's verifier; this TS path runs only
 * when the wasm can't load (unsupported runtime, missing/corrupt module).
 *
 * The backend emits keys in this fixed object-literal order (plan, action,
 * parent_id, agent, wallet_identity, ts) — NOT a runtime sort — and uses
 * `null` (never undefined / omitted) for an absent parent_id or agent. The Zig
 * core re-serializes in this same order, so all three (CLI WASM, CLI TS,
 * backend) emit byte-identical bytes — the invariant that makes a CLI-signed
 * declare verify on the backend.
 */
function canonicalizeDeclareBodyTs(body: {
  plan: string;
  action: string;
  parent_id: string | null;
  agent: string | null;
  wallet_identity: string;
  ts: string;
}): string {
  return JSON.stringify({
    plan: body.plan,
    action: body.action,
    parent_id: body.parent_id,
    agent: body.agent,
    wallet_identity: body.wallet_identity,
    ts: body.ts,
  });
}

/**
 * Canonicalize the declare body through the SINGLE Zig WASM core, falling back
 * to the pure-TS emitter on any wasm fault. This kills the CLI's OWN duplicate
 * byte-emitter as the load-bearing path: the bytes the CLI signs now come from
 * the same core the backend canonicalizes/verifies with.
 */
function canonicalizeDeclareBody(body: {
  plan: string;
  action: string;
  parent_id: string | null;
  agent: string | null;
  wallet_identity: string;
  ts: string;
}): string {
  return canonicalizeViaWasm(body) ?? canonicalizeDeclareBodyTs(body);
}

/**
 * Lazily load the real unbrowse signer (src/values/signer.ts) so the thin
 * client never imports keychain machinery unless an opts.signer override is
 * absent AND a declare actually needs to sign. Returns null when the signer
 * module can't be loaded — the declare path then stays unsigned (offline-safe).
 */
async function defaultSigner(): Promise<ThinClientSigner | null> {
  try {
    const mod = await import("../values/signer.js");
    return {
      getWalletPubkey: mod.getWalletPubkey,
      signBytes: mod.signBytes,
      withSecretKey: mod.withSecretKey,
    };
  } catch {
    return null;
  }
}

/**
 * Build a thin client bound to a specific cloud Worker. The returned
 * object holds NO state beyond config — every call hits the cloud.
 * That's the point: state lives in the cloud ledger.
 */
export function createThinClient(opts: ThinClientOptions = {}): ThinClient {
  const baseUrl = (opts.baseUrl ?? "https://beta-api.unbrowse.ai").replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const dispatcher = opts.dispatcher;

  async function call<TReq, TRes>(
    path: string,
    method: "GET" | "POST",
    body?: TReq,
    queryParams?: Record<string, string>,
  ): Promise<TRes> {
    const url = new URL(`${baseUrl}${path}`);
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, v);
    }
    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetchImpl(url.toString(), init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${path} ${res.status}: ${text || res.statusText}`);
    }
    return (await res.json()) as TRes;
  }

  return {
    async declare(req) {
      // Bind the declare to the unbrowse wallet identity (one-key-signs-
      // every-layer). Mirror src/cli-v7/eval/resolve.ts:128 — pubkey →
      // hex(wallet_identity), sign the canonical body, attach both. The
      // backend's verifyDeclareSignature (declare-signature.ts) verifies
      // Ed25519 over the EXACT canonical bytes built here.
      //
      // Backward-compat: if no wallet is configured / the signer is
      // unavailable (getWalletPubkey throws, keychain absent, offline),
      // fall back to the current UNSIGNED POST so offline use never breaks.
      let signedExtras:
        | { wallet_identity: string; declare_signature: string; ts: string; agent: string | null }
        | undefined;
      try {
        const signer = opts.signer ?? (await defaultSigner());
        if (signer) {
          const pubkeyBytes = await signer.getWalletPubkey();
          const wallet_identity = bytesToHex(pubkeyBytes);
          // ts is part of the signed body AND must be echoed in the request,
          // or the server defaults to its own clock and the sig won't verify
          // (backend contract.ts verifyDeclareAuth reads req.ts).
          const ts = new Date().toISOString();
          const parent_id = req.parent_id ?? null;
          const agent = req.agent ?? null;
          const canonical = canonicalizeDeclareBody({
            plan: req.plan,
            action: req.action,
            parent_id,
            agent,
            wallet_identity,
            ts,
          });
          const canonicalBytes = new TextEncoder().encode(canonical);
          // SIGN through the ONE Zig WASM core when the signer can expose the
          // raw 64-byte SecretKey in-process (real unbrowse signer). The secret
          // is loaded transiently inside withSecretKey and zeroed on return —
          // it never leaves that scope. On ANY wasm fault (signViaWasm → null)
          // OR a signer without withSecretKey (test stub) we fall back to the
          // node:crypto signer.signBytes, so signing NEVER breaks. Ed25519 is
          // RFC-8032 — both signatures verify identically on the backend.
          let declare_signature: string | null = null;
          if (typeof signer.withSecretKey === "function") {
            declare_signature = signer.withSecretKey((sk64) =>
              signViaWasm(canonicalBytes, sk64),
            );
          }
          if (declare_signature === null) {
            const signed = await signer.signBytes(canonicalBytes);
            declare_signature = bytesToHex(signed.signature);
          }
          signedExtras = {
            wallet_identity,
            declare_signature,
            ts,
            agent,
          };
        }
      } catch {
        // No usable wallet → stay on the unsigned legacy path.
        signedExtras = undefined;
      }

      const wireBody = signedExtras
        ? {
            plan: req.plan,
            action: req.action,
            ...(req.parent_id !== undefined ? { parent_id: req.parent_id } : {}),
            ...(req.learning !== undefined ? { learning: req.learning } : {}),
            ...(signedExtras.agent !== null ? { agent: signedExtras.agent } : {}),
            wallet_identity: signedExtras.wallet_identity,
            declare_signature: signedExtras.declare_signature,
            ts: signedExtras.ts,
          }
        : req;

      const result = await call<unknown, { id: string }>(
        "/v1/contract/declare",
        "POST",
        wireBody,
      );
      return { id: result.id };
    },

    async iterate(req) {
      let response = await call<ThinClientIterateRequest, ThinClientIterateResponse>(
        "/v1/contract/iterate",
        "POST",
        req,
      );

      // Required_local_capabilities dispatch loop. If the dispatcher
      // is wired, every cloud-named local capability gets executed
      // and the result is posted back via /v1/contract/iterate until
      // pending_local_steps is empty or a capability cannot be run.
      while (dispatcher && response.pending_local_steps.length > 0) {
        const step = response.pending_local_steps[0]!;
        const cap = step.required_local_capabilities[0];
        if (!cap) break;
        try {
          const local = await dispatcher.invoke(cap, step.cloud_payload);
          response = await call<ThinClientIterateRequest, ThinClientIterateResponse>(
            "/v1/contract/iterate",
            "POST",
            { id: req.id, local_result: { capability: cap, success: true, body: local } },
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          response = await call<ThinClientIterateRequest, ThinClientIterateResponse>(
            "/v1/contract/iterate",
            "POST",
            { id: req.id, local_result: { capability: cap, success: false, error: msg } },
          );
          break; // capability failed — surface to caller
        }
      }

      return response;
    },

    async status(id) {
      return call<never, ThinClientStatusResponse>(
        "/v1/contract/status",
        "GET",
        undefined,
        { id },
      );
    },

    async planForIntent(intent, limit) {
      const result = await call<{ intent: string; limit?: number }, { matches: ThinClientPlanMatch[] }>(
        "/v1/contract/plan-for-intent",
        "POST",
        { intent, ...(limit !== undefined ? { limit } : {}) },
      );
      return result.matches;
    },

    async surface() {
      return call<never, ThinClientContractSurface>(
        "/v1/contract/surface",
        "GET",
      );
    },
  };
}
