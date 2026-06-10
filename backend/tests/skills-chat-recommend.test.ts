/**
 * Path-A brick 3a: the live /v1/skills/chat orchestrator surfaces a structured,
 * validated `recommended_command` alongside the prose answer — so a caller can
 * EXECUTE the recommendation, not just read prose about it. The recommend dep is
 * injectable (real route wires recommendCommandCached + proposeViaLlm); when
 * absent, the result omits the field (back-compat).
 *
 * Red under HEAD — SkillChatResult has no recommended_command, runSkillChat
 * takes no recommend dep.
 */
import { test, expect } from "bun:test";
import { runSkillChat, type SkillChatDeps } from "../src/routes/skills-chat";
import type { SkillManifest } from "../src/types";
import type { ValidatedCommand } from "../src/services/recommend-command";

function skill(): SkillManifest {
  return {
    skill_id: "sk-hn", version: "1.0.0", schema_version: "1", name: "HN",
    intent_signature: "search hn", domain: "hn.algolia.com", description: "d",
    owner_type: "agent", execution_type: "http", lifecycle: "active",
    endpoints: [
      { endpoint_id: "ep-search", method: "GET", url_template: "https://hn.algolia.com/api/v1/search?query={query}&tags={tags}", description: "search", idempotency: "safe", verification_status: "verified", reliability_score: 0.9 },
    ],
  } as SkillManifest;
}

test("surfaces a validated recommended_command when a recommend dep is wired", async () => {
  const deps: SkillChatDeps = {
    resolveSkill: async () => ({ skill: skill(), via: "semantic" }),
    chat: async () => "Here are the rust stories…",
    recommend: async (s, _msg): Promise<ValidatedCommand> => ({
      ok: true, endpoint_id: "ep-search", method: "GET",
      url: "https://hn.algolia.com/api/v1/search?query=rust&tags=story",
    }),
  };
  const result = await runSkillChat(deps, { message: "find rust stories" });
  expect(result.recommended_command).toBeDefined();
  expect(result.recommended_command?.ok).toBe(true);
  if (result.recommended_command?.ok) {
    expect(result.recommended_command.endpoint_id).toBe("ep-search");
    expect(result.recommended_command.url).toContain("query=rust");
  }
});

test("omits recommended_command when no recommend dep (back-compat)", async () => {
  const deps: SkillChatDeps = {
    resolveSkill: async () => ({ skill: skill(), via: "semantic" }),
    chat: async () => "prose",
  };
  const result = await runSkillChat(deps, { message: "x" });
  expect(result.recommended_command).toBeUndefined();
  expect(result.answer).toBe("prose");
});

test("a rejected recommendation rides through honestly (not dropped)", async () => {
  const deps: SkillChatDeps = {
    resolveSkill: async () => ({ skill: skill(), via: "semantic" }),
    chat: async () => "prose",
    recommend: async (): Promise<ValidatedCommand> => ({ ok: false, reason: "endpoint \"ghost\" is not in this skill" }),
  };
  const result = await runSkillChat(deps, { message: "x" });
  expect(result.recommended_command?.ok).toBe(false);
});
