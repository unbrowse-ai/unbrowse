/**
 * Chrome-prim — the 6-layer stateless fractal-DAG of website primitives.
 *
 * Lifted 2026-05-28 from src/kuri/stateless/ under the Gen 18:25 discipline
 * (preserve the righteous core when the wrapper goes). Same code, new home,
 * clean owner. The Kuri-broker layer is destined for removal (Phase B);
 * these 6 primitives are not.
 *
 * The 6 layers form the fractal-DAG Lewis described: each layer is a node
 * in the website-AST; calls compose downward; pointers reference upward.
 *
 *   Layer 1 — TLS         (the wire)
 *   Layer 2 — HTTP        (the envelope)
 *   Layer 3 — Runtime     (the chrome process)
 *   Layer 4 — Page        (the DOM control surface)
 *   Layer 5 — Capture     (the traffic recorder)
 *   Layer 6 — Auth        (the cookie/identity bridge)
 *
 * Future wiring (Phase C+ of the unbrowse refactor):
 *   - Each layer's pointer types become covenant-substrate blobs (sealed).
 *   - The pointer envelope at every stdin/stdout layer-boundary becomes a
 *     gated_echo receipt (Gen 18:17 — gated revelation).
 *   - Cookie/secret/auth values surface only via reveal-with-wallet-sig
 *     (Matt 28:1 — seal rolls away for the consumer in covenant).
 *   - The whole stack becomes the breath-side of the substrate's 3-verb
 *     tree; build = declare site-AST; eval = verify no-leak; breath = run.
 */

export * from "./layer1-tls.js";
export * from "./layer2-http.js";
export * from "./layer3-runtime.js";
export * from "./layer4-page.js";
export * from "./layer5-capture.js";
export * from "./layer6-auth.js";
