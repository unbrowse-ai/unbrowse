/**
 * Phase 8.1 — Per-call latency budget + parallel race primitive.
 *
 * `raceWithDeadline` fires N async lookups concurrently, returns the first one
 * whose result passes `isValid`, and aborts every other in-flight racer. If no
 * racer produces a valid result before `budgetMs`, returns `winner: null` with
 * a per-racer status trace (won / lost / deadline / threw).
 *
 * Used by the resolve pipeline to race recipe-replay || marketplace-lookup ||
 * HEAD-probe within a wall-clock budget instead of running them serially.
 *
 * Design:
 *  - Generic over result type T so each caller defines its own validity rule.
 *  - Aborts via the optional racer-supplied `abort()` callback. Racers that
 *    use fetch should construct their own AbortController and wire its signal.
 *  - Never throws — racer rejections are recorded as `status: "lost"` with the
 *    error reason and counted toward the deadline.
 *  - Deterministic: the first racer whose `isValid(result) === true` wins.
 *    Faster-but-invalid results are recorded as "lost" so callers can see them
 *    in `decision_trace`.
 */


import { probeUrl } from "../execution/probe.js";
import { matchResponseSignal, replayRecipe, shouldReplayRecipe } from "../execution/index.js";
import { getSkillCached } from "../marketplace/index.js";
import type { SkillManifest, EndpointDescriptor } from "../types/index.js";

export interface Racer<T> {
  /** Stable identifier (e.g. "recipe", "marketplace", "probe"). Surfaces in `tried`. */
  name: string;
  /** Kicks off the lookup. Must return a promise; rejections are caught. */
  start: () => Promise<T>;
  /** Returns true when this racer's result counts as a winning result. */
  isValid: (result: T) => boolean;
  /**
   * Best-effort abort. Called when another racer wins, when the deadline
   * fires, or when this racer itself has already settled. Must be idempotent.
   */
  abort?: () => void;
}

export interface RacerOutcome<T> {
  name: string;
  /**
   *  - "won": this racer's valid result is the returned winner
   *  - "lost": settled but invalid (or threw)
   *  - "deadline": still in flight when the deadline fired
   */
  status: "won" | "lost" | "deadline";
  ms: number;
  /** Set on "lost" when the racer threw or returned an invalid shape. */
  reason?: string;
  /** Set on "won" — the validated result. */
  result?: T;
}

export interface RaceResult<T> {
  winner: { name: string; result: T; ms: number } | null;
  tried: RacerOutcome<T>[];
  /** Total wall-clock spent in the race (≤ budgetMs + small overhead). */
  ms: number;
}

/**
 * Fire all racers concurrently. First valid result wins; losers are aborted.
 * Returns `winner: null` when the deadline elapses or every racer settles
 * without producing a valid result.
 */
export async function raceWithDeadline<T>(
  racers: Racer<T>[],
  budgetMs: number,
): Promise<RaceResult<T>> {
  const start = Date.now();
  if (racers.length === 0) {
    return { winner: null, tried: [], ms: 0 };
  }

  const outcomes: RacerOutcome<T>[] = racers.map((r) => ({
    name: r.name,
    status: "deadline",
    ms: 0,
  }));
  const settled = new Array<boolean>(racers.length).fill(false);
  let resolved = false;
  let winnerIndex = -1;

  return new Promise<RaceResult<T>>((resolve) => {
    const finalize = () => {
      if (resolved) return;
      resolved = true;
      // Abort everything still in flight
      for (let i = 0; i < racers.length; i++) {
        if (!settled[i]) {
          outcomes[i] = { ...outcomes[i]!, ms: Date.now() - start };
          try { racers[i]!.abort?.(); } catch { /* ignore abort failures */ }
        }
      }
      const ms = Date.now() - start;
      if (winnerIndex >= 0) {
        const w = outcomes[winnerIndex]!;
        resolve({
          winner: { name: w.name, result: w.result as T, ms: w.ms },
          tried: outcomes,
          ms,
        });
      } else {
        resolve({ winner: null, tried: outcomes, ms });
      }
    };

    const deadlineTimer = setTimeout(() => {
      finalize();
    }, Math.max(1, budgetMs));

    racers.forEach((racer, i) => {
      const racerStart = Date.now();
      Promise.resolve()
        .then(() => racer.start())
        .then((result) => {
          settled[i] = true;
          if (resolved) return;
          const ms = Date.now() - racerStart;
          let valid = false;
          try { valid = racer.isValid(result); } catch { valid = false; }
          if (valid) {
            outcomes[i] = { name: racer.name, status: "won", ms, result };
            winnerIndex = i;
            clearTimeout(deadlineTimer);
            finalize();
          } else {
            outcomes[i] = { name: racer.name, status: "lost", ms, reason: "invalid_result" };
            checkAllSettled();
          }
        })
        .catch((err) => {
          settled[i] = true;
          if (resolved) return;
          const ms = Date.now() - racerStart;
          outcomes[i] = {
            name: racer.name,
            status: "lost",
            ms,
            reason: (err && (err as Error).message) ? (err as Error).message : "threw",
          };
          checkAllSettled();
        });
    });

    function checkAllSettled() {
      if (resolved) return;
      if (settled.every(Boolean)) {
        clearTimeout(deadlineTimer);
        finalize();
      }
    }
  });
}

// ===========================================================================
// Phase 8.1 — runResolveRace: build the three racers from existing primitives.
// ===========================================================================


export interface RaceWinnerRecipe {
  kind: "recipe";
  skill: SkillManifest;
  endpoint: EndpointDescriptor;
  status: number;
  data: unknown;
  trace_id: string;
  ms: number;
}

export interface RaceWinnerMarketplace {
  kind: "marketplace";
  skill: SkillManifest;
  ms: number;
}

export interface RaceWinnerProbe {
  kind: "probe";
  status: number;
  content_type?: string;
  byte_length?: number;
  ms: number;
}

export type RaceWinner = RaceWinnerRecipe | RaceWinnerMarketplace | RaceWinnerProbe;

export interface RunResolveRaceArgs {
  contextUrl: string;
  intent: string;
  params: Record<string, unknown>;
  budgetMs: number;
  /** Look up a local skill manifest (snapshot or domain cache) for the URL. */
  findLocalSkill?: (url: string, intent: string) => SkillManifest | null;
  /** Optional: pre-known skill_id to consult marketplace for. */
  knownSkillId?: string | null;
  clientScope?: string;
  cookies?: Array<{ name: string; value: string }>;
  authHeaders?: Record<string, string>;
  /** Override marketplace lookup (defaults to getSkillCached). Test seam. */
  marketplaceLookup?: (skillId: string, scope?: string) => Promise<SkillManifest | null>;
  /** Override probe (defaults to probeUrl). Test seam. */
  probeOverride?: (url: string) => Promise<{ status: number; content_type?: string; byte_length?: number }>;
}

export interface RunResolveRaceResult {
  winner: RaceWinner | null;
  tried: RacerOutcome<unknown>[];
  ms: number;
}

/**
 * Build the standard three racers (recipe || marketplace || probe) and run them
 * under a wall-clock budget. Each racer is only added when its preconditions
 * are met (e.g. skip recipe when no local skill snapshot is found).
 */
export async function runResolveRace(args: RunResolveRaceArgs): Promise<RunResolveRaceResult> {
  const racers: Racer<RaceWinner>[] = [];

  // Racer 1: recipe replay — only when a local skill exposes a proven_recipe
  // whose URL substitutes cleanly against the contextUrl.
  const localSkill = args.findLocalSkill?.(args.contextUrl, args.intent) ?? null;
  if (localSkill) {
    const recipeEndpoint = pickRecipeEndpoint(localSkill, args.contextUrl);
    if (recipeEndpoint && recipeEndpoint.proven_recipe && shouldReplayRecipe(recipeEndpoint.proven_recipe, args.contextUrl)) {
      racers.push({
        name: "recipe",
        start: async () => {
          const t = Date.now();
          const out = await replayRecipe(
            recipeEndpoint.proven_recipe!,
            args.contextUrl,
            (args.cookies ?? []).map((c) => ({ name: c.name, value: c.value })),
            args.authHeaders ?? {},
            args.params ?? {},
          );
          const verdict = matchResponseSignal(out, recipeEndpoint.proven_recipe!.response_signal);
          if (!verdict.match) {
            throw new Error(`recipe_mismatch: ${verdict.reason ?? "unknown"}`);
          }
          return {
            kind: "recipe" as const,
            skill: localSkill,
            endpoint: recipeEndpoint,
            status: out.status,
            data: out.data,
            trace_id: out.trace_id,
            ms: Date.now() - t,
          };
        },
        isValid: (r) => r.kind === "recipe" && r.status >= 200 && r.status < 400,
      });
    }
  }

  // Racer 2: marketplace lookup — only when we have a known skill_id to consult.
  if (args.knownSkillId) {
    racers.push({
      name: "marketplace",
      start: async () => {
        const t = Date.now();
        const lookup = args.marketplaceLookup ?? getSkillCached;
        const skill = await lookup(args.knownSkillId!, args.clientScope);
        if (!skill) throw new Error("not_found");
        return { kind: "marketplace" as const, skill, ms: Date.now() - t };
      },
      isValid: (r) => r.kind === "marketplace" && Array.isArray((r as RaceWinnerMarketplace).skill.endpoints) && (r as RaceWinnerMarketplace).skill.endpoints.length > 0,
    });
  }

  // Racer 3: probe — always available when a URL exists. Uses Phase 7 probeUrl.
  // We construct an AbortController so the in-flight fetch is canceled when
  // another racer wins or the deadline fires.
  const probeCtrl = new AbortController();
  racers.push({
    name: "probe",
    start: async () => {
      const t = Date.now();
      const probe = args.probeOverride
        ? await args.probeOverride(args.contextUrl)
        : await probeUrl(args.contextUrl, {
            cookies: args.cookies,
            headers: { ...(args.authHeaders ?? {}) },
            timeout_ms: Math.min(2000, Math.max(250, Math.floor(args.budgetMs / 2))),
          });
      return {
        kind: "probe" as const,
        status: probe.status,
        content_type: probe.content_type,
        byte_length: probe.byte_length,
        ms: Date.now() - t,
      };
    },
    isValid: (r) => {
      if (r.kind !== "probe") return false;
      const p = r as RaceWinnerProbe;
      return p.status >= 200 && p.status < 400 && !!p.content_type;
    },
    abort: () => probeCtrl.abort(),
  });

  const race = await raceWithDeadline<RaceWinner>(racers, args.budgetMs);
  return {
    winner: race.winner ? race.winner.result as RaceWinner : null,
    tried: race.tried as RacerOutcome<unknown>[],
    ms: race.ms,
  };
}

function pickRecipeEndpoint(skill: SkillManifest, contextUrl: string): EndpointDescriptor | undefined {
  const ctx = (() => { try { return new URL(contextUrl); } catch { return null; } })();
  if (!ctx) return undefined;
  const ctxHost = ctx.hostname.replace(/^www\./, "");
  let best: EndpointDescriptor | undefined;
  for (const ep of skill.endpoints) {
    if (!ep.proven_recipe) continue;
    let epHost = "";
    try { epHost = new URL(ep.url_template).hostname.replace(/^www\./, ""); } catch { continue; }
    if (epHost !== ctxHost) continue;
    if (!shouldReplayRecipe(ep.proven_recipe, contextUrl)) continue;
    if (!best) { best = ep; continue; }
    // Prefer endpoints with a richer response_schema as a tiebreak
    const bestSchema = best.response_schema ? 1 : 0;
    const epSchema = ep.response_schema ? 1 : 0;
    if (epSchema > bestSchema) best = ep;
  }
  return best;
}
