/**
 * backend-reveng-endpoint — the backend IS the harness.
 *
 * The whole reverse-engineering engine lives server-side; the open client does
 * exactly three things and exposes nothing else:
 *
 *   1. clientObfuscate  — strip every secret/PII value from a real capture and
 *      PROVE (audit, against the user's own vault secrets) that none survive, so
 *      nothing unsafe ever leaves the machine. What goes up is structure only.
 *   2. backendSurface   — (server-side) run hole extraction over the obfuscated
 *      capture and return ONLY {skeleton, holes}: the slots to fill, never the
 *      engine, never a secret. The moat (capture/RE logic) stays on the backend;
 *      the client sees the shape of what to fill and nothing more.
 *   3. clientFillSealed — fill the holes LOCALLY from the vault, sealed to the
 *      wallet (revealed only by the holder at the instant the concrete request is
 *      built). The backend never sees a plaintext secret at any point.
 *
 * This is the north star's "obfuscated API with a harness under the hood, powered
 * by the user's own data, ZK'd to their wallet" made into one composed, testable
 * flow over the primitives that already shipped (obfuscate, obfuscate-audit,
 * hole-template, sealed-fill, zk-bound-hole). The response surface is provably
 * minimal: `responseExposesOnlyHoles` lets the open client confirm the backend
 * returned nothing but holes.
 */
import type { RawRequest } from "./index.js";
import { obfuscateAuditedCapture, type ObfuscationAudit } from "./obfuscate-audit.js";
import { extractHoles, type HoleTemplate } from "./hole-template.js";
import { sealFills, fillHolesSealed } from "./sealed-fill.js";
import { verifyHoleAttested } from "./zk-bound-hole.js";

/** What the CLIENT sends up: ONLY the obfuscated capture (every secret already a
 *  redacted/wallet-bound placeholder). No plaintext secret, no vault, no engine. */
export interface RevengRequest {
  capture: RawRequest[];
}

/** What the BACKEND returns: ONLY the holes to fill + the skeleton, per request.
 *  By construction this carries no secret value and no reverse-engineering engine
 *  internals — the moat stays server-side. */
export interface RevengResponse {
  templates: HoleTemplate[];
}

/**
 * Client step 1 — obfuscate + audit a real capture against the user's own secrets.
 * Throws (ObfuscationLeakError) if any known secret would leak, so nothing unsafe
 * ever leaves the machine. Returns the request to send up + the audit the open
 * client can show ("0 leaks, N wallet-bound redactions").
 */
export function clientObfuscate(
  raw: RawRequest[],
  opts: { secrets: string[]; walletPubkey?: string },
): { request: RevengRequest; audit: ObfuscationAudit } {
  const { capture, audit } = obfuscateAuditedCapture(raw, { ...opts, enforce: true });
  return { request: { capture }, audit };
}

/**
 * Backend — run hole extraction over the obfuscated capture and return ONLY
 * {skeleton, holes}. The engine never crosses the wire. Pure over its input: the
 * backend sees structure, emits the slots to fill, holds everything else.
 */
export function backendSurface(req: RevengRequest): RevengResponse {
  return { templates: req.capture.map((skeleton) => extractHoles(skeleton)) };
}

const ALLOWED_TEMPLATE_KEYS = new Set(["skeleton", "holes"]);

/**
 * The open client's guard: confirm the backend exposed nothing but holes — every
 * template carries only `skeleton` + `holes`, and no hole carries a plaintext
 * `secret`/`value` field. Returns true iff the response surface is minimal.
 */
export function responseExposesOnlyHoles(resp: RevengResponse): boolean {
  return resp.templates.every((t) => {
    if (!Object.keys(t).every((k) => ALLOWED_TEMPLATE_KEYS.has(k))) return false;
    return t.holes.every((h) => !("secret" in h) && !("value" in h));
  });
}

/**
 * Backend attestation — for holes carrying a real ZK binding, confirm the wallet
 * bound the slot WITHOUT the secret and WITHOUT a proof (verifyHoleAttested). A
 * plain commitment (`[bound:hex]`) from obfuscation is hidden but not Ed25519-
 * attested, so it is reported unattested honestly rather than waved through.
 */
export function backendAttestedHoles(resp: RevengResponse): { attested: number; total: number } {
  let attested = 0;
  let total = 0;
  for (const t of resp.templates)
    for (const h of t.holes) {
      total++;
      if (verifyHoleAttested(h)) attested++;
    }
  return { attested, total };
}

/**
 * Client step 3 — fill the holes LOCALLY, sealed to the wallet. `fillsPerRequest[i]`
 * maps each hole's `name` to the value the client sourced (auth/secret from its
 * vault, free ids from its LLM). Each value is sealed under the wallet key and
 * revealed only by the holder at fill time; the result is the concrete request,
 * executed locally. The backend never sees a plaintext secret.
 */
export function clientFillSealed(
  resp: RevengResponse,
  fillsPerRequest: Record<string, string>[],
  key: Uint8Array,
): RawRequest[] {
  return resp.templates.map((t, i) => fillHolesSealed(t, sealFills(fillsPerRequest[i] ?? {}, key), key));
}
