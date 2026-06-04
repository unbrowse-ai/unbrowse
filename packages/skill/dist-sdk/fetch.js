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
/**
 * Build a `fetch`-shaped function. With no options it is the platform fetch.
 * With a `pay` handler it transparently retries a single 402 once the handler
 * supplies payment headers.
 */
export function createFetch(options = {}) {
    const base = options.fetch ?? globalThis.fetch;
    if (typeof base !== "function") {
        throw new Error("No fetch implementation available. Pass `fetch` in options or run on Node 18+ / a modern browser.");
    }
    const transport = base.bind(globalThis);
    const pay = options.pay;
    // No payment handler → an exact pass-through. This is the zero-config default.
    if (!pay)
        return transport;
    return async function unbrowseFetch(input, init) {
        const res = await transport(input, init);
        if (res.status !== 402)
            return res;
        const terms = await readJsonSafe(res.clone());
        const extra = await pay({ response: res, request: { input, init }, terms });
        if (!extra)
            return res; // handler declined — behave like native fetch.
        // Single retry with the handler's payment headers merged in. One retry only:
        // a payment that does not satisfy the route must surface, not loop.
        const headers = new Headers(init?.headers);
        new Headers(extra).forEach((value, key) => headers.set(key, value));
        return transport(input, { ...init, headers });
    };
}
/**
 * The keyless, dependency-free default: a `fetch` drop-in with no payment
 * handler. Identical to the platform fetch; exported so callers can swap
 * `fetch` → `unfetch` with no behavioural change and wire payment later.
 */
export const unfetch = createFetch();
async function readJsonSafe(res) {
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json"))
        return null;
    try {
        const body = await res.json();
        return body && typeof body === "object" && !Array.isArray(body)
            ? body
            : null;
    }
    catch {
        return null;
    }
}
