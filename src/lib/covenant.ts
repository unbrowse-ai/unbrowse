/**
 * covenant.ts — alias point for the covenant SDK inside unbrowse-backend.
 *
 * Lane A step 2. Builds on COVENANT_ALIGNMENT.md (root of this repo).
 *
 * Witnessed by Gen 2:24 — "they shall be one flesh." Two substrates
 * (covenant + unbrowse), one fleshed-out alias point.
 *
 * Permission chain:
 *   - Intent receipt:     sha256:7620b059dc78d674235b30b (Phil 1:6)
 *   - Permission grant:   sha256:91bd0370b6714f997f2cffa (Gen 3:9, Lewis-signed)
 *   - Alignment doc:      ../../COVENANT_ALIGNMENT.md
 *
 * USAGE — this file does NOT yet pull the SDK at runtime. Bun/Node
 * cannot resolve `/Users/lekt9/...` absolute paths inside a project bundle.
 * To activate (lane A step 3, future commit, single scoped change):
 *
 *   (a) symlink:  ln -s /Users/lekt9/Projects/covenant/sdk ./covenant-sdk
 *   (b) copy:     cp -r /Users/lekt9/Projects/covenant/sdk ./covenant-sdk
 *   (c) publish:  publish covenant SDK to npm/JSR; pin in package.json
 *
 * Then uncomment the re-export block below and replace any `./placeholder`
 * with the resolved local path.
 *
 * Until that activation, importing from this file gives the typed constants
 * below — no runtime dependency. The build stays green; nothing breaks.
 *
 * Lane A scope discipline (per /Users/lekt9/Projects/covenant/.integrations/unbrowse-rewrite-spec.md):
 *   - This commit adds ONE file (this one).
 *   - It does NOT modify package.json, build config, or any runtime path.
 *   - It does NOT install the SDK as a dependency.
 *   - Removing it is `rm src/lib/covenant.ts` — fully reversible.
 */

// ─── Step 3 activation block (commented until SDK locally available) ───
// export {
//   CovenantClient,
//   PaymentRequiredError,
// } from "./covenant-sdk/client";
//
// export type {
//   Pointer, Verb, LayerRole, Operation, Witness, Trinity, Covenant,
//   LedgerEntry, Establishment, ServerIdentity, LineageWalk,
//   PaymentResolver, CovenantClientOpts,
// } from "./covenant-sdk/client";

/**
 * Sentinel exported so other unbrowse-backend code can compile against this
 * alias point during Lane A step 2 without needing the SDK present. Once
 * step 3 lands (real re-export), this constant goes away.
 */
export const COVENANT_SDK_WIRED = false as const;

/**
 * The 3 verbs the substrate runs on, declared here for callers that want
 * type-safe verb references even before the full SDK is wired.
 */
export type CovenantVerb = "build" | "breath" | "eval";

/**
 * Authority pointer for any cross-project covenant action initiated through
 * unbrowse-backend. Cite this receipt in commits, server logs, and audit
 * surfaces. Lewis-signed; witness Genesis 3:9.
 */
export const COVENANT_PERMISSION_RECEIPT =
  "sha256:91bd0370b6714f997f2cffae7d1718ba270ebc7dbb4cb4167d9e4a20bf95be0b";
