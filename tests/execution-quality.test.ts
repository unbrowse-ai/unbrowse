import { describe, expect, it } from "bun:test";
import { validateExtractionQuality } from "../src/execution/index.js";

describe("execution quality gate", () => {
  it("rejects DOM fallback nav chrome for structured search intents", () => {
    const quality = validateExtractionQuality([
      "Code results Repositories Issues Pull requests Discussions More",
      "Languages Python JavaScript TypeScript More languages",
      "Advanced Owner Number of followers Number of forks Number of stars Date created Date pushed",
      "Advanced search",
    ], 0.5, "search repositories");

    expect(quality.valid).toBe(false);
    expect(quality.quality_note).toContain("structured");
  });

  it("accepts structured repository rows for repository search intents", () => {
    const quality = validateExtractionQuality([
      {
        full_name: "openai/openai-node",
        description: "Official OpenAI Node SDK",
        stargazers_count: 10000,
        language: "TypeScript",
      },
      {
        full_name: "openai/openai-python",
        description: "Official OpenAI Python SDK",
        stargazers_count: 25000,
        language: "Python",
      },
    ], 0.9, "search repositories");

    expect(quality.valid).toBe(true);
  });
});
