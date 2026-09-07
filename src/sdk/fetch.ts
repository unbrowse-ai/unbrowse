/**
 * A drop-in replacement for the global `fetch`, with optional, opt-in payment.
 *
 * Default behaviour is identical to native fetch — zero config, zero
 * dependencies, no API key:
 *
 *   import { unfetch } from "@unbrowse/client";
 *   const res = await unfetch("https://example.com");   // just works
 *
 * Opt-in payment: pass a `pay` handler to transparently satisfy an HTTP 402
 * response. The handler is where any payment mechanism lives — a subscription /
 * credit balance, an embedded-wallet signer, or an on-chain micropayment — and
 * it is *injected*, never imported, so this module stays dependency-free. When
 * no handler is configured a 402 is returned to the caller unchanged, exactly
 * like native fetch.
 *
 * In other words: paying is a capability this client can use, not a path it
 * forces. The 402 mechanism is an implementation detail behind the handler, not
 * the front door.
 */

/** The standard fetch signature, re-exported as a type for handler authors. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Context handed to a {@link PayHandler} when a request comes back `402 Payment
 * Required`. The handler inspects it and decides whether (and how) to pay.
 */
export interface PaymentRequired {
  /** The 402 response, unconsumed — read `.clone()` if you need the body. */
  readonly response: Response;
  /** The original request that triggered the 402, for re-issue after payment. */
  readonly request: { input: string | URL | Request; init?: RequestInit };
  /**
   * Parsed payment terms when the server advertises them. We surface the common
   * shapes (an `accepts` array, or `x402`/`flex` envelopes) without prescribing
   * one — the handler owns the protocol. `null` when the body is not JSON.
   */
  readonly terms: Record<string, unknown> | null;
}

/**
 * Resolves a 402. Return the headers to merge into a single retry of the
 * original request (e.g. `{ "X-PAYMENT": "..." }` or an `Authorization` token),
 * or `null` to decline — in which case the original 402 is returned unchanged.
 */
export type PayHandler = (ctx: PaymentRequired) => Promise<HeadersInit | null>;

export interface CreateFetchOptions {
  /** The transport to wrap. Defaults to the platform `fetch`. */
  fetch?: FetchLike;
  /**
   * Optional payment handler. When omitted, the returned fetch is a pure
   * pass-through and a 402 is never intercepted.
   */
  pay?: PayHandler;
}

/**
 * Build a `fetch`-shaped function. With no options it is the platform fetch.
 * With a `pay` handler it transparently retries a single 402 once the handler
 * supplies payment headers.
 *
 * For agent / SDK usage we also support an optional `recoverChallenge` hook.
 * When a response looks like a JS/anti-bot challenge (Cloudflare, PerimeterX, etc.)
 * the hook can return patched headers/cookies (or a solved body) and we retry once.
 * This lets thin-SDK users benefit from the same solvers the CLI uses without
 * forcing a full `unbrowse setup` or browser engine.
 *
 * If you pass `recoverChallenge: true` (boolean), we will try to auto-wire the
 * built-in challenge solvers (cf/px/akamai/kasada via bundle-replay) for you.
 */
export interface ChallengeRecovery {
  /** Return extra headers (e.g. cookies or custom) to merge for a retry, or null to give up. */
  (ctx: { response: Response; request: { input: string | URL | Request; init?: RequestInit } }): Promise<HeadersInit | null>;
}

export interface CreateFetchOptions {
  /** The transport to wrap. Defaults to the platform `fetch`. */
  fetch?: FetchLike;
  /**
   * Optional payment handler. When omitted, the returned fetch is a pure
   * pass-through and a 402 is never intercepted.
   */
  pay?: PayHandler;
  /**
   * Optional challenge recovery for anti-bot pages (CF JS challenge, PX, Akamai, Kasada...).
   * - Pass a function for full control.
   * - Pass `true` to auto-enable the built-in solvers (best effort, no browser required).
   */
  recoverChallenge?: ChallengeRecovery | true;
}

export function createFetch(options: CreateFetchOptions = {}): FetchLike {
  const base: FetchLike | undefined = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof base !== "function") {
    throw new Error(
      "No fetch implementation available. Pass `fetch` in options or run on Node 18+ / a modern browser.",
    );
  }
  const transport = base.bind(globalThis);
  const pay = options.pay;

  // Resolve the challenge recovery strategy.
  let recoverChallenge: ChallengeRecovery | undefined;
  if (options.recoverChallenge === true) {
    // Auto-wire the existing challenge solvers (cf/px/akamai/kasada).
    // This is the key improvement for SDK users: they get the same anti-bot
    // bypass the CLI has, without the heavy `unbrowse setup` / browser path.
    recoverChallenge = createAutoChallengeRecovery();
  } else if (typeof options.recoverChallenge === "function") {
    recoverChallenge = options.recoverChallenge;
  }

  // Pure pass-through when nothing is wired.
  if (!pay && !recoverChallenge) return transport;

  return async function unbrowseFetch(input, init): Promise<Response> {
    let res = await transport(input, init);

    // 402 payment path (existing behaviour)
    if (res.status === 402 && pay) {
      const terms = await readJsonSafe(res.clone());
      const extra = await pay({ response: res, request: { input, init }, terms });
      if (extra) {
        const headers = new Headers(init?.headers);
        new Headers(extra).forEach((value, key) => headers.set(key, value));
        res = await transport(input, { ...init, headers });
      }
      return res;
    }

    // Challenge recovery path (SDK/agent users hitting CF/PX/etc. get help here)
    if (recoverChallenge && isLikelyChallengeResponse(res)) {
      const extra = await recoverChallenge({ response: res, request: { input, init } });
      if (extra) {
        const headers = new Headers(init?.headers);
        new Headers(extra).forEach((value, key) => headers.set(key, value));
        // One retry with recovered cookies/headers
        res = await transport(input, { ...init, headers });
      }
    }

    return res;
  };
}

/** Heuristic: looks like a JS challenge / anti-bot interstitial we can try to recover from. */
function isLikelyChallengeResponse(res: Response): boolean {
  if (res.status !== 403 && res.status !== 429 && res.status !== 503) return false;
  const ct = res.headers.get("content-type") || "";
  return /html|javascript|text/i.test(ct) || true;
}

/**
 * Best-effort challenge recovery using the existing solver bridge. The bridge
 * may require Kuri/Chromium and may return no recovery headers.
 */
function createAutoChallengeRecovery(): ChallengeRecovery {
  return async (ctx) => {
    try {
      // Lazy import so the thin SDK does not pull the whole execution tree at load time.
      const solverModule = import.meta.url.includes("/packages/skill/")
        ? "../../../../src/orchestrator/challenge-solver-bridge.js"
        : "../orchestrator/challenge-solver-bridge.js";
      const mod = await import(solverModule);
      const { tryChallengeSolver } = mod as { tryChallengeSolver: (p: any) => Promise<any> };

      // We only have the response here. Re-fetch the body for the solver (cheap for challenge pages).
      const url = typeof ctx.request.input === "string" ? ctx.request.input : String(ctx.request.input);
      const respForSolver = await fetch(url, { method: "GET", redirect: "follow" });
      if (respForSolver.status < 400) return null;

      const body = await respForSolver.text();
      const headers: Record<string, string | string[] | undefined> = {};
      respForSolver.headers.forEach((v, k) => { headers[k] = v; });

      const solved = await tryChallengeSolver({
        url,
        body,
        status: respForSolver.status,
        headers,
      });

      if (solved && solved.cookies && solved.cookies.length > 0) {
        // Return a Cookie header that the caller can merge.
        const cookieHeader = solved.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
        return { "Cookie": cookieHeader };
      }
      return null;
    } catch {
      // Best effort only. If solvers are not available we silently fall back.
      return null;
    }
  };
}

/**
 * The keyless, dependency-free default: a `fetch` drop-in with no payment
 * handler. Identical to the platform fetch; exported so callers can swap
 * `fetch` → `unfetch` with no behavioural change and wire payment later.
 */
export const unfetch: FetchLike = createFetch();

async function readJsonSafe(res: Response): Promise<Record<string, unknown> | null> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) return null;
  try {
    const body = await res.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
