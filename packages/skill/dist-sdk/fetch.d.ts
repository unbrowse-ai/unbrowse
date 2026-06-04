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
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/**
 * Context handed to a {@link PayHandler} when a request comes back `402 Payment
 * Required`. The handler inspects it and decides whether (and how) to pay.
 */
export interface PaymentRequired {
    /** The 402 response, unconsumed — read `.clone()` if you need the body. */
    readonly response: Response;
    /** The original request that triggered the 402, for re-issue after payment. */
    readonly request: {
        input: string | URL | Request;
        init?: RequestInit;
    };
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
 */
export declare function createFetch(options?: CreateFetchOptions): FetchLike;
/**
 * The keyless, dependency-free default: a `fetch` drop-in with no payment
 * handler. Identical to the platform fetch; exported so callers can swap
 * `fetch` → `unfetch` with no behavioural change and wire payment later.
 */
export declare const unfetch: FetchLike;
