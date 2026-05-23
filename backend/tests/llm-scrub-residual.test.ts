// FALSIFIER for the LLM-layer PII scrubber (contract 101b1f77).
//
// Proves that the LLM scrub pass catches PII the regex layer misses.
// Construction:
//   1. An endpoint whose `description_out` contains a plausible
//      real-shaped string the regex misses — a US phone number written
//      hyphenated ("+1-415-555-0123"). The regex PHONE_PATTERN in
//      publish-sanitize.ts only fires on JSON values traversed by
//      sanitizeAgentVisibleValue / synthesizeExample; free-text
//      `semantic.description_out` is NOT walked by that path, so the
//      regex layer ships it unchanged.
//   2. We run the endpoint through `enforcePublishSanitization` first
//      and assert the phone string survives (regex misses it).
//   3. We then run it through `aiScrubEndpoints` and assert the LLM
//      catches it (rejected: true, reasons populated, textual field
//      wiped to a structural placeholder).
//
// No mocks (contract 4305eae2). Hits the real Nebius endpoint with the
// live key. If NEBIUS_API_KEY is not set in the test env, we log a
// clear SKIP message and return early so the suite stays green.

import { describe, expect, it } from "bun:test";
import {
  enforcePublishSanitization,
  type SanitizableEndpoint,
} from "../src/services/publish-sanitize.js";
import { aiScrubEndpoints } from "../src/services/ai-scrub.js";
import type { Env } from "../src/types.js";

const REAL_SHAPED_PHONE = "+1-415-555-0123";
const PROSE_LEAK =
  `This API returns the user's home phone ${REAL_SHAPED_PHONE} in the response payload.`;

function buildFixture(): SanitizableEndpoint {
  return {
    endpoint_id: "ep-phone-leak",
    method: "GET",
    url_template: "https://api.example.com/users/{id}",
    description: "Returns user profile",
    semantic: {
      action_kind: "get",
      resource_kind: "user_profile",
      description_out: PROSE_LEAK,
      example_response_compact: { id: 12345, name: "example-value" },
      requires: [],
      provides: [],
    },
  };
}

describe("llm-scrub-residual: LLM catches PII the regex layer misses", () => {
  it("regex scrubber MISSES the prose phone leak, LLM scrubber CATCHES it", async () => {
    const fixture = buildFixture();

    // Phase 1: regex layer. The phone string lives inside
    // semantic.description_out which is free text — sanitizeForPublish
    // does NOT replace strings inside semantic.description_out, so the
    // leak survives. Establish that baseline first.
    const { endpoints: regexScrubbed } = enforcePublishSanitization([fixture]);
    expect(regexScrubbed.length).toBe(1);
    const regexSemantic = regexScrubbed[0]!.semantic as { description_out?: string } | undefined;
    expect(typeof regexSemantic?.description_out).toBe("string");
    expect(regexSemantic!.description_out).toContain(REAL_SHAPED_PHONE);

    // Phase 2: LLM scrub layer. If no key, skip cleanly.
    const apiKey = process.env.NEBIUS_API_KEY ?? "";
    if (!apiKey) {
      console.log(
        "[llm-scrub-residual] SKIP: NEBIUS_API_KEY not set in test env. " +
        "The regex-miss assertion above already proves the gap; the LLM " +
        "catch is exercised in deploy/prod where the secret is wired.",
      );
      return;
    }

    const env = {
      NEBIUS_API_KEY: apiKey,
      UNBROWSE_AI_SCRUB_MODEL:
        process.env.UNBROWSE_AI_SCRUB_MODEL ?? "moonshotai/Kimi-K2.5",
    } as unknown as Env;

    const ai = await aiScrubEndpoints(regexScrubbed, env);

    // Live API: assert the LLM either flagged the leak (preferred) or, if
    // it soft-failed for transient reasons, log a clear gap rather than
    // pretend the green is real (contract 68e08f1b honest data or honest
    // gap). Soft-fail surfaces in `reasons` starting with `llm_call_failed_`
    // or `llm_error:`; rejected stays false there.
    if (!ai.rejected) {
      const transientReasons = ai.reasons.filter(
        (r) => r.startsWith("llm_call_failed_") || r.startsWith("llm_error:") || r === "nebius_key_unset",
      );
      if (transientReasons.length > 0) {
        console.log(
          `[llm-scrub-residual] SOFT-FAIL: LLM call returned transiently. reasons=${JSON.stringify(ai.reasons)}. ` +
            "Skipping strong assertion; rerun when the model is reachable.",
        );
        return;
      }
      throw new Error(
        `LLM scrubber did NOT flag a real-shaped phone in prose. ` +
          `endpoints=${JSON.stringify(ai.endpoints)} reasons=${JSON.stringify(ai.reasons)}`,
      );
    }

    expect(ai.rejected).toBe(true);
    expect(ai.scrubbed).toBe(true);
    expect(ai.llm_residual).toBeGreaterThan(0);
    expect(ai.reasons.length).toBeGreaterThan(0);

    // The flagged endpoint's description_out should have been wiped to
    // a structural placeholder; the literal phone string MUST NOT be
    // present any more.
    const aiSemantic = ai.endpoints[0]!.semantic as { description_out?: string } | undefined;
    expect(typeof aiSemantic?.description_out).toBe("string");
    expect(aiSemantic!.description_out).not.toContain(REAL_SHAPED_PHONE);
    expect(aiSemantic!.description_out).toMatch(/^\[scrubbed:/);
  }, 30000);
});
