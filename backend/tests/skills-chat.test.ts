import { test, expect } from "bun:test";
import type { SkillManifest } from "../src/types";
import { skillToContract, endpointContractPointer } from "../src/services/skill-contract";
import { chatFollowingSkill } from "../src/services/unbrowse-llm";
import { runSkillChat, type SkillChatDeps } from "../src/routes/skills-chat";
import { makeSkill } from "./fixtures/skill";

// Witnesses for "weld the three gaps: skill = /contract, grounded-LLM-follows-skill,
// one backend chat-over-skills endpoint." Pure + deterministic — no live DB/LLM.

const FIXTURE: SkillManifest = makeSkill();

// ── Gap 1: a skill IS a /contract (one object, two views) ──────────────────
test("skillToContract projects a skill into the /contract tree (child per endpoint)", () => {
  const contract = skillToContract(FIXTURE);
  // root is a real contract node
  expect(contract.prompt).toContain("search acme products");
  expect(contract.prompt).toContain("acme.com");
  expect(contract.wallet_identity).toBe("agent_owner_9");          // skill owner = contract wallet
  expect(Array.isArray(contract.evaluators)).toBe(true);
  expect(contract.evaluators.length).toBeGreaterThan(0);
  // one child contract per endpoint, each with its typed execute pointer
  expect(contract.children.length).toBe(2);
  expect(contract.children[0].posthook_pointer).toBe(endpointContractPointer("skill_acme_123", "ep_search"));
  expect(contract.children[1].posthook_pointer).toBe(endpointContractPointer("skill_acme_123", "ep_detail"));
  // evaluators are honest — derived from the real EndpointDescriptor fields
  expect(contract.children[0].evaluators[0].metric.assertion).toContain("verified");
  expect(contract.children[0].evaluators[0].metric.assertion).toContain("0.91");
  // deterministic / content-addressable: same skill → same contract
  expect(JSON.stringify(skillToContract(FIXTURE))).toBe(JSON.stringify(contract));
});

test("skillToContract drops endpoints with no id (no execute pointer = not a real child)", () => {
  const skill = { ...FIXTURE, endpoints: [...FIXTURE.endpoints, { method: "GET", url_template: "https://x" }] } as unknown as SkillManifest;
  expect(skillToContract(skill).children.length).toBe(2);
});

// ── Gap 2: the grounded LLM is constrained to follow the skill ──────────────
test("chatFollowingSkill grounds the LLM on the skill's SKILL.md and returns its answer", async () => {
  let captured: { system: string; user: string } | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
    const parsed = JSON.parse(String(init.body));
    captured = {
      system: parsed.messages.find((m: { role: string }) => m.role === "system").content,
      user: parsed.messages.find((m: { role: string }) => m.role === "user").content,
    };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Use ep_search: GET https://acme.com/api/search?q=widget" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const env = { UNBROWSE_LLM_API_KEY: "k" } as never;
    const answer = await chatFollowingSkill(env, FIXTURE, "find me a widget");
    expect(answer).toContain("ep_search");
    // the grounding system prompt carries the skill's real instructions + the only-act-through rule
    expect(captured!.system).toContain("ONLY act through the skill");
    expect(captured!.system).toContain("acme.com");          // renderSkillMd embedded the skill
    expect(captured!.system).toContain("ep_search");
    expect(captured!.user).toBe("find me a widget");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("chatFollowingSkill fails closed with no LLM key (null, never fabricated)", async () => {
  const answer = await chatFollowingSkill({} as never, FIXTURE, "hi");
  expect(answer).toBeNull();
});

// ── Gap 3: one backend loop — resolve → contract → follow → answer+provenance ─
test("runSkillChat welds resolve + contract + follow into one answer with provenance", async () => {
  const calls: string[] = [];
  const deps: SkillChatDeps = {
    resolveSkill: async (intent) => {
      calls.push(`resolve:${intent}`);
      return { skill: FIXTURE, via: "semantic" };
    },
    chat: async (skill, message) => {
      calls.push(`chat:${skill.skill_id}:${message}`);
      return "Use ep_search to find widgets.";
    },
  };
  const result = await runSkillChat(deps, { message: "find a widget" });
  expect(result.answer).toContain("ep_search");
  expect(result.skill_id).toBe("skill_acme_123");
  expect(result.domain).toBe("acme.com");
  expect(result.resolved_by).toBe("semantic");
  // provenance: the answer carries the resolved skill AS a /contract (Gap 1 inside Gap 3)
  expect(result.contract.children.length).toBe(2);
  expect(result.contract.children[0].posthook_pointer).toContain("skill_acme_123");
  // the loop actually ran resolve → chat in order
  expect(calls).toEqual(["resolve:find a widget", "chat:skill_acme_123:find a widget"]);
});

// audit A6 repair witnesses: wallet redaction + message size cap
test("runSkillChat redacts owner wallet_identity from the response contract", async () => {
  const deps: SkillChatDeps = {
    resolveSkill: async () => ({ skill: FIXTURE, via: "semantic" }),   // FIXTURE.owner_agent_id set
    chat: async () => "ok",
  };
  const result = await runSkillChat(deps, { message: "hi" });
  expect(result.contract.wallet_identity).toBeUndefined();              // stripped from the response
  result.contract.children.forEach((ch) => expect(ch.wallet_identity).toBeUndefined());
});

test("runSkillChat rejects an oversized message (400) before any LLM call", async () => {
  let chatCalled = false;
  const deps: SkillChatDeps = {
    resolveSkill: async () => ({ skill: FIXTURE, via: "semantic" }),
    chat: async () => { chatCalled = true; return "ok"; },
  };
  await expect(
    runSkillChat(deps, { message: "x".repeat(8_001) }),
  ).rejects.toMatchObject({ code: "message_too_long", status: 400 });
  expect(chatCalled).toBe(false);                                       // never reached the priced LLM
});

test("runSkillChat 404s when no skill resolves, 503s when the LLM has no key", async () => {
  await expect(
    runSkillChat({ resolveSkill: async () => null, chat: async () => "x" }, { message: "x" }),
  ).rejects.toMatchObject({ code: "no_skill", status: 404 });
  await expect(
    runSkillChat({ resolveSkill: async () => ({ skill: FIXTURE, via: "domain" }), chat: async () => null }, { message: "x" }),
  ).rejects.toMatchObject({ code: "llm_unavailable", status: 503 });
});
