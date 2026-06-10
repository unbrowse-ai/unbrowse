import { test, expect, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { makeSkill } from "./fixtures/skill";
import { parseEndpointPointer } from "../src/services/skill-contract";
import { skillToContract } from "../src/services/skill-contract";
import { persistSkillContract } from "../src/services/skill-contract-persist";
import {
  skillChatRoutes,
  setSkillChatDeps,
  type SkillChatDeps,
  type SkillChatResult,
} from "../src/routes/skills-chat";

// ──────────────────────────────────────────────────────────────────────────
// DEPENDENCY INJECTION, not mock.module.
//
// Bun's `mock.module` mutates a GLOBAL registry and CANNOT replace a module that
// a sibling test already imported/evaluated. skills-publish-proofs imports `app`
// (→ skills-chat.ts → the REAL unbrowse-llm/marketplace/discovery/contract), so
// any `mock.module(...)` here lands too late and the route runs the real
// chatFollowingSkill → no Nebius key → 503. The race is order-independent and
// un-fixable from this file.
//
// The robust seam is DI: the route exports `setSkillChatDeps(factory)` (defaults
// to liveDeps, production unchanged). We inject a hermetic stub for the read-side
// (resolveSkill/chat/recommend*/persistSkill) and drive the route over REAL
// optionalAuth (Bearer <API_KEY> → agent_id) + REAL in-memory rateLimit. No
// global module registry is touched, so nothing leaks into siblings.
// ──────────────────────────────────────────────────────────────────────────

// Single-endpoint skill so the happy-path provenance assertion is exact (1 child).
const FIXTURE = makeSkill({ endpoints: [
  { endpoint_id: "ep_search", method: "GET", url_template: "https://acme.com/api/search?q={q}", description: "Search", reliability_score: 0.91, verification_status: "verified" },
] as never });

// Shared ledger so a test can read back what the write-side persisted.
const sharedRows: Array<Record<string, unknown>> = [];
// Toggle: when set, persistSkill throws (the STORM case) — proves the answer
// still returns 200 even when the write-side blows up.
let persistThrows = false;

// In-memory ledger + declare wiring — the SAME shape the route's liveDeps builds
// against handleDeclare/ledgerForRequest, but hermetic (no KV, no network).
function makeLedger() {
  return {
    rows: sharedRows,
    append: async (r: Record<string, unknown>) => { sharedRows.push(r); return r; },
    get: async () => null,
    listAll: async () => sharedRows,
    listChildren: async () => [],
  };
}

// The injected deps stub. Mirrors liveDeps' contract exactly:
//   resolveSkill → the fixture (semantic), chat → grounded answer,
//   persistSkill → real persistSkillContract over the in-memory ledger so the
//   resolve→contract→persist→read-back provenance is exercised end-to-end.
function stubDeps(): SkillChatDeps {
  return {
    resolveSkill: async () => ({ skill: FIXTURE, via: "semantic" as const }),
    chat: async () => "Use ep_search to find widgets.",
    persistSkill: async (result: SkillChatResult) => {
      if (persistThrows) throw new Error("ledger down — storm");
      const ledger = makeLedger();
      await persistSkillContract(
        {
          ledger,
          declareParent: async (req) => {
            await ledger.append({ event: "declared", id: "parent_x", ts: "", plan: req.plan, action: req.action, visibility: "lineage" });
            return "parent_x";
          },
        },
        FIXTURE,
      );
      void result;
    },
  };
}

beforeEach(() => {
  sharedRows.length = 0;
  persistThrows = false;
  setSkillChatDeps(stubDeps);
});

afterAll(() => {
  setSkillChatDeps(null); // restore live wiring — nothing leaks into siblings
});

function app() { const a = new Hono(); a.route("/v1", skillChatRoutes); return a; }
// default: authenticated (Bearer admin == API_KEY) so the existing tests exercise
// the serve lane via REAL optionalAuth (sets agent_id="__admin__").
async function post(a: Hono, body: unknown, opts: { auth?: boolean; env?: Record<string, unknown> } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth !== false) headers["Authorization"] = "Bearer admin";
  const env = { API_KEY: "admin", ...(opts.env ?? {}) };
  return a.request(
    "/v1/skills/chat",
    { method: "POST", headers, body: JSON.stringify(body) },
    env as never,
  );
}
const settle = () => new Promise((r) => setTimeout(r, 25)); // let the fire-and-forget persist finish

// audit A6 repair: anonymous callers must pay (x402) for the priced LLM call.
test("x402 gate: anonymous + no payment → 402 with Flex terms", async () => {
  const res = await post(app(), { message: "find a widget" }, { auth: false, env: { PAYMENT_RECIPIENT: "wallet_abc" } });
  expect(res.status).toBe(402);
  const json = await res.json();
  expect(json.error).toBe("payment_required");
  expect(json.accepts?.[0]?.scheme).toBe("exact");        // Flex/x402 terms emitted
  expect(json.accepts?.[0]?.payTo).toBe("wallet_abc");
});

test("happy path: 200 with grounded answer + skill-contract provenance", async () => {
  const res = await post(app(), { message: "find a widget" });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.answer).toContain("ep_search");
  expect(json.skill_id).toBe("skill_acme_123");
  expect(json.contract.children.length).toBe(1);             // provenance: skill viewed as /contract
  await settle();
  expect(sharedRows.length).toBeGreaterThan(0);              // write-side actually fired
});

test("STORM: persist (persistSkill) throws → answer still returns 200, no leak", async () => {
  persistThrows = true;
  const res = await post(app(), { message: "find a widget" });
  expect(res.status).toBe(200);                              // house fell not
  const json = await res.json();
  expect(json.answer).toContain("ep_search");
  expect(json.error).toBeUndefined();
  await settle();
});

// ── DOMINION (step 6): one flow drives every seam, incl. persist + read-back ──
// HONEST SCOPE (audit A7): the data/LLM/ledger LEAVES are INJECTED — this exercises
// the real route + real skillToContract + real persist-orchestration + real
// parseEndpointPointer WIRED together, not the live DAG/LLM/KV. True end-to-end
// against a live Worker is criterion 5 (deferred, deploy-gated). This is the
// wired-orchestration witness.
test("wired-orchestration: resolve → ground → follow → answer → persist → read-back recovers the endpoint", async () => {
  const res = await post(app(), { message: "find a widget" });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.answer).toContain("ep_search");                // grounded LLM followed the skill
  await settle();                                            // write-side persisted

  // the ledger now holds the parent + one child contract row
  expect(sharedRows.length).toBe(2);
  const parent = sharedRows[0], child = sharedRows[1];
  expect(parent.action).toBe("contract:skill/skill_acme_123");

  // read-back: the persisted child pointer recovers the exact endpoint it executes
  const parsed = parseEndpointPointer(child.action as string);
  expect(parsed).toEqual({ skillId: "skill_acme_123", endpointId: "ep_search" });
  const recovered = FIXTURE.endpoints.find((e) => e.endpoint_id === parsed!.endpointId);
  expect(recovered?.url_template).toBe("https://acme.com/api/search?q={q}");  // the loop closes
});

// Pure-orchestrator witness: the resolve→contract→follow→answer loop with no HTTP,
// no middleware, no global registry — exactly the seam the route wires. Proves the
// provenance contract is built directly from the resolved skill.
test("runSkillChat (pure): resolve → contract → follow → answer carries skill-as-contract provenance", async () => {
  const { runSkillChat } = await import("../src/routes/skills-chat");
  const result = await runSkillChat(stubDeps(), { message: "find a widget" });
  expect(result.answer).toContain("ep_search");
  expect(result.skill_id).toBe("skill_acme_123");
  expect(result.resolved_by).toBe("semantic");
  // contract provenance equals the real skillToContract projection (sans owner wallet)
  expect(result.contract.children.length).toBe(skillToContract(FIXTURE).children.length);
});
