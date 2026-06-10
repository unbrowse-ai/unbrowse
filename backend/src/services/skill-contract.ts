/**
 * skill-contract.ts — the unification: a captured skill IS a /contract.
 *
 * A SkillManifest (the website-ability primitive: domain + ranked endpoints,
 * see types.ts:791) and an AikoCompiledContract (the /contract substrate node,
 * unbrowse-llm.ts:8) were two separate objects that only cross-referenced via
 * pointers. This adapter gives them ONE shape, two views: it projects a skill
 * into the exact recursive contract tree the /contract DAG already settles —
 *   root contract  = "fulfil this intent for this domain using only this skill"
 *   one child node = one endpoint (its typed execute pointer is the posthook)
 *   root evaluator = the skill succeeds only when a chosen endpoint resolves
 *
 * The output is structurally identical to compileAikoPromptToTree's output, so
 * the same DAG that integrates evidence + fires neurons over compiled contracts
 * now does it over skills — no second substrate. Private (backend-only); never
 * lands on the public unbrowse-ai/unbrowse repo.
 */

import type { SkillManifest, EndpointDescriptor } from "../types.js";
import type { AikoCompiledContract, AikoCompiledEvaluator } from "./unbrowse-llm.js";

function endpointTitle(ep: EndpointDescriptor): string {
  if (ep.description) return ep.description.split(/[.\n]/)[0].slice(0, 100);
  try {
    const u = new URL(ep.url_template);
    return `${ep.method} ${u.pathname}`;
  } catch {
    return `${ep.method} ${ep.url_template}`;
  }
}

/** Typed contract pointer to execute one endpoint of a skill (mirrors the
 *  `contract:` posthook convention in COMPILE_SYSTEM_PROMPT). */
export function endpointContractPointer(skillId: string, endpointId: string): string {
  return `contract:skill/${skillId}/endpoint/${endpointId}`;
}

/**
 * The living round-trip: recover (skillId, endpointId) from a persisted child
 * row's `action` pointer, so a stored skill-contract is executable, not inert.
 * Segments are `[^/]+` (NOT `[A-Za-z0-9_-]`) — endpoint_id legitimately allows
 * `:` and `.` per the validator's ENDPOINT_ID_RE, so a strict alnum parser
 * would drop valid pointers. Returns null on any non-conforming string.
 */
export function parseEndpointPointer(
  action: string | undefined,
): { skillId: string; endpointId: string } | null {
  if (typeof action !== "string") return null;
  const m = action.match(/^contract:skill\/([^/]+)\/endpoint\/([^/]+)$/);
  return m ? { skillId: m[1], endpointId: m[2] } : null;
}

function endpointToChild(skill: SkillManifest, ep: EndpointDescriptor): AikoCompiledContract {
  const reliability = ep.reliability_score ?? 0;
  const evaluators: AikoCompiledEvaluator[] =
    ep.verification_status || ep.reliability_score != null
      ? [
          {
            prompt: `endpoint ${ep.endpoint_id} returns data satisfying the request`,
            metric: {
              source: "api",
              pointer: endpointContractPointer(skill.skill_id, ep.endpoint_id),
              // honest, derived from the real EndpointDescriptor fields — not invented
              assertion: `verification_status=${ep.verification_status ?? "unverified"} reliability>=${reliability.toFixed(2)}`,
            },
          },
        ]
      : [];
  return {
    prompt: `${ep.method} ${endpointTitle(ep)} — call to satisfy the intent`,
    posthook_pointer: endpointContractPointer(skill.skill_id, ep.endpoint_id),
    evaluators,
    children: [],
  };
}

/**
 * Project a skill into the /contract tree shape. Pure + deterministic — the
 * same skill always yields the same contract, so it's content-addressable the
 * way the DAG expects. Endpoints with no id are dropped (a node with no
 * execute pointer is not a real child), mirroring the compiler's
 * `.filter(child => child.prompt)` discipline.
 */
export function skillToContract(skill: SkillManifest): AikoCompiledContract {
  const endpoints = (skill.endpoints ?? []).filter((ep) => ep.endpoint_id);
  const children = endpoints.map((ep) => endpointToChild(skill, ep));
  const contract: AikoCompiledContract = {
    prompt: `Fulfil the intent "${skill.intent_signature}" for ${skill.domain} using only this skill's ${endpoints.length} endpoint(s); never invent endpoints or data.`,
    evaluators: [
      {
        prompt: "the request is satisfied by a real response from one of this skill's endpoints",
        metric: {
          source: "api",
          pointer: `contract:skill/${skill.skill_id}`,
          assertion: `a child endpoint of skill ${skill.skill_id} returned data matching intent "${skill.intent_signature}"`,
        },
      },
    ],
    children,
  };
  if (skill.owner_agent_id) contract.wallet_identity = skill.owner_agent_id;
  // Carry multi-contributor delta attribution into the canonical /contract
  // form — never erase who built the skill or their marginal delta / share.
  if (skill.contributors && skill.contributors.length > 0) {
    contract.contributors = skill.contributors.map((c) => ({
      agent_id: c.agent_id,
      ...(c.wallet_address ? { wallet_address: c.wallet_address } : {}),
      endpoints_contributed: c.endpoints_contributed,
      cumulative_delta: c.cumulative_delta,
      share: c.share,
    }));
  }
  return contract;
}
