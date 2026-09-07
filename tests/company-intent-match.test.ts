import { describe, expect, it } from "bun:test";
import { assessIntentResult } from "../src/intent-match.js";

describe("company intent matching", () => {
  it("accepts company-like payloads for company info", () => {
    const result = assessIntentResult({
      included: [
        {
          name: "OpenAI",
          universalName: "openai",
          description: "AI research and deployment company",
          industry: "Research",
          staffCount: 4000,
          websiteUrl: "https://openai.com",
        },
      ],
    }, "get company info");

    expect(result.verdict).toBe("pass");
  });

  it("rejects mailbox metadata for company info", () => {
    const result = assessIntentResult({
      data: {
        elements: [{ mailboxId: "abc", unreadCount: 3 }],
        metadata: { q: "admin" },
      },
    }, "get company info");

    expect(result.verdict).toBe("skip");
  });
});
