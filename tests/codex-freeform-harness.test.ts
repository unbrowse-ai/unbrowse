import { describe, expect, it } from "bun:test";
import { pickFreeformFollowUpUrl } from "../evals/codex-harness-lib.js";

describe("codex freeform harness helpers", () => {
  it("prefers deeper trigger urls from templated api endpoints", () => {
    const nextUrl = pickFreeformFollowUpUrl(
      "https://practice.expandtesting.com/notes/app",
      [
        {
          endpoint_id: "note-detail",
          url: "https://practice.expandtesting.com/notes/api/notes/{note}",
          trigger_url: "https://practice.expandtesting.com/notes/app/notes/69b36af414ccdb029563b207",
          score: 42,
        },
        {
          endpoint_id: "list",
          url: "https://practice.expandtesting.com/notes/api/notes",
          trigger_url: "https://practice.expandtesting.com/notes/app",
          score: 60,
        },
      ],
      ["https://practice.expandtesting.com/notes/app"],
    );

    expect(nextUrl).toBe("https://practice.expandtesting.com/notes/app/notes/69b36af414ccdb029563b207");
  });

  it("ignores visited or junk follow-up urls", () => {
    const nextUrl = pickFreeformFollowUpUrl(
      "https://practice.expandtesting.com/notes/app",
      [
        {
          endpoint_id: "junk",
          url: "https://practice.expandtesting.com/notes/api/notes/{note}",
          trigger_url: "https://practice.expandtesting.com/notes/app#google_vignette",
          score: 100,
        },
        {
          endpoint_id: "visited",
          url: "https://practice.expandtesting.com/notes/api/notes/{note}",
          trigger_url: "https://practice.expandtesting.com/notes/app/notes/123",
          score: 100,
        },
      ],
      [
        "https://practice.expandtesting.com/notes/app",
        "https://practice.expandtesting.com/notes/app/notes/123",
      ],
    );

    expect(nextUrl).toBeNull();
  });
});
