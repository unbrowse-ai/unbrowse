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
// Cross-package: the holed-tool projector lives in the src skillmd package. The
// real route (backend/src/routes/) imports it via "../../../src/skillmd.js";
// from this test file (backend/tests/) the same package is "../../src/skillmd".
// This witness proves the projector resolves at test runtime (the route's
// transitive import is exercised by every runSkillChat test below).
import { endpointToHoledTool } from "../../src/skillmd";

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

test("surfaces a PII-censored holed tool when a recommendTool dep is wired", async () => {
  const s = skill();
  const deps: SkillChatDeps = {
    resolveSkill: async () => ({ skill: s, via: "semantic" }),
    chat: async () => "Here are the rust stories…",
    // Real projector (cross-package import) — proves both the shape AND that the
    // import resolves at test runtime.
    recommendTool: async (sk) => endpointToHoledTool(sk, sk.endpoints![0]),
  };
  const result = await runSkillChat(deps, { message: "find rust stories" });
  expect(result.recommended_tool).toBeDefined();
  expect(result.recommended_tool?.url_template).toBe(
    "https://hn.algolia.com/api/v1/search?query={query}&tags={tags}",
  );
  const holes = result.recommended_tool!.holes;
  const query = holes.find((h) => h.name === "query");
  const tags = holes.find((h) => h.name === "tags");
  expect(query).toBeDefined();
  expect(query!.location.in).toBe("query");
  expect(query!.kind).toBe("id");
  expect(query!.fill).toBe("llm");
  expect(tags).toBeDefined();
  expect(tags!.location.in).toBe("query");
  expect(tags!.kind).toBe("id");
  expect(tags!.fill).toBe("llm");
  // No values, no credentials leak into the holed tool.
  expect(JSON.stringify(result.recommended_tool)).not.toContain("rust");
});

test("omits recommended_tool when no recommendTool dep (back-compat)", async () => {
  const deps: SkillChatDeps = {
    resolveSkill: async () => ({ skill: skill(), via: "semantic" }),
    chat: async () => "prose",
  };
  const result = await runSkillChat(deps, { message: "x" });
  expect(result.recommended_tool).toBeUndefined();
  expect(result.answer).toBe("prose");
});

test("omits recommended_tool when recommendTool returns null", async () => {
  const deps: SkillChatDeps = {
    resolveSkill: async () => ({ skill: skill(), via: "semantic" }),
    chat: async () => "prose",
    recommendTool: async () => null,
  };
  const result = await runSkillChat(deps, { message: "x" });
  expect(result.recommended_tool).toBeUndefined();
});
