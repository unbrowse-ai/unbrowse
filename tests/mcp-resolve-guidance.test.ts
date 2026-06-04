import { describe, expect, test } from "bun:test";
import { addResolveMissGuidance } from "../src/mcp.js";

describe("addResolveMissGuidance", () => {
  test("adds browser-first next steps on cache miss", () => {
    const guided = addResolveMissGuidance(
      {
        result: {
          status: "no_cached_match",
          message: "No cached endpoint matched this intent yet.",
          url: "https://libgen.im/",
        },
      },
      {
        intent: "search for a book on libgen",
        url: "https://libgen.im/",
      },
    );

    const result = guided.result as Record<string, unknown>;
    expect(result.next_step).toBeString();
    expect(String(result.next_step)).toContain("unbrowse_go");
    expect(String(result.next_step)).toContain("unbrowse_publish");
    expect(result.discovery_mode).toBe("browser_first");
    expect(result.resolve_mode).toBe("cache_only");
    expect(result.relevant_options).toEqual([
      {
        mode: "browse_only",
        when: "You just need to inspect or manually use the live site right now.",
        next_tools: [
          "unbrowse_go",
          "unbrowse_snap",
          "unbrowse_click/unbrowse_fill/unbrowse_select/unbrowse_eval",
        ],
      },
      {
        mode: "capture_for_reuse",
        when: "You want Unbrowse to learn the site and turn the workflow into a reusable contract.",
        next_tools: [
          "unbrowse_go",
          "unbrowse_snap",
          "unbrowse_click/unbrowse_fill/unbrowse_select/unbrowse_eval",
          "unbrowse_submit",
          "unbrowse_sync or unbrowse_close",
          "unbrowse_skill or unbrowse_publish",
          "unbrowse_review",
          "unbrowse_publish",
        ],
      },
      {
        mode: "auth_then_retry",
        when: "The site is gated and the browser flow needs a logged-in session first.",
        next_tools: [
          "unbrowse_auth_capture",
          "unbrowse_go",
          "unbrowse_snap",
        ],
      },
    ]);
    expect(result.suggested_tool_sequence).toEqual([
      "unbrowse_go",
      "unbrowse_snap",
      "unbrowse_click/unbrowse_fill/unbrowse_select/unbrowse_eval",
      "unbrowse_submit",
      "unbrowse_sync or unbrowse_close",
      "unbrowse_skill or unbrowse_publish",
      "unbrowse_review",
      "unbrowse_publish",
    ]);
  });

  test("leaves non-miss resolve results unchanged", () => {
    const original = {
      result: {
        available_endpoints: [{ endpoint_id: "ep-1" }],
      },
    };

    expect(addResolveMissGuidance(original, { intent: "get timeline" })).toEqual(original);
  });
});
