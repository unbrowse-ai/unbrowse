/**
 * surface-projector — the answer to "is the CLI superpattern-shaped, or do we expose
 * only the verbs we need each time?" It is BOTH, at two altitudes:
 *
 *   - cli-surface.ts is the MODEL: the complete superpattern/covenant verb tree
 *     (every command = one verb build/breath/eval × one interrogative + its holes+auth,
 *     no route/logic/secret). That is the covenant shape (~/Projects/covenant: three
 *     verbs, declarative kinds, pointer receipts).
 *   - This is the SURFACE: a context PROJECTION of that tree. The agent calls one API
 *     (projectSurface) that returns ONLY the verbs+holes relevant to the current moment;
 *     the LLM decides how to populate the holes. Expose-only-what-you-need is not a rival
 *     to the superpattern — it is the superpattern, projected for context.
 *
 * So: static tree = the invariant; dynamic projection = the surface. The union of every
 * projection is the whole tree (nothing is permanently hidden); each projection is the
 * minimal hole-set for its phase (nothing extra is asked).
 */
import { surfaceFor, knownCommands, type Surface, type Verb } from "./cli-surface.js";

/** What the agent knows about the current moment — drives which verbs are surfaced. */
export interface SurfaceContext {
  /** a managed browse session is open (snap/click/submit/close are live). */
  sessionOpen?: boolean;
  /** the last action returned auth_required — the auth verb must surface. */
  authRequired?: boolean;
  /** the agent already has an intent (discovery verbs are the entry point). */
  intentKnown?: boolean;
}

/** Phase of each command — the projection unit. Derived here (not in the model) so the
 *  model stays a pure atom map. */
type Phase = "discover" | "enter" | "browse" | "execute" | "manage";

// Keyed by FULL subcommand "<verb> <cap>" (key-identical to cli-surface.ts SURFACE),
// matching what knownCommands() returns. Purged caps (note, mode, payment-provider,
// health, contract, create/act/read, browse-cookies) are absent.
const PHASE: Record<string, Phase> = {
  // discover — find the route/skill/spec (no session needed)
  "eval search": "discover", "breath get": "discover", "eval resolve": "discover",
  "eval explain": "discover", "eval spec": "discover", "build index": "discover",
  "eval skills": "discover", "eval skill": "discover", "eval auth-inventory": "discover",
  // enter — cross into a site / one-shot
  "breath go": "enter", "breath run": "enter", "breath fetch": "enter",
  "breath capture": "enter", "breath auth": "enter",
  // browse — only meaningful with a session open
  "eval snap": "browse", "breath click": "browse", "breath type": "browse",
  "breath press": "browse", "breath scroll": "browse", "breath select": "browse",
  "breath submit": "browse", "eval screenshot": "browse", "eval text": "browse",
  "build review": "browse", "build annotate": "browse", "breath close": "browse",
  // execute — replay a resolved endpoint / fill sealed values
  "breath execute": "execute", "breath fill": "execute",
  // manage — account / config / publish (always available, low priority)
  "build setup": "manage", "eval account": "manage", "breath dashboard": "manage",
  "eval settings": "manage", "eval feedback": "manage", "build publish": "manage",
  "build publish-bundle": "manage", "breath upgrade": "manage",
  "build cleanup-stale": "manage", "breath mcp": "manage",
};

function phaseOf(command: string): Phase {
  return PHASE[command] ?? "manage";
}

/**
 * Project the full superpattern surface down to only the verbs+holes the moment needs.
 * Returns Surface entries (command + verb + interrogative + holes + auth ONLY — the
 * model already guarantees no internal field leaks). The LLM populates the holes.
 *
 *   no session  → discover + enter + execute (+ auth if required) ; not browse
 *   session open→ browse + execute + discover                     ; not re-enter
 *   auth needed → the `auth` verb is always surfaced (sealed domain hole)
 */
export function projectSurface(ctx: SurfaceContext = {}): Surface[] {
  // manage (account/config/health/publish) is always available, low priority; the
  // session state swaps browse-vs-enter.
  const wanted = new Set<Phase>(
    ctx.sessionOpen
      ? ["browse", "execute", "discover", "manage"]
      : ["discover", "enter", "execute", "manage"],
  );
  const out: Surface[] = [];
  for (const command of knownCommands()) {
    const phase = phaseOf(command);
    const include = wanted.has(phase) || (ctx.authRequired && command === "breath auth");
    if (!include) continue;
    const s = surfaceFor(command);
    if (s) out.push(s);
  }
  return out;
}

/** Just the verbs present in a projection (for a compact surface description). */
export function projectedVerbs(ctx: SurfaceContext = {}): Verb[] {
  return [...new Set(projectSurface(ctx).map((s) => s.verb))];
}

/** The holes the LLM must consider for a projection: command → its fill targets. */
export function projectedHoles(ctx: SurfaceContext = {}): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const s of projectSurface(ctx)) out[s.command] = s.holes;
  return out;
}
