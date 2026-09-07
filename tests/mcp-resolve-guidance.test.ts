import { describe, expect, test } from "bun:test";


// Protocol/operator tests need the full MCP catalog (agent surface is default).
process.env.UNBROWSE_MCP_SURFACE = "full";
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
    expect(String(result.next_step)).toContain("unbrowse_breath_get");
    expect(result.action_dag).toBeArray();
    expect(String(result.next_step)).toContain("marketplace publish");
    expect(result.discovery_mode).toBe("automatic_on_direct_miss");
    expect(result.resolve_mode).toBe("cache_only");
    expect(result.relevant_options).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: "canonical_action_dag", next_tools: ["unbrowse_breath_get"] }),
      expect.objectContaining({ mode: "auth_then_retry" }),
    ]));
    expect(result.suggested_tool_sequence).toEqual(["unbrowse_breath_get"]);
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
