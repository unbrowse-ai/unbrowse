import { describe, expect, it } from "bun:test";
import { materializeRealWorldCase } from "../evals/real-world-cases.js";

describe("linkedin company real-world case", () => {
  it("uses the about page for company info", () => {
    const out = materializeRealWorldCase({
      id: "linkedin-company",
      domain: "linkedin.com",
      url: "https://www.linkedin.com",
      intent: "get company info",
      auth: true,
      expected_fields: ["name", "description"],
    });

    expect(out?.url).toBe("https://www.linkedin.com/company/openai/about/");
  });
});
