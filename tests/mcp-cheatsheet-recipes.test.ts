import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleRequest } from "../src/mcp.js";

// Spec for plan acceptance #5, #6: prompts/list returns workflow:* recipes,
// prompts/get returns templated messages array naming the canonical sequence.

type Frame = { jsonrpc: "2.0" } & Record<string, unknown>;
let captured: Frame[] = [];
let origWrite: typeof process.stdout.write;

beforeEach(() => {
  captured = [];
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try { captured.push(JSON.parse(t)); } catch { /* not JSON */ }
    }
    return true;
  }) as any;
});

afterEach(() => {
  (process.stdout as any).write = origWrite;
});

async function call(method: string, params?: Record<string, unknown>): Promise<Frame> {
  captured = [];
  await handleRequest({ jsonrpc: "2.0", id: 1, method, params } as any);
  const reply = captured.find((f) => f.id === 1);
  if (!reply) throw new Error(`no reply for ${method}`);
  return reply;
}

describe("prompts/list workflow recipes (Phase 3)", () => {
  test("returns at least 2 entries whose name starts with workflow:", async () => {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    const r = await call("prompts/list");
    const prompts = (r.result as any).prompts as Array<{ name: string }>;
    const workflows = prompts.filter((p) => p.name.startsWith("workflow:"));
    expect(workflows.length).toBeGreaterThanOrEqual(2);
  });

  test("workflow:resolve-execute-feedback is registered", async () => {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    const r = await call("prompts/list");
    const names = (r.result as any).prompts.map((p: any) => p.name);
    expect(names).toContain("workflow:resolve-execute-feedback");
  });

  test("workflow:browse-and-publish is registered", async () => {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    const r = await call("prompts/list");
    const names = (r.result as any).prompts.map((p: any) => p.name);
    expect(names).toContain("workflow:browse-and-publish");
  });
});

describe("prompts/get returns templated messages (Phase 3)", () => {
  test("workflow:resolve-execute-feedback templates intent + names tool sequence", async () => {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    const r = await call("prompts/get", {
      name: "workflow:resolve-execute-feedback",
      arguments: { intent: "search reddit for X", url: "https://reddit.com" },
    });
    const result = r.result as any;
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    const body = JSON.stringify(result.messages);
    // Must name the canonical sequence in order
    const resolveIdx = body.indexOf("unbrowse_resolve");
    const executeIdx = body.indexOf("unbrowse_execute");
    const feedbackIdx = body.indexOf("unbrowse_feedback");
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(executeIdx).toBeGreaterThan(resolveIdx);
    expect(feedbackIdx).toBeGreaterThan(executeIdx);
    // Template substitution
    expect(body).toContain("search reddit for X");
  });

  test("workflow:browse-and-publish names go → close → review → publish", async () => {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    const r = await call("prompts/get", {
      name: "workflow:browse-and-publish",
      arguments: { intent: "find food", url: "https://eatigo.com/sg/singapore" },
    });
    const body = JSON.stringify((r.result as any).messages);
    const goIdx = body.indexOf("unbrowse_go");
    const closeIdx = body.indexOf("unbrowse_close");
    const reviewIdx = body.indexOf("unbrowse_review");
    const publishIdx = body.indexOf("unbrowse_publish");
    expect(goIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(goIdx);
    expect(reviewIdx).toBeGreaterThan(closeIdx);
    expect(publishIdx).toBeGreaterThan(reviewIdx);
    expect(body).toContain("eatigo.com");
  });
});

// ─── Edges (Step 5) ─────────────────────────────────────────────────────────

describe("recipe template adversarial inputs (Step 5)", () => {
  test("intent with regex special chars + HTML doesn't crash the template", async () => {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    const adversarial = "<script>alert(1)</script> .* $1 \\n {curlies} `code`";
    const r = await call("prompts/get", {
      name: "workflow:resolve-execute-feedback",
      arguments: { intent: adversarial },
    });
    const body = JSON.stringify((r.result as any).messages);
    expect(body).toContain("alert(1)");        // intent text is preserved verbatim
    expect(body).toContain("\\\\n");           // backslash-n stays literal (escaped in JSON)
    expect(body).toContain("{curlies}");
  });

  test("missing required arg falls back to placeholder, doesn't error", async () => {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    const r = await call("prompts/get", {
      name: "workflow:browse-and-publish",
      arguments: {}, // no intent, no url
    });
    expect(r.error).toBeUndefined();
    const body = JSON.stringify((r.result as any).messages);
    expect(body).toContain("<the user's intent>"); // fallback placeholder
    expect(body).toContain("<target page url>");
  });

  test("unknown prompt name returns a clean -32602 error", async () => {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    captured = [];
    await handleRequest({ jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "workflow:does-not-exist" } } as any);
    const reply = captured.find((f) => f.id === 1);
    expect((reply as any)?.error?.code).toBe(-32602);
  });
});
