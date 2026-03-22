import test from "node:test";
import assert from "node:assert/strict";

test("plugin exports correct structure", async () => {
  const mod = await import("../src/index.ts");
  const plugin = mod.unbrowsePlugin;

  assert.equal(plugin.name, "unbrowse");
  assert.ok(Array.isArray(plugin.actions));
  assert.ok(Array.isArray(plugin.services));
  assert.ok(Array.isArray(plugin.providers));
  assert.equal(plugin.actions!.length, 1);
  assert.equal(plugin.services!.length, 1);
  assert.equal(plugin.providers!.length, 1);
});

test("default export matches named export", async () => {
  const mod = await import("../src/index.ts");
  assert.strictEqual(mod.default, mod.unbrowsePlugin);
});

test("action has correct name and similes", async () => {
  const { unbrowseAction } = await import("../src/actions/unbrowse.ts");

  assert.equal(unbrowseAction.name, "UNBROWSE_FETCH");
  assert.ok(unbrowseAction.similes!.includes("FETCH_URL"));
  assert.ok(unbrowseAction.similes!.includes("WEB_SEARCH"));
  assert.ok(unbrowseAction.similes!.includes("GET_DATA_FROM_WEBSITE"));
});

test("action validate returns true", async () => {
  const { unbrowseAction } = await import("../src/actions/unbrowse.ts");
  const result = await unbrowseAction.validate(
    {} as any,
    {} as any
  );
  assert.equal(result, true);
});

test("action has examples array for LLM selection", async () => {
  const { unbrowseAction } = await import("../src/actions/unbrowse.ts");
  assert.ok(Array.isArray(unbrowseAction.examples));
  assert.ok(unbrowseAction.examples!.length >= 2);

  const first = unbrowseAction.examples![0];
  assert.ok(Array.isArray(first));
  assert.equal(first.length, 2);
  assert.equal(first[1].user, "{{agent}}");
  assert.equal(first[1].content.action, "UNBROWSE_FETCH");
});

test("buildArgs: resolve action maps correctly", async () => {
  const { buildArgs } = await import("../src/shared.ts");
  const args = buildArgs({
    action: "resolve",
    intent: "get prices",
    url: "https://example.com",
    path: "data.items[]",
    extract: "title,price",
    limit: 5,
    dryRun: true,
  });

  assert.deepEqual(args, [
    "resolve",
    "--intent",
    "get prices",
    "--url",
    "https://example.com",
    "--path",
    "data.items[]",
    "--extract",
    "title,price",
    "--limit",
    "5",
    "--dry-run",
  ]);
});

test("buildArgs: search action with domain", async () => {
  const { buildArgs } = await import("../src/shared.ts");
  const args = buildArgs({
    action: "search",
    intent: "find flights",
    domain: "kayak.com",
  });

  assert.deepEqual(args, [
    "search",
    "--intent",
    "find flights",
    "--domain",
    "kayak.com",
  ]);
});

test("buildArgs: execute action", async () => {
  const { buildArgs } = await import("../src/shared.ts");
  const args = buildArgs({
    action: "execute",
    skillId: "sk_123",
    endpointId: "ep_456",
    url: "https://example.com/search?q=openai",
    intent: "search packages",
    pretty: true,
  });

  assert.deepEqual(args, [
    "execute",
    "--skill",
    "sk_123",
    "--endpoint",
    "ep_456",
    "--url",
    "https://example.com/search?q=openai",
    "--intent",
    "search packages",
    "--pretty",
  ]);
});

test("buildArgs: health/skills/skill/login actions", async () => {
  const { buildArgs } = await import("../src/shared.ts");

  assert.deepEqual(buildArgs({ action: "health" }), ["health"]);
  assert.deepEqual(buildArgs({ action: "skills" }), ["skills"]);
  assert.deepEqual(buildArgs({ action: "skill", skillId: "sk_1" }), [
    "skill",
    "sk_1",
  ]);
  assert.deepEqual(buildArgs({ action: "login", url: "https://x.com" }), [
    "login",
    "--url",
    "https://x.com",
  ]);
});

test("buildArgs: throws on missing required params", async () => {
  const { buildArgs } = await import("../src/shared.ts");

  assert.throws(() => buildArgs({ action: "resolve", intent: "x" } as any), /url required/);
  assert.throws(() => buildArgs({ action: "resolve", url: "x" } as any), /intent required/);
  assert.throws(() => buildArgs({ action: "search" } as any), /intent required/);
  assert.throws(() => buildArgs({ action: "execute" } as any), /skillId required/);
  assert.throws(
    () => buildArgs({ action: "execute", skillId: "x" } as any),
    /endpointId required/
  );
  assert.throws(() => buildArgs({ action: "skill" } as any), /skillId required/);
  assert.throws(() => buildArgs({ action: "login" } as any), /url required/);
});

test("service registers as ServiceType.BROWSER", async () => {
  const { UnbrowseService } = await import("../src/services/unbrowse.ts");
  // ServiceType.BROWSER is the string "browser" in ElizaOS
  assert.equal((UnbrowseService as any).serviceType, "browser");
});

test("routing provider returns policy text", async () => {
  const { unbrowseRoutingProvider } = await import(
    "../src/providers/routing.ts"
  );

  const mockRuntime = {
    getSetting: (key: string) => {
      if (key === "UNBROWSE_ROUTING_MODE") return "strict";
      return undefined;
    },
  };

  const text = await unbrowseRoutingProvider.get(mockRuntime as any, {} as any);
  assert.match(text, /UNBROWSE_FETCH/);
  assert.match(text, /Strict mode is on/);
});

test("routing provider fallback mode omits strict warning", async () => {
  const { unbrowseRoutingProvider } = await import(
    "../src/providers/routing.ts"
  );

  const mockRuntime = {
    getSetting: (key: string) => {
      if (key === "UNBROWSE_ROUTING_MODE") return "fallback";
      return undefined;
    },
  };

  const text = await unbrowseRoutingProvider.get(mockRuntime as any, {} as any);
  assert.match(text, /UNBROWSE_FETCH/);
  assert.doesNotMatch(text, /Strict mode/);
});

test("summarizeOutput handles JSON and plain text", async () => {
  const { summarizeOutput } = await import("../src/shared.ts");

  assert.equal(summarizeOutput(""), "Unbrowse finished with no stdout.");
  assert.equal(
    summarizeOutput('{"error": "not found"}'),
    "Unbrowse error: not found"
  );
  assert.equal(
    summarizeOutput('{"message": "done"}'),
    "done"
  );
  assert.equal(
    summarizeOutput('{"data": {"items": []}}'),
    "Unbrowse returned structured data."
  );
  assert.equal(summarizeOutput("plain text output"), "plain text output");
});

test("parseMaybeJson parses JSON or returns raw string", async () => {
  const { parseMaybeJson } = await import("../src/shared.ts");

  assert.equal(parseMaybeJson(""), null);
  assert.deepEqual(parseMaybeJson('{"a":1}'), { a: 1 });
  assert.equal(parseMaybeJson("not json"), "not json");
});
