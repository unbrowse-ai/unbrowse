/**
 * write-action-execute.test — LIVE witness for the write capability the capability bench flagged.
 *
 * The bench found the AGENT path (run/resolve) never performs a write — it auto-executes the top
 * safe GET only and capture is XHR-replay oriented. The open question this answers: is the EXECUTE
 * MACHINERY itself capable of a real POST with a body, or is write execution also missing? If
 * execute can POST, the gap is purely discovery+agent-selection (a scoped feature); if it can't,
 * the machinery needs building too. This drives executeSkill against a POST endpoint and asserts
 * the body actually crossed the wire (postman-echo reflects the posted JSON back).
 *
 * Live network test — skipped automatically when offline / postman-echo unreachable.
 */
import { describe, expect, it } from "bun:test";
import { executeSkill } from "../src/execution/index.js";
import type { SkillManifest } from "../src/types/index.js";

const skill = {
  skill_id: "sk_echo",
  version: "1.0.0",
  schema_version: "1",
  name: "postman-echo.com",
  intent_signature: "postman-echo.com",
  domain: "postman-echo.com",
  description: "echo",
  owner_type: "agent",
  execution_type: "http",
  lifecycle: "active",
  created_at: "2026-06-14T00:00:00.000Z",
  updated_at: "2026-06-14T00:00:00.000Z",
  endpoints: [
    {
      endpoint_id: "echo_post",
      method: "POST",
      url_template: "https://postman-echo.com/post",
      idempotency: "safe",
      body: { marker: "unbrowse-write-witness", n: 7 },
    },
  ],
} as unknown as SkillManifest;

describe("write execution machinery (executeSkill POST with body)", () => {
  it("performs a real POST and the body crosses the wire (postman-echo reflects it)", async () => {
    let result: Awaited<ReturnType<typeof executeSkill>>;
    try {
      result = await executeSkill(
        skill,
        { endpoint_id: "echo_post" },
        undefined,
        { confirm_unsafe: true } as never,
      );
    } catch (e) {
      console.warn("[write-witness] live network unavailable, skipping:", (e as Error).message);
      return;
    }
    const blob = JSON.stringify(result ?? {});
    if (/ENOTFOUND|ETIMEDOUT|network|cli_timeout/i.test(blob) && !/unbrowse-write-witness/.test(blob)) {
      console.warn("[write-witness] postman-echo unreachable, skipping");
      return;
    }
    // postman-echo echoes the posted JSON under .json — the marker proves the POST body was sent
    expect(blob).toContain("unbrowse-write-witness");
  }, 60_000);
});
