/**
 * POST /v1/skills/chat — chat with the LLM that just follows skills (Gap 3).
 *
 * The single backend loop that welds the three primitives the audit found
 * scattered: it semantically RESOLVES a skill from the message over the
 * emergentdb DAG (searchIntent → the same graph+BM25 ranker), views that skill
 * AS a /contract (skillToContract — Gap 1), and answers by GROUNDING the LLM on
 * the skill's instructions so it can only act through that skill (chatFollowingSkill
 * — Gap 2). One endpoint: resolve → contract → follow → answer + provenance.
 *
 * Private (backend-only). Never lands on the public unbrowse-ai/unbrowse repo.
 */

import { Hono, type Context } from "hono";
import type { Env, SkillManifest } from "../types.js";
import { optionalAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sponsorAcceptsForPriceUsd, handleFlexPaymentAuthorized } from "../services/flex-route-helpers.js";
import { getSkillByDomain, getSkill } from "../services/marketplace.js";
import { searchIntent } from "../services/discovery.js";
import { skillToContract } from "../services/skill-contract.js";
import { persistSkillContract } from "../services/skill-contract-persist.js";
import { handleDeclare, ledgerForRequest } from "./contract.js";
import { chatFollowingSkill, type AikoCompiledContract } from "../services/unbrowse-llm.js";

export interface SkillChatInput {
  message: string;
  intent?: string;
  domain?: string;
}

export interface SkillChatResult {
  answer: string;
  skill_id: string;
  domain: string;
  /** the resolved skill projected into the /contract tree — provenance for the DAG */
  contract: AikoCompiledContract;
  resolved_by: "domain" | "semantic";
}

export class SkillChatError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 400 | 404 | 503) {
    super(message);
    this.name = "SkillChatError";
  }
}

export interface SkillChatDeps {
  /** resolve the most relevant skill for an intent (+ optional domain pin) */
  resolveSkill: (intent: string, domain?: string) => Promise<{ skill: SkillManifest; via: "domain" | "semantic" } | null>;
  /** answer by grounding the LLM on the skill; null = no LLM key (fail closed) */
  chat: (skill: SkillManifest, message: string) => Promise<string | null>;
}

/**
 * Pure orchestrator — no Env, no network, fully injectable. The route wires the
 * real deps; the witness wires fakes and proves the whole resolve→contract→
 * follow→answer loop deterministically.
 */
/** Hard cap on the user message before it reaches the (priced) LLM — bounds
 *  per-request cost/token blast radius (audit A6). */
const MAX_MESSAGE_LEN = 8_000;

/** Strip the owner wallet identity from a contract before it goes out in an
 *  (anonymous) HTTP response — it belongs in the ledger row, not the public
 *  answer (audit A6: no wallet_identity / PII to the caller). */
function redactContract(contract: AikoCompiledContract): AikoCompiledContract {
  const { wallet_identity: _omit, children, ...rest } = contract;
  return { ...rest, children: children.map(redactContract) };
}

export async function runSkillChat(deps: SkillChatDeps, input: SkillChatInput): Promise<SkillChatResult> {
  const message = (input.message ?? "").trim();
  if (!message) throw new SkillChatError("missing_message", "message is required", 400);
  if (message.length > MAX_MESSAGE_LEN) {
    throw new SkillChatError("message_too_long", `message exceeds ${MAX_MESSAGE_LEN} chars`, 400);
  }
  const intent = (input.intent ?? message).trim();

  const resolved = await deps.resolveSkill(intent, input.domain?.trim() || undefined);
  if (!resolved) {
    throw new SkillChatError("no_skill", `no skill resolved for intent "${intent}"`, 404);
  }

  const answer = await deps.chat(resolved.skill, message);
  if (answer == null) {
    throw new SkillChatError("llm_unavailable", "no grounded LLM key configured on this Worker", 503);
  }

  return {
    answer,
    skill_id: resolved.skill.skill_id,
    domain: resolved.skill.domain,
    contract: redactContract(skillToContract(resolved.skill)),  // provenance, sans owner wallet
    resolved_by: resolved.via,
  };
}

/** Real dependency wiring against the live backend services. */
function liveDeps(env: Env): SkillChatDeps {
  return {
    resolveSkill: async (intent, domain) => {
      if (domain) {
        const skill = await getSkillByDomain(env, domain);
        return skill ? { skill, via: "domain" as const } : null;
      }
      // Semantic resolution over the emergentdb DAG (graph + BM25, composite-rescored).
      // A DAG/graph outage is a DEGRADED dependency, not an internal bug → surface 503.
      let hits;
      try {
        hits = await searchIntent(env, intent, 5);
      } catch (e) {
        throw new SkillChatError("resolve_unavailable", `skill resolution failed: ${(e as Error).message}`, 503);
      }
      for (const hit of hits) {
        const meta = (hit.metadata && typeof hit.metadata === "object") ? hit.metadata : {};
        const hitDomain = typeof meta.domain === "string" ? meta.domain : undefined;
        const hitSkillId = typeof meta.skill_id === "string" ? meta.skill_id : undefined;
        const skill = hitSkillId
          ? await getSkill(env, hitSkillId)
          : hitDomain
            ? await getSkillByDomain(env, hitDomain)
            : null;
        if (skill) return { skill, via: "semantic" as const };
      }
      return null;
    },
    chat: (skill, message) => chatFollowingSkill(env, skill, message),
  };
}

type ChatRouteEnv = { Bindings: Env; Variables: { agent_id?: string; user_id?: string } };

/** Fire-and-forget background task (ctx.waitUntil) — the firmament: the write-side
 *  persist never blocks or fails the read-side answer. */
function schedule(c: Context<ChatRouteEnv>, task: Promise<unknown>): void {
  try {
    (c as Context<ChatRouteEnv> & { executionCtx: ExecutionContext }).executionCtx.waitUntil(task);
  } catch {
    void task; // test env / no execution context — let it run, don't crash the response
  }
}

export const skillChatRoutes = new Hono<ChatRouteEnv>();

/** Flat per-call price for the grounded skill-chat on the anonymous x402 lane
 *  (the call invokes the priced LLM). Authenticated callers are billed via the
 *  existing account machinery and skip this. */
const SKILL_CHAT_PRICE_USD = 0.005;

// Grounded-LLM-backed (cost per call). Gated (audit A6): rate-limited always;
// anonymous callers must pay per call via Flex x402; authenticated callers serve
// directly (known + billable). Same Flex pattern as /v1/llm.
skillChatRoutes.post(
  "/skills/chat",
  rateLimit({ limit: 20, window: 60, prefix: "skills-chat" }),
  optionalAuth,
  async (c: Context<ChatRouteEnv>) => {
    let input: SkillChatInput;
    try {
      input = (await c.req.json()) as SkillChatInput;
    } catch {
      return c.json({ error: { code: "invalid_body", message: "request body must be JSON" } }, 400);
    }

    // The actual work: resolve → ground → follow → answer + provenance, then async persist.
    const serve = async (): Promise<Response> => {
      try {
        const result = await runSkillChat(liveDeps(c.env), input);
        // Write-side (Layer 2): persist the resolved skill as a ledger contract,
        // ENTIRELY async so the answer is already on its way. Settles on next graph read.
        schedule(
          c,
          (async () => {
            const skill =
              (await getSkill(c.env, result.skill_id)) ?? (await getSkillByDomain(c.env, result.domain));
            if (!skill) return;
            const ledger = ledgerForRequest(c.env);
            await persistSkillContract(
              {
                ledger,
                declareParent: async (req) =>
                  (await handleDeclare(req, ledger, { admission: "legacy-anonymous" })).id,
              },
              skill,
            );
          })().catch((e) => console.warn("[skills-chat] persist deferred:", (e as Error).message)),
        );
        return c.json(result);
      } catch (err) {
        if (err instanceof SkillChatError) {
          return c.json({ error: { code: err.code, message: err.message } }, err.status);
        }
        console.error("[skills-chat] failed:", (err as Error).message);
        return c.json({ error: { code: "internal", message: "skill chat failed" } }, 500);
      }
    };

    // x402 gate: authenticated callers are known/billable → serve directly.
    if (c.get("agent_id")) return serve();

    // Anonymous → require a Flex payment for the priced LLM call.
    const payment = c.req.header("X-PAYMENT") ?? c.req.header("x-payment");
    if (!payment) {
      const operatorWallet =
        (c.env as { PAYMENT_RECIPIENT?: string }).PAYMENT_RECIPIENT ??
        (c.env as { PAYTO_ADDRESS?: string }).PAYTO_ADDRESS ?? "";
      if (!operatorWallet) {
        return c.json({ error: { code: "operator_wallet_missing", message: "PAYMENT_RECIPIENT not configured" } }, 503);
      }
      const feePayer = (c.env as { PAYAI_FEEPAYER_PUBKEY?: string }).PAYAI_FEEPAYER_PUBKEY?.trim();
      const accepts = sponsorAcceptsForPriceUsd(SKILL_CHAT_PRICE_USD, operatorWallet, feePayer || undefined);
      const required = {
        x402Version: 2,
        error: "payment_required",
        resource: { url: c.req.url, description: "grounded skill chat", mimeType: "application/json" },
        accepts,
        facilitator: "faremeter-flex-solana",
        extra: { price_usd: SKILL_CHAT_PRICE_USD.toFixed(6) },
      };
      return c.json(required, 402, { "PAYMENT-REQUIRED": btoa(JSON.stringify(required)) });
    }
    return handleFlexPaymentAuthorized(c, payment, { executeFn: serve });
  },
);
