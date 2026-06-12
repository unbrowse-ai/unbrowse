/**
 * cli-surface — the unbrowse CLI shaped to the architecture atoms
 * (~/(internal)), exposing, for each command,
 * ONLY what a client needs: its atom (one interrogative + one verb) and its holes
 * (the inputs the agent's LLM fills + the auth it must provide) — never the internal
 * route, logic, or secret. "The CLI is a client only exposing what it needs, via ZK."
 *
 * The verbs (atoms.json):
 *   build  (Father / effect)  — realize a claim in the world (do an action)
 *   act (Spirit / route)   — carry / route / connect between nodes
 *   eval   (Son / query)      — judge a claim against evidence (read / surface)
 *
 * `auth` says how a hole's secret is bound: "none" (no secret), "wallet" (a
 * wallet-bound value), or "sealed" (sealed-unless-revealed; only the holder opens
 * it — composes with src/capture/sealed-fill.ts + zk-bound-hole.ts). A Surface
 * carries NO `route`/`logic`/`secret` field by construction — that is the moat the
 * backend keeps; the client sees holes only.
 */

export type Verb = "build" | "act" | "eval";
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
const SURFACE: Record<string, Omit<Surface, "command">> = {
  // canonical client verbs — old command names remain aliases below.
  create:          { verb: "build",  interrogative: "what",  holes: ["kind", "schema"],   auth: "wallet" },
  act:             { verb: "act", interrogative: "how",   holes: ["kind", "params"],   auth: "sealed" },
  read:            { verb: "eval",   interrogative: "what",  holes: ["kind", "intent"],   auth: "none" },
  // who — identity / auth (act carries identity; eval reads it)
  auth:            { verb: "act", interrogative: "who",   holes: ["domain"],            auth: "sealed" },
  "auth-inventory":{ verb: "eval",   interrogative: "who",   holes: [],                    auth: "none" },
  account:         { verb: "eval",   interrogative: "who",   holes: ["email"],             auth: "wallet" },
  setup:           { verb: "build",  interrogative: "who",   holes: [],                    auth: "wallet" },
  // what — data / results (eval judges/surfaces)
  search:          { verb: "eval",   interrogative: "what",  holes: ["intent"],            auth: "none" },
  resolve:         { verb: "eval",   interrogative: "what",  holes: ["intent", "domain"],  auth: "none" },
  explain:         { verb: "eval",   interrogative: "what",  holes: ["intent", "url"],     auth: "none" },
  spec:            { verb: "eval",   interrogative: "what",  holes: ["domain"],            auth: "none" },
  index:           { verb: "eval",   interrogative: "what",  holes: ["domain"],            auth: "none" },
  skills:          { verb: "eval",   interrogative: "what",  holes: [],                    auth: "none" },
  skill:           { verb: "eval",   interrogative: "what",  holes: ["id"],                auth: "none" },
  text:            { verb: "eval",   interrogative: "what",  holes: [],                    auth: "none" },
  snap:            { verb: "eval",   interrogative: "what",  holes: [],                    auth: "none" },
  screenshot:      { verb: "eval",   interrogative: "what",  holes: [],                    auth: "none" },
  review:          { verb: "eval",   interrogative: "what",  holes: [],                    auth: "none" },
  // how — actions / effects on the world (build) and fetches that carry bytes (act)
  execute:         { verb: "build",  interrogative: "how",   holes: ["endpoint", "params"],auth: "sealed" },
  fill:            { verb: "build",  interrogative: "how",   holes: ["values"],            auth: "sealed" },
  go:              { verb: "build",  interrogative: "how",   holes: ["url"],               auth: "none" },
  run:             { verb: "build",  interrogative: "how",   holes: ["script"],            auth: "none" },
  capture:         { verb: "build",  interrogative: "how",   holes: ["url", "intent"],     auth: "sealed" },
  click:           { verb: "build",  interrogative: "how",   holes: ["ref"],               auth: "none" },
  type:            { verb: "build",  interrogative: "how",   holes: ["ref", "text"],       auth: "none" },
  press:           { verb: "build",  interrogative: "how",   holes: ["key"],               auth: "none" },
  scroll:          { verb: "build",  interrogative: "how",   holes: ["direction"],         auth: "none" },
  select:          { verb: "build",  interrogative: "how",   holes: ["ref", "value"],      auth: "none" },
  submit:          { verb: "build",  interrogative: "how",   holes: ["ref"],               auth: "none" },
  fetch:           { verb: "act", interrogative: "how",   holes: ["url"],               auth: "none" },
  // where — routing / publication / location (act routes; build publishes)
  publish:         { verb: "build",  interrogative: "where", holes: [],                    auth: "wallet" },
  "publish-bundle":{ verb: "build",  interrogative: "where", holes: [],                    auth: "wallet" },
  mcp:             { verb: "act", interrogative: "where", holes: [],                    auth: "none" },
  "payment-provider":{ verb: "act", interrogative: "where", holes: ["provider"],        auth: "wallet" },
  dashboard:       { verb: "act", interrogative: "where", holes: [],                    auth: "wallet" },
  contract:        { verb: "act", interrogative: "where", holes: ["intent", "wallet_proof", "approval", "local_capability_result", "typed_pointer"], auth: "wallet" },
  // when — lifecycle / timing (act carries the state transition)
  upgrade:         { verb: "act", interrogative: "when",  holes: [],                    auth: "none" },
  "cleanup-stale": { verb: "act", interrogative: "when",  holes: ["domain"],            auth: "none" },
  mode:            { verb: "act", interrogative: "when",  holes: ["mode"],              auth: "none" },
  // why — judgment / feedback / settings (eval judges; build records)
  feedback:        { verb: "eval",   interrogative: "why",   holes: ["rating"],            auth: "none" },
  health:          { verb: "eval",   interrogative: "why",   holes: [],                    auth: "none" },
  settings:        { verb: "eval",   interrogative: "why",   holes: [],                    auth: "none" },
  note:            { verb: "build",  interrogative: "why",   holes: ["text"],              auth: "none" },
  annotate:        { verb: "build",  interrogative: "why",   holes: ["text"],              auth: "none" },
};

const VERBS: readonly Verb[] = ["build", "act", "eval"];
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
 * Verify the surface is architecture-shaped and exposes only what it needs:
 *  - every command maps to a valid verb (build/act/eval) + interrogative,
 *  - every Surface carries NO forbidden internal field (route/logic/secret/…),
 *  - any command in `expected` is present (completeness against the live CLI list).
 * Returns { ok, missing, errors } — ok iff architecture-complete + minimal.
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
