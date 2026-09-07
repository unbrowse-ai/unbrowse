/**
 * capture-report — what a capture actually MEANS, as one decision.
 *
 * Four different outcomes arrive at the caller wearing the same clothes
 * (`routes: []`), and each demands a different response:
 *
 *   indexed     — routes found. Nothing to explain.
 *   origin_down — nothing was received at all. Retrying is pointless.
 *   refused     — the routes exist and a bot wall answered instead. Retrying
 *                 the same way will be refused again; clearing the wall is the
 *                 only thing that changes the result.
 *   empty       — the page genuinely has no API. Retrying is also pointless,
 *                 but for the opposite reason.
 *
 * Before this, `refused` was reported as `empty` — verbatim, "no API routes
 * discovered (page may be static HTML)" — for a page whose API had returned a
 * Cloudflare interstitial. That is the absence-invites-the-wrong-repair failure
 * the blocked partition was built to prevent, and the signal it produced was
 * being discarded by its only consumer, so the fix stopped one layer short of
 * doing anything.
 *
 * Pure: no I/O, no logging. The caller decides where the words go.
 */

export interface CaptureOutcomeInput {
  engine: string;
  routeCount: number;
  blocked?: ReadonlyArray<{ vendor: string }>;
  error?: string;
}

export type CaptureOutcomeKind = "indexed" | "origin_down" | "refused" | "empty";

export interface CaptureOutcome {
  kind: CaptureOutcomeKind;
  /** True when the caller should write these routes to the index. */
  shouldIndex: boolean;
  message: string;
}

/** Distinct vendors, in first-seen order — stable output for a stable input. */
function vendorsOf(blocked: ReadonlyArray<{ vendor: string }> | undefined): string[] {
  const seen = new Set<string>();
  for (const b of blocked ?? []) if (b?.vendor) seen.add(b.vendor);
  return [...seen];
}

export function describeCaptureOutcome(input: CaptureOutcomeInput): CaptureOutcome {
  const { engine, routeCount } = input;
  const blocked = input.blocked ?? [];
  const vendors = vendorsOf(blocked);

  // A dead origin outranks everything: nothing was received, so there is no
  // meaningful statement to make about routes or walls.
  if (input.error) {
    return {
      kind: "origin_down",
      shouldIndex: false,
      message: `[bg-api-capture] ${engine}: ${input.error} — nothing to index`,
    };
  }

  if (routeCount > 0) {
    // Partial refusal is still worth saying out loud: some endpoints were
    // indexed and OTHERS were refused, so the index is incomplete in a way the
    // route count alone cannot show.
    const suffix = blocked.length > 0
      ? ` (${blocked.length} other route(s) refused by ${vendors.join(",")})`
      : "";
    return {
      kind: "indexed",
      shouldIndex: true,
      message: `[bg-api-capture] ${engine}: captured ${routeCount} request(s) — indexing${suffix}`,
    };
  }

  if (blocked.length > 0) {
    return {
      kind: "refused",
      shouldIndex: false,
      message:
        `[bg-api-capture] ${engine}: ${blocked.length} route(s) REFUSED by ${vendors.join(",")} — `
        + `the routes exist and were denied, which is NOT "no routes". Retrying the same way will be `
        + `refused again; only clearing the wall changes this.`,
    };
  }

  return {
    kind: "empty",
    shouldIndex: false,
    message: `[bg-api-capture] ${engine}: no API routes discovered (page may be static HTML)`,
  };
}
