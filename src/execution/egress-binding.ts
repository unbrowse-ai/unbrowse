/**
 * Egress binding — a harvested session is only valid from the IP that harvested it.
 *
 * This is not a precaution, it is a measurement. Against a Cloudflare-fronted
 * origin, replaying a `__cf_bm` cookie from the IP that obtained it is accepted
 * (the edge re-issues nothing); replaying the SAME cookie from a different IP is
 * rejected and a fresh cookie is minted. Both arms were run twice, with the
 * same-IP control as the second witness. See
 * `bench/sites100/CHALLENGE-RATE-FINDINGS.md`.
 *
 * The failure this prevents is silent and expensive: capture through a
 * residential proxy, replay direct (or after the proxy rotates), and the
 * harvested cookies are already dead — the caller sees an unexplained 403 and
 * blames the route. Recording the capture egress turns that into a named,
 * actionable `egress_mismatch`.
 *
 * Pointer-shaped by design: only the egress IP is recorded, never a cookie or a
 * credential. The IP is the binding key, not a secret.
 */

/** What an egress lookup can tell us. `unknown` is a real answer, not a failure. */
export interface EgressIdentity {
  /** Public egress IP as the origin sees it, or null when it could not be resolved. */
  ip: string | null;
  /** When it was observed (epoch ms) — an egress can rotate under us. */
  observedAt: number;
}

export type EgressVerdict =
  | "match"          // same egress — a harvested session should still be honoured
  | "mismatch"       // egress moved — treat any bound session as invalid
  | "unknown";       // one side is unknown — do not invalidate on a guess

/**
 * Compare a recorded egress against the current one. Deliberately conservative:
 * a missing value yields `unknown`, never `mismatch`, so a lookup failure can
 * never silently throw away a working session.
 */
export function compareEgress(
  recorded: EgressIdentity | null | undefined,
  current: EgressIdentity | null | undefined,
): EgressVerdict {
  const a = recorded?.ip;
  const b = current?.ip;
  if (!a || !b) return "unknown";
  return a === b ? "match" : "mismatch";
}

/**
 * Should a session bound to `recorded` still be replayed from `current`?
 * Only a positive mismatch withholds it — `unknown` proceeds, because refusing
 * on an unresolved lookup would break every offline and air-gapped run.
 */
export function egressAllowsReplay(
  recorded: EgressIdentity | null | undefined,
  current: EgressIdentity | null | undefined,
): boolean {
  return compareEgress(recorded, current) !== "mismatch";
}

/** Human-readable reason for a withheld replay; null when replay is allowed. */
export function egressBlockReason(
  recorded: EgressIdentity | null | undefined,
  current: EgressIdentity | null | undefined,
): string | null {
  if (egressAllowsReplay(recorded, current)) return null;
  // Never print the full addresses — a /24-shaped hint is enough to debug a
  // proxy rotation without writing the operator's exact egress into a log.
  const mask = (ip: string) => ip.replace(/\.\d+$/, ".x").replace(/:[^:]+$/, ":x");
  return `egress_mismatch: session was captured from ${mask(recorded!.ip!)} but this process egresses from ${mask(current!.ip!)}; the origin's session cookies are bound to the capture IP`;
}

const LOOKUP_TIMEOUT_MS = 4000;
/** Cached for the process: an egress can rotate, but not between two calls. */
let cached: EgressIdentity | null = null;

/**
 * Resolve this process's public egress IP. Best-effort and bounded — on any
 * failure it returns `{ip: null}` so callers degrade to `unknown` rather than
 * blocking. `fetchImpl` is injectable so this is testable without a network.
 */
export async function resolveEgress(opts: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  force?: boolean;
} = {}): Promise<EgressIdentity> {
  if (cached && !opts.force) return cached;
  const f = opts.fetchImpl ?? fetch;
  let ip: string | null = null;
  try {
    const res = await f("https://api64.ipify.org", {
      signal: AbortSignal.timeout(opts.timeoutMs ?? LOOKUP_TIMEOUT_MS),
    });
    const text = (await res.text()).trim();
    // Accept only something that looks like an address; a captive-portal HTML
    // body must not be recorded as an "IP" and then mismatch forever after.
    if (/^[0-9a-fA-F:.]{3,45}$/.test(text)) ip = text;
  } catch {
    ip = null;
  }
  const out: EgressIdentity = { ip, observedAt: Date.now() };
  if (ip) cached = out;
  return out;
}

/** Drop the cached egress (after a proxy rotation, or in tests). */
export function resetEgressCache(): void {
  cached = null;
}
