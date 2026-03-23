import { describe, expect, test } from "bun:test";
import { assessLocalExecutionResult } from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types/index.js";

const searchEndpoint = {
  endpoint_id: "duk",
  method: "POST",
  url_template: "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
  idempotency: "safe",
  verification_status: "verified",
  reliability_score: 0.7,
  description: "Searches documents with title, heading_1",
  response_schema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        title: { type: "string" },
      },
    },
  },
  dom_extraction: {
    extraction_method: "repeated-elements",
    confidence: 0.9,
    selector: "div.results",
  },
  semantic: {
    action_kind: "search",
    resource_kind: "document",
    description_out: "Searches documents with title, heading_1",
  },
} as SkillManifest["endpoints"][number];

describe("assessLocalExecutionResult", () => {
  test("rejects search homepage/auth bounces for array-shaped endpoints", () => {
    const verdict = assessLocalExecutionResult(
      searchEndpoint,
      {
        title: "About LawNet Legal Research",
        link: "/lawnet/web/lawnet/about-lawnet/what-is-lawnet/general",
        url: "/lawnet/web/lawnet/about-lawnet/what-is-lawnet/general",
        description: "LawNet Legal Research is a one-stop practice portal.",
      },
      "search for high court case assessment of damages new evidence adduced after tranches started",
      {
        trace_id: "trace-1",
        skill_id: "lawnet",
        endpoint_id: "duk",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        success: true,
        result: {
          _extraction: {
            final_url: "https://www.lawnet.sg/lawnet/web/lawnet/home",
          },
        },
      },
    );

    expect(verdict.verdict).toBe("fail");
    expect(verdict.reason).toBe("search_auth_or_homepage_bounce");
  });

  test("keeps real repeated search rows as pass", () => {
    const verdict = assessLocalExecutionResult(
      searchEndpoint,
      [
        {
          title: "Lai Wai Keong Eugene v Loo Wei Yen - [2013] 3 SLR 1113",
          link: "https://www.lawnet.sg/lawnet/group/lawnet/some-case",
          description: "Assessment of damages appeal involving further evidence.",
        },
      ],
      "search for high court case assessment of damages new evidence adduced after tranches started",
    );

    expect(verdict.verdict).toBe("pass");
  });
});
