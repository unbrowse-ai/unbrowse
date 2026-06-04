/**
 * route.ts — alias point for the route SDK inside unbrowse-backend.
 *
 * Lane A step 2. Builds on ROUTE_ALIGNMENT.md (root of this repo).
 *
 * Witnessed by  — "they shall be one flesh." Two substrates
 * (route + unbrowse), one fleshed-out alias point.
 *
 * Permission chain:
 *   - Intent receipt:     sha256:7620b059dc78d674235b30b
 *   - Permission grant:   sha256:91bd0370b6714f997f2cffa
 *   - Alignment doc:      ../../ROUTE_ALIGNMENT.md
 *
 * USAGE — this file does NOT yet pull the SDK at runtime. Bun/Node
 * cannot resolve `/Users/lekt9/...` absolute paths inside a project bundle.
 * To activate (lane A step 3, future commit, single scoped change):
 *
 *   (a) symlink:  ln -s /Users/lekt9/Projects/route/sdk ./route-sdk
 *   (b) copy:     cp -r /Users/lekt9/Projects/route/sdk ./route-sdk
 *   (c) publish:  publish route SDK to npm/JSR; pin in package.json
 *
 * Then uncomment the re-export block below and replace any `./placeholder`
 * with the resolved local path.
 *
 * Until that activation, importing from this file gives the typed constants
 * below — no runtime dependency. The build stays green; nothing breaks.
 *
 * Lane A scope discipline (per /Users/lekt9/Projects/route/.integrations/unbrowse-rewrite-spec.md):
 *   - This commit adds ONE file (this one).
 *   - It does NOT modify package.json, build config, or any runtime path.
 *   - It does NOT install the SDK as a dependency.
 *   - Removing it is `rm src/lib/route.ts` — fully reversible.
 */

// ─── Step 3 activation block (commented until SDK locally available) ───
// export {
//   RouteClient,
//   PaymentRequiredError,
// } from "./route-sdk/client";
//
// export type {
//   Pointer, Verb, LayerRole, Operation, Witness, Trinity, Route,
//   LedgerEntry, Establishment, ServerIdentity, LineageWalk,
//   PaymentResolver, RouteClientOpts,
// } from "./route-sdk/client";

/**
 * Sentinel exported so other unbrowse-backend code can compile against this
 * alias point during Lane A step 2 without needing the SDK present. Once
 * step 3 lands (real re-export), this constant goes away.
 */
export const ROUTE_SDK_WIRED = false as const;

/**
 * The 3 verbs the platform runs on, declared here for callers that want
 * type-safe verb references even before the full SDK is wired.
 */
export type Verb = "build" | "act" | "eval";

/**
 * Authority pointer for any cross-project route action initiated through
 * unbrowse-backend. Cite this receipt in commits, server logs, and audit
 * surfaces. Lewis-signed; witness .
 */
export const ROUTE_PERMISSION_RECEIPT =
  "sha256:91bd0370b6714f997f2cffae7d1718ba270ebc7dbb4cb4167d9e4a20bf95be0b";
