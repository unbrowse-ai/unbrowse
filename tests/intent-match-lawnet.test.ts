import { describe, expect, it } from "bun:test";
import { assessIntentResult } from "../src/intent-match.js";
import { assessLocalExecutionResult } from "../src/orchestrator/index.js";

describe("intent match for LawNet case rows", () => {
  it("accepts legal case search rows as valid search results", () => {
    const result = assessIntentResult(
      [
        {
          title: "Lai Wai Keong Eugene v Loo Wei Yen - [2013] 3 SLR 1113",
          case_name: "Lai Wai Keong Eugene v Loo Wei Yen",
          citation: "[2013] 3 SLR 1113",
          court: "High Court",
          decision_date: "28 June 2013",
          case_number: "Suit No 727 of 2009 (Registrar's Appeal No 273 of 2012)",
          catchword: "Damages , Damages , Damages",
        },
      ],
      "search leave adduce evidence late stage assessment damages mediation high court case started tranches",
    );

    expect(result.verdict).toBe("pass");
    expect(result.reason).toBe("search_rows");
  });

  it("treats non-empty structured search arrays as acceptable local execution results", () => {
    const verdict = assessLocalExecutionResult(
      {
        endpoint_id: "duk",
        method: "POST",
        url_template: "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        response_schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
          },
        } as any,
      } as any,
      [
        {
          title: "Lai Wai Keong Eugene v Loo Wei Yen - [2013] 3 SLR 1113",
          case_name: "Lai Wai Keong Eugene v Loo Wei Yen",
          citation: "[2013] 3 SLR 1113",
          court: "High Court",
        },
      ],
      "search leave adduce evidence late stage assessment damages mediation high court case started tranches",
    );

    expect(verdict).toEqual({ verdict: "pass", reason: "search_result_rows" });
  });
});
