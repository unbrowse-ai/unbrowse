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
}

export interface ThinClient {
  declare(req: ThinClientDeclareRequest): Promise<{ id: string }>;
  iterate(req: ThinClientIterateRequest): Promise<ThinClientIterateResponse>;
  status(id: string): Promise<ThinClientStatusResponse>;
  planForIntent(intent: string, limit?: number): Promise<ThinClientPlanMatch[]>;
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
      const result = await call<ThinClientDeclareRequest, { id: string }>(
        "/v1/contract/declare",
        "POST",
        req,
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
  };
}
