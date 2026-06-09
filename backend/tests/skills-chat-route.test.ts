import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { makeSkill } from "./fixtures/skill";
import { parseEndpointPointer } from "../src/services/skill-contract";

// Real POST /skills/chat exercised end-to-end. The data/LLM/ledger leaves are faked
// so it runs hermetically; the route's own resolve→ground→follow→answer→persist
// wiring is REAL. mock.module mutates the global registry — restore after this file
// so the mocks don't leak into siblings (Layer 1's real chatFollowingSkill, the compiler).
afterAll(() => mock.restore());

// Single-endpoint skill so the happy-path provenance assertion is exact (1 child).
const FIXTURE = makeSkill({ endpoints: [
  { endpoint_id: "ep_search", method: "GET", url_template: "https://acme.com/api/search?q={q}", description: "Search", reliability_score: 0.91, verification_status: "verified" },
] as never });

// Shared ledger so a test can read back what the write-side persisted.
const sharedRows: Array<Record<string, unknown>> = [];
// handleDeclare is a reconfigurable mock; its default writes the parent row.
const declareMock = mock(async (req: { plan?: string; action?: string }, ledger?: { append: (r: unknown) => Promise<unknown> }) => {
  if (ledger?.append) await ledger.append({ event: "declared", id: "parent_x", ts: "", plan: req?.plan, action: req?.action, visibility: "lineage" });
  return { id: "parent_x" };
});

mock.module("../src/routes/contract", () => ({
  handleDeclare: declareMock,
  ledgerForRequest: () => ({
    rows: sharedRows,
    append: async (r: Record<string, unknown>) => { sharedRows.push(r); return r; },
    get: async () => null, listAll: async () => sharedRows, listChildren: async () => [],
  }),
}));
mock.module("../src/services/discovery", () => ({
  searchIntent: async () => [{ id: 1, score: 1, metadata: { skill_id: "skill_acme_123" } }],
}));
mock.module("../src/services/marketplace", () => ({
  getSkill: async () => FIXTURE, getSkillByDomain: async () => FIXTURE,
}));
mock.module("../src/services/unbrowse-llm", () => ({
  chatFollowingSkill: async () => "Use ep_search to find widgets.",
}));
// optionalAuth sets agent_id from a test header so we can drive both the
// authenticated lane (serve) and the anonymous lane (x402 402). rate-limit is
// a passthrough in tests (no KV).
mock.module("../src/middleware/auth", () => ({
  optionalAuth: async (c: { req: { header: (k: string) => string | undefined }; set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    const a = c.req.header("x-test-agent");
    if (a) c.set("agent_id", a);
    await next();
  },
}));
mock.module("../src/middleware/rate-limit", () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

const { skillChatRoutes } = await import("../src/routes/skills-chat");

function app() { const a = new Hono(); a.route("/v1", skillChatRoutes); return a; }
// default: authenticated (x-test-agent) so the existing tests exercise the serve lane
async function post(a: Hono, body: unknown, opts: { auth?: boolean; env?: Record<string, unknown> } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth !== false) headers["x-test-agent"] = "test-agent";
  return a.request(
    "/v1/skills/chat",
    { method: "POST", headers, body: JSON.stringify(body) },
    (opts.env ?? {}) as never,
  );
}
const settle = () => new Promise((r) => setTimeout(r, 25)); // let the fire-and-forget persist finish

beforeEach(() => {
  sharedRows.length = 0;
  declareMock.mockImplementation(async (req: { plan?: string; action?: string }, ledger?: { append: (r: unknown) => Promise<unknown> }) => {
    if (ledger?.append) await ledger.append({ event: "declared", id: "parent_x", ts: "", plan: req?.plan, action: req?.action, visibility: "lineage" });
    return { id: "parent_x" };
  });
});

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
  expect(declareMock).toHaveBeenCalled();                    // write-side actually fired
});

test("STORM: persist (handleDeclare) throws → answer still returns 200, no leak", async () => {
  declareMock.mockImplementation(async () => { throw new Error("ledger down — storm"); });
  const res = await post(app(), { message: "find a widget" });
  expect(res.status).toBe(200);                              // house fell not
  const json = await res.json();
  expect(json.answer).toContain("ep_search");
  expect(json.error).toBeUndefined();
  await settle();
});

// ── DOMINION (step 6): one flow drives every seam, incl. persist + read-back ──
// HONEST SCOPE (audit A7): the data/LLM/ledger LEAVES are mocked — this exercises the
// real route + real skillToContract + real persist-orchestration + real parseEndpointPointer
// WIRED together, not the live DAG/LLM/KV. True end-to-end against a live Worker is
// criterion 5 (deferred, deploy-gated). This is the wired-orchestration witness.
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
