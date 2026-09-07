import { describe, expect, test } from "bun:test";
import { decomposeGraphqlEndpoint } from "../src/execution/index.js";

// decomposeGraphqlEndpoint never emits an `aliases` field on agentParams.
// Earlier code in orchestrator/index.ts unconditionally read ap.aliases.length,
// crashing the entire resolve flow on x.com (and any GraphQL host) with
// "undefined is not an object (evaluating 'ap.aliases.length')".
//
// Lock the producer's contract: aliases is genuinely absent.
describe("graphql agentParams shape", () => {
  test("agentParams have no aliases key", () => {
    const ep = {
      url_template: "https://x.com/i/api/graphql/abc/HomeTimeline",
      method: "POST",
      semantic: {
        example_request: {
          variables: { count: 20, includePromotedContent: true },
        },
      },
    } as any;
    const decomp = decomposeGraphqlEndpoint(ep);
    expect(decomp.isGraphql).toBe(true);
    expect(decomp.agentParams.length).toBeGreaterThan(0);
    for (const ap of decomp.agentParams) {
      expect((ap as any).aliases).toBeUndefined();
    }
  });

  test("orchestrator-style read does not crash on missing aliases", () => {
    const ap = { key: "rawQuery", semantic_type: "string", required: false, example: "x", variables_path: "rawQuery" };
    const aliases = (ap as { aliases?: string[] }).aliases ?? [];
    expect(aliases.length).toBe(0);
    const out = {
      key: aliases.length > 0 ? aliases[0] : ap.key,
      type: ap.semantic_type,
    };
    expect(out.key).toBe("rawQuery");
  });
});
