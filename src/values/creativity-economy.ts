/**
 * creativity-economy — default-on proof-of-creativity hook for unbrowse act/execute.
 *
 * Fire-and-forget: spawns the shell act recorder (creativity-act-hook.sh → act.sh)
 * after every execute. Never blocks the hot path; never throws.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export function creativityEconomyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CREATIVITY_ECONOMY ?? "1";
  return v !== "0" && v !== "false" && v !== "off";
}

/** Resolve the hook script — env override first, then known install locations. */
export function resolveCreativityActHook(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME ?? homedir();
  const candidates = [
    env.CREATIVITY_ACT_HOOK,
    env.CREATIVITY_ECONOMY_ACT,
    join(home, "unbrowse", "scripts", "creativity-act-hook.sh"),
    join(home, "contract", "creativity-economy", "scripts", "act.sh"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export interface CreativityActOpts {
  text: string;
  route?: string;
  wallet?: string;
  cacheHit?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Spawn the act recorder detached. No-op when disabled or hook missing. */
export function recordCreativityAct(opts: CreativityActOpts): void {
  const env = { ...process.env, ...opts.env };
  if (!creativityEconomyEnabled(env)) return;

  const hook = resolveCreativityActHook(env);
  if (!hook) return;

  const args = [hook, "--text", opts.text];
  if (opts.wallet) args.push("--wallet", opts.wallet);
  if (opts.route) args.push("--route", opts.route);
  args.push(opts.cacheHit ? "--cache-hit" : "--cache-miss");

  try {
    const child = spawn("bash", args, { stdio: "ignore", detached: true, env });
    child.unref();
  } catch {
    // fail-open — creativity recording must never break execute
  }
}

/** Read cache_hit from orchestrator / API execute envelopes. */
export function cacheHitFromResult(result: unknown): boolean | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (r._cache_hit === true) return true;
  const timing = r.timing as Record<string, unknown> | undefined;
  if (timing?.cache_hit === true) return true;
  if (timing?.cache_hit === false) return false;
  const impact = r.impact as Record<string, unknown> | undefined;
  if (impact?.cache_hit === true) return true;
  if (impact?.cache_hit === false) return false;
  return undefined;
}

export function recordCreativityActFromExecute(
  result: unknown,
  extras: { intent?: string; skill_id?: string; endpoint_id?: string },
  env?: NodeJS.ProcessEnv,
): void {
  const cacheHit = cacheHitFromResult(result) ?? false;
  const parts = [
    extras.intent ? `intent:${extras.intent}` : null,
    extras.skill_id ? `skill:${extras.skill_id}` : null,
    extras.endpoint_id ? `endpoint:${extras.endpoint_id}` : null,
  ].filter(Boolean);
  const text = parts.length > 0 ? parts.join(" ") : "unbrowse execute";
  recordCreativityAct({
    text,
    route: extras.endpoint_id ?? extras.skill_id,
    cacheHit,
    env,
  });
}