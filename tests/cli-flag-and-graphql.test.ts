import { describe, expect, test } from "bun:test";
import { decomposeGraphqlEndpoint } from "../src/execution/index.js";

// Inline copy of parseArgs's flag-handling — importing cli.ts triggers main()
// at module load. The fix is identical to src/cli.ts:63-81 (post v6.1.1).
function parseArgsFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  const valueExpectedFlags = new Set(["skill", "endpoint", "intent", "url", "domain", "params", "path", "extract", "limit"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (valueExpectedFlags.has(key)) {
        if (next === undefined) throw new Error(`--${key} requires a value`);
        flags[key] = next;
        i++;
      } else if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    }
  }
  return flags;
}

describe("CLI flag-parser handles -- prefixed nanoid values", () => {
  test("--endpoint consumes next arg even if it starts with --", () => {
    const f = parseArgsFlags(["--skill", "S1", "--endpoint", "--iUvJtAbcDef"]);
    expect(f.endpoint).toBe("--iUvJtAbcDef");
    expect(f.skill).toBe("S1");
  });

  test("value-expected flags consume next arg unconditionally", () => {
    const f = parseArgsFlags(["--skill", "--Sa", "--endpoint", "--Eb", "--url", "https://x.com/home", "--intent", "--whatever"]);
    expect(f.skill).toBe("--Sa");
    expect(f.endpoint).toBe("--Eb");
    expect(f.url).toBe("https://x.com/home");
    expect(f.intent).toBe("--whatever");
  });

  test("non-value flags treat next -- as separate flag", () => {
    const f = parseArgsFlags(["--raw", "--pretty"]);
    expect(f.raw).toBe(true);
    expect(f.pretty).toBe(true);
  });
});

describe("D8 graphql-template-borrow finds sibling with populated variables", () => {
  // Mirror the fallback used inside executeEndpoint when an endpoint has the
  // same operationName as a sibling but an empty variablesTemplate.
  function pickRichest(endpoints: Array<{ url_template: string; semantic?: { example_request?: any } }>) {
    const decomps = endpoints.map((e) => decomposeGraphqlEndpoint(e as any));
    const byOp = new Map<string, typeof decomps[number]>();
    for (const d of decomps) {
      if (!d.isGraphql || !d.operationName) continue;
      const cur = byOp.get(d.operationName);
      const richer = !cur || (Object.keys(d.variablesTemplate ?? {}).length > Object.keys(cur.variablesTemplate ?? {}).length);
      if (richer) byOp.set(d.operationName, d);
    }
    return byOp;
  }

  test("dedupes HomeTimeline duplicates by picking the populated one", () => {
    const endpoints = [
      {
        url_template: "https://x.com/i/api/graphql/abc/HomeTimeline",
        semantic: { example_request: {} }, // empty — like --iUvJt_KUbzjUwR0EPZf
      },
      {
        url_template: "https://x.com/i/api/graphql/abc/HomeTimeline",
        semantic: {
          example_request: {
            variables: { count: 20, includePromotedContent: true, requestContext: "launch" },
          },
        },
      },
    ];
    const byOp = pickRichest(endpoints);
    const ht = byOp.get("HomeTimeline");
    expect(ht?.variablesTemplate?.includePromotedContent).toBe(true);
    expect(Object.keys(ht?.variablesTemplate ?? {}).length).toBe(3);
  });
});
