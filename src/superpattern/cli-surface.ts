/**
 * cli-surface — the unbrowse CLI shaped to the superpattern atoms
 * (~/.claude/skills/superpattern/references/atoms.json), exposing, for each command,
 * ONLY what a client needs: its atom (one interrogative + one verb) and its holes
 * (the inputs the agent's LLM fills + the auth it must provide) — never the internal
 * route, logic, or secret. "The CLI is a client only exposing what it needs, via ZK."
 *
 * The verbs (atoms.json):
 *   build  (Father / effect)  — realize a claim in the world (do an action)
 *   breath (Spirit / route)   — carry / route / connect between nodes
 *   eval   (Son / query)      — judge a claim against evidence (read / surface)
 *
 * `auth` says how a hole's secret is bound: "none" (no secret), "wallet" (a
 * wallet-bound value), or "sealed" (sealed-unless-revealed; only the holder opens
 * it — composes with src/capture/sealed-fill.ts + zk-bound-hole.ts). A Surface
 * carries NO `route`/`logic`/`secret` field by construction — that is the moat the
 * backend keeps; the client sees holes only.
 */

export type Verb = "build" | "breath" | "eval";
export type Interrogative = "who" | "what" | "when" | "where" | "why" | "how";
export type Auth = "none" | "wallet" | "sealed";

export interface Surface {
  command: string;
  verb: Verb;
  interrogative: Interrogative;
  holes: readonly string[]; // the ONLY inputs exposed to the client
  auth: Auth;
}

/** The canonical CLI surface: every top-level command → its atom + exposed holes.
 *  (Single source of truth for the shape; the gate checks completeness + minimality.) */
// Keyed by FULL subcommand "<verb> <cap>" so the same noun can live under two
// verbs (e.g. "build skill" publishes a manifest; "eval skill" reads one). This
// is key-identical to src/cli-v7/kind-map.ts — the surface-gate compares them
// row-for-row. The rejected create/act/read aliases are gone; "eval" (JS) was
// renamed "breath run-js" to avoid colliding with the eval verb.
const SURFACE: Record<string, Omit<Surface, "command">> = {
  // ── build (declare) ────────────────────────────────────────────────
  "build skill":           { verb: "build",  interrogative: "what",  holes: ["kind", "schema"],   auth: "wallet" },
  "build template":        { verb: "build",  interrogative: "what",  holes: ["kind", "schema"],   auth: "wallet" },
  "build value-source":    { verb: "build",  interrogative: "what",  holes: ["kind", "ref"],      auth: "sealed" },
  "build index":           { verb: "build",  interrogative: "what",  holes: ["domain"],           auth: "none"   },
  "build publish":         { verb: "build",  interrogative: "where", holes: [],                   auth: "wallet" },
  "build publish-bundle":  { verb: "build",  interrogative: "where", holes: [],                   auth: "wallet" },
  "build annotate":        { verb: "build",  interrogative: "why",   holes: ["text"],             auth: "none"   },
  "build review":          { verb: "build",  interrogative: "what",  holes: [],                   auth: "none"   },
  "build skill-package":   { verb: "build",  interrogative: "what",  holes: ["id"],               auth: "wallet" },
  "build setup":           { verb: "build",  interrogative: "who",   holes: [],                   auth: "wallet" },
  "build register":        { verb: "build",  interrogative: "who",   holes: ["email"],            auth: "wallet" },
  "build contribute":      { verb: "build",  interrogative: "why",   holes: ["mode"],             auth: "none"   },
  "build cleanup-stale":   { verb: "build",  interrogative: "when",  holes: ["domain"],           auth: "none"   },

  // ── breath (actuate) ───────────────────────────────────────────────
  "breath go":             { verb: "breath", interrogative: "how",   holes: ["url"],              auth: "none"   },
  "breath fill":           { verb: "breath", interrogative: "how",   holes: ["ref", "value"],     auth: "sealed" },
  "breath fill-form":      { verb: "breath", interrogative: "how",   holes: ["intent"],           auth: "sealed" },
  "breath type":           { verb: "breath", interrogative: "how",   holes: ["ref", "text"],      auth: "none"   },
  "breath click":          { verb: "breath", interrogative: "how",   holes: ["ref"],              auth: "none"   },
  "breath press":          { verb: "breath", interrogative: "how",   holes: ["key"],              auth: "none"   },
  "breath select":         { verb: "breath", interrogative: "how",   holes: ["ref", "value"],     auth: "none"   },
  "breath scroll":         { verb: "breath", interrogative: "how",   holes: ["direction"],        auth: "none"   },
  "breath submit":         { verb: "breath", interrogative: "how",   holes: ["ref"],              auth: "none"   },
  "breath execute":        { verb: "breath", interrogative: "how",   holes: ["endpoint", "params"], auth: "sealed" },
  "breath auth-capture":   { verb: "breath", interrogative: "who",   holes: ["domain"],           auth: "sealed" },
  "breath proxy-rotate":   { verb: "breath", interrogative: "where", holes: [],                   auth: "none"   },
  "breath close":          { verb: "breath", interrogative: "when",  holes: [],                   auth: "none"   },
  "breath session-park":   { verb: "breath", interrogative: "when",  holes: [],                   auth: "wallet" },
  "breath session-restore":{ verb: "breath", interrogative: "when",  holes: ["id"],               auth: "wallet" },
  "breath run":            { verb: "breath", interrogative: "how",   holes: ["script"],           auth: "none"   },
  "breath get":            { verb: "breath", interrogative: "how",   holes: ["intent", "url"],    auth: "sealed" },
  "breath fetch":          { verb: "breath", interrogative: "how",   holes: ["url"],              auth: "none"   },
  "breath capture":        { verb: "breath", interrogative: "how",   holes: ["url", "intent"],    auth: "sealed" },
  "breath back":           { verb: "breath", interrogative: "how",   holes: [],                   auth: "none"   },
  "breath forward":        { verb: "breath", interrogative: "how",   holes: [],                   auth: "none"   },
  "breath sync":           { verb: "breath", interrogative: "when",  holes: ["domain"],           auth: "none"   },
  "breath run-js":         { verb: "breath", interrogative: "how",   holes: ["script"],           auth: "none"   },
  "breath auth":           { verb: "breath", interrogative: "who",   holes: ["domain"],           auth: "sealed" },
  "breath connect-chrome": { verb: "breath", interrogative: "where", holes: [],                   auth: "none"   },
  "breath serve":          { verb: "breath", interrogative: "where", holes: [],                   auth: "none"   },
  "breath mcp":            { verb: "breath", interrogative: "where", holes: [],                   auth: "none"   },
  "breath dashboard":      { verb: "breath", interrogative: "where", holes: [],                   auth: "wallet" },
  "breath upgrade":        { verb: "breath", interrogative: "when",  holes: [],                   auth: "none"   },

  // ── eval (observe) ─────────────────────────────────────────────────
  "eval snap":             { verb: "eval",   interrogative: "what",  holes: [],                   auth: "none"   },
  "eval resolve":          { verb: "eval",   interrogative: "what",  holes: ["intent", "domain"], auth: "none"   },
  "eval status":           { verb: "eval",   interrogative: "why",   holes: [],                   auth: "none"   },
  "eval version":          { verb: "eval",   interrogative: "why",   holes: [],                   auth: "none"   },
  "eval trace":            { verb: "eval",   interrogative: "why",   holes: ["id"],               auth: "none"   },
  "eval markdown":         { verb: "eval",   interrogative: "what",  holes: [],                   auth: "none"   },
  "eval screenshot":       { verb: "eval",   interrogative: "what",  holes: [],                   auth: "none"   },
  "eval text":             { verb: "eval",   interrogative: "what",  holes: [],                   auth: "none"   },
  "eval cookies":          { verb: "eval",   interrogative: "who",   holes: ["domain"],           auth: "none"   },
  "eval stats":            { verb: "eval",   interrogative: "why",   holes: [],                   auth: "none"   },
  "eval skills":           { verb: "eval",   interrogative: "what",  holes: [],                   auth: "none"   },
  "eval skill":            { verb: "eval",   interrogative: "what",  holes: ["id"],               auth: "none"   },
  "eval sessions":         { verb: "eval",   interrogative: "what",  holes: [],                   auth: "none"   },
  "eval earnings":         { verb: "eval",   interrogative: "why",   holes: [],                   auth: "wallet" },
  "eval settings":         { verb: "eval",   interrogative: "why",   holes: [],                   auth: "none"   },
  "eval feedback":         { verb: "eval",   interrogative: "why",   holes: ["rating"],           auth: "none"   },
  "eval reflect":          { verb: "eval",   interrogative: "why",   holes: [],                   auth: "none"   },
  "eval auth-inventory":   { verb: "eval",   interrogative: "who",   holes: [],                   auth: "none"   },
  "eval spec":             { verb: "eval",   interrogative: "what",  holes: ["domain"],           auth: "none"   },
  "eval explain":          { verb: "eval",   interrogative: "what",  holes: ["intent", "url"],    auth: "none"   },
  "eval search":           { verb: "eval",   interrogative: "what",  holes: ["intent"],           auth: "none"   },
  "eval inspect":          { verb: "eval",   interrogative: "what",  holes: ["url"],              auth: "none"   },
  "eval account":          { verb: "eval",   interrogative: "who",   holes: ["email"],            auth: "wallet" },
  "eval config":           { verb: "eval",   interrogative: "why",   holes: [],                   auth: "none"   },
};

const VERBS: readonly Verb[] = ["build", "breath", "eval"];
const INTERROGATIVES: readonly Interrogative[] = ["who", "what", "when", "where", "why", "how"];
const FORBIDDEN_FIELDS = ["route", "logic", "secret", "url_template", "endpoint_url", "internal"];

/** The minimal client-facing surface for a command — holes + auth + atom only. */
export function surfaceFor(command: string): Surface | null {
  const s = SURFACE[command];
  return s ? { command, ...s } : null;
}

export function classify(command: string): { verb: Verb; interrogative: Interrogative } | null {
  const s = SURFACE[command];
  return s ? { verb: s.verb, interrogative: s.interrogative } : null;
}

export function knownCommands(): string[] {
  return Object.keys(SURFACE);
}

/**
 * Verify the surface is superpattern-shaped and exposes only what it needs:
 *  - every command maps to a valid verb (build/breath/eval) + interrogative,
 *  - every Surface carries NO forbidden internal field (route/logic/secret/…),
 *  - any command in `expected` is present (completeness against the live CLI list).
 * Returns { ok, missing, errors } — ok iff superpattern-complete + minimal.
 */
export function verifySurface(expected: readonly string[] = []): { ok: boolean; missing: string[]; errors: string[] } {
  const errors: string[] = [];
  for (const cmd of knownCommands()) {
    const s = SURFACE[cmd];
    if (!VERBS.includes(s.verb)) errors.push(`${cmd}: invalid verb ${s.verb}`);
    if (!INTERROGATIVES.includes(s.interrogative)) errors.push(`${cmd}: invalid interrogative ${s.interrogative}`);
    if (!Array.isArray(s.holes)) errors.push(`${cmd}: holes not an array`);
    for (const f of FORBIDDEN_FIELDS) {
      if (f in (s as Record<string, unknown>)) errors.push(`${cmd}: leaks internal field '${f}'`);
    }
  }
  const missing = expected.filter((c) => !(c in SURFACE));
  return { ok: errors.length === 0 && missing.length === 0, missing, errors };
}
