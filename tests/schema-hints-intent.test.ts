import { describe, expect, it } from "bun:test";
import { generateExtractionHints } from "../src/transform/schema-hints.js";
import type { ResponseSchema } from "../src/types/index.js";

describe("intent-aware extraction hints", () => {
  it("prefers statuses over accounts for post search intents", () => {
    const schema: ResponseSchema = {
      type: "object",
      inferred_from_samples: 1,
      properties: {
        accounts: {
          type: "array",
          inferred_from_samples: 1,
          items: {
            type: "object",
            inferred_from_samples: 1,
            properties: {
              id: { type: "string", inferred_from_samples: 1 },
              username: { type: "string", inferred_from_samples: 1 },
              display_name: { type: "string", inferred_from_samples: 1 },
            },
          },
        },
        statuses: {
          type: "array",
          inferred_from_samples: 1,
          items: {
            type: "object",
            inferred_from_samples: 1,
            properties: {
              id: { type: "string", inferred_from_samples: 1 },
              content: { type: "string", inferred_from_samples: 1 },
              created_at: { type: "string", inferred_from_samples: 1 },
              url: { type: "string", inferred_from_samples: 1 },
              replies_count: { type: "integer", inferred_from_samples: 1 },
            },
          },
        },
      },
    };

    const hint = generateExtractionHints(schema, "search posts");
    expect(hint?.path).toBe("statuses[]");
    expect(hint?.fields).toContain("content");
  });

  it("prefers repository-like arrays for repository search intents", () => {
    const schema: ResponseSchema = {
      type: "object",
      inferred_from_samples: 1,
      properties: {
        data: {
          type: "array",
          inferred_from_samples: 1,
          items: {
            type: "object",
            inferred_from_samples: 1,
            properties: {
              link: { type: "string", inferred_from_samples: 1 },
              title: { type: "string", inferred_from_samples: 1 },
            },
          },
        },
        repositories: {
          type: "array",
          inferred_from_samples: 1,
          items: {
            type: "object",
            inferred_from_samples: 1,
            properties: {
              full_name: { type: "string", inferred_from_samples: 1 },
              description: { type: "string", inferred_from_samples: 1 },
              stargazers_count: { type: "integer", inferred_from_samples: 1 },
              language: { type: "string", inferred_from_samples: 1 },
            },
          },
        },
      },
    };

    const hint = generateExtractionHints(schema, "search repositories");
    expect(hint?.path).toBe("repositories[]");
    expect(hint?.fields).toContain("full_name");
  });

  it("prefers sparse statuses arrays over rich accounts arrays for post intents", () => {
    const schema: ResponseSchema = {
      type: "object",
      inferred_from_samples: 1,
      properties: {
        accounts: {
          type: "array",
          inferred_from_samples: 1,
          items: {
            type: "object",
            inferred_from_samples: 1,
            properties: {
              id: { type: "string", inferred_from_samples: 1 },
              username: { type: "string", inferred_from_samples: 1 },
              display_name: { type: "string", inferred_from_samples: 1 },
            },
          },
        },
        statuses: {
          type: "array",
          inferred_from_samples: 1,
        },
      },
    };

    const hint = generateExtractionHints(schema, "search posts");
    expect(hint?.path).toBe("statuses[]");
    expect(hint?.fields).toEqual([]);
  });
});
