import { test, expect } from "bun:test";
import { compileAikoPromptToTree } from "../src/services/unbrowse-llm";

// Witness for "bake the aiko free-lane into unbrowse's /contract LLM chain":
// when the paid Nebius tiers are unavailable, the chain must fall back to the NVIDIA FREE tier
// (integrate.api.nvidia.com) — and must FAIL CLOSED (no fabricated success) when no free key exists.

test("contract LLM chain falls back to the NVIDIA free tier when the paid Nebius tiers fail", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("nebius.com")) return new Response("upstream down", { status: 503 });
    if (u.includes("integrate.api.nvidia.com")) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"prompt":"p","evaluators":[],"children":[]}' } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  try {
    const env = { UNBROWSE_LLM_API_KEY: "nebius-key", NVIDIA_API_KEY: "nvidia-key" } as never;
    const tree = await compileAikoPromptToTree(env, "p");
    expect(tree).not.toBeNull();
    expect(calls.some((c) => c.includes("integrate.api.nvidia.com"))).toBe(true);   // free tier fired
    expect(calls.filter((c) => c.includes("nebius.com")).length).toBe(3);            // after all 3 paid tiers
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("no NVIDIA key -> free tier skipped, fails closed (no fabricated success)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  try {
    const env = { UNBROWSE_LLM_API_KEY: "nebius-key" } as never;   // NO NVIDIA key
    await expect(compileAikoPromptToTree(env, "p")).rejects.toThrow();
  } finally {
    globalThis.fetch = realFetch;
  }
});
