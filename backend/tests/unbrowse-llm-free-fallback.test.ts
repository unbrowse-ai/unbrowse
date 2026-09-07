import { test, expect } from "bun:test";
import { compileAikoPromptToTree } from "../src/services/unbrowse-llm";

// Witness for the 2-tier chain: NVIDIA free (nemotron-nano-9b-v2, 128k) is PRIMARY;
// Nebius Nano-Omni (paid, private) is the FALLBACK. Fails closed when no key exists.
const JSON_OK = () => new Response(
  JSON.stringify({ choices: [{ message: { content: '{"prompt":"p","evaluators":[],"children":[]}' } }] }),
  { status: 200, headers: { "Content-Type": "application/json" } },
);

test("NVIDIA free tier is PRIMARY — serves directly, never touches paid Nebius", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    if (String(url).includes("integrate.api.nvidia.com")) return JSON_OK();
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  try {
    const env = { UNBROWSE_LLM_API_KEY: "nebius-key", NVIDIA_API_KEY: "nvidia-key" } as never;
    const tree = await compileAikoPromptToTree(env, "p");
    expect(tree).not.toBeNull();
    expect(calls[0].includes("integrate.api.nvidia.com")).toBe(true);          // free served first
    expect(calls.some((c) => c.includes("nebius.com"))).toBe(false);           // paid never hit
  } finally { globalThis.fetch = realFetch; }
});

test("falls back to paid Nebius when the NVIDIA free tier fails", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url); calls.push(u);
    if (u.includes("integrate.api.nvidia.com")) return new Response("free down", { status: 503 });
    if (u.includes("nebius.com")) return JSON_OK();
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  try {
    const env = { UNBROWSE_LLM_API_KEY: "nebius-key", NVIDIA_API_KEY: "nvidia-key" } as never;
    const tree = await compileAikoPromptToTree(env, "p");
    expect(tree).not.toBeNull();
    expect(calls.some((c) => c.includes("integrate.api.nvidia.com"))).toBe(true);  // tried free first
    expect(calls.some((c) => c.includes("nebius.com"))).toBe(true);                // fell to paid
  } finally { globalThis.fetch = realFetch; }
});

test("no keys -> fails closed (no fabricated success)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  try {
    const env = {} as never;                                   // no NVIDIA key, no Nebius key
    expect(await compileAikoPromptToTree(env, "p")).toBeNull();  // null = no usable key on any tier
  } finally { globalThis.fetch = realFetch; }
});

test("research tier (flag-gated) LEADS the chain when configured — free nano-9b not hit first", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url); calls.push(u);
    if (u.includes("openrouter.ai")) return JSON_OK();          // research tier serves
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  try {
    const env = {
      NVIDIA_API_KEY: "nvidia-key",
      RESEARCH_LLM_MODEL: "openai/gpt-5.4",
      RESEARCH_LLM_API_KEY: "openrouter-key",
    } as never;
    const tree = await compileAikoPromptToTree(env, "p");
    expect(tree).not.toBeNull();
    expect(calls[0].includes("openrouter.ai")).toBe(true);     // strong tier tried FIRST
    expect(calls.some((c) => c.includes("nvidia.com"))).toBe(false); // never needed the free tier
  } finally { globalThis.fetch = realFetch; }
});

test("research tier OFF by default — free nano-9b stays primary when unset", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url); calls.push(u);
    if (u.includes("integrate.api.nvidia.com")) return JSON_OK();
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  try {
    // RESEARCH_LLM_API_KEY present but no MODEL → tier stays off (both required).
    const env = { NVIDIA_API_KEY: "nvidia-key", RESEARCH_LLM_API_KEY: "openrouter-key" } as never;
    const tree = await compileAikoPromptToTree(env, "p");
    expect(tree).not.toBeNull();
    expect(calls[0].includes("integrate.api.nvidia.com")).toBe(true);  // free primary, unchanged
    expect(calls.some((c) => c.includes("openrouter.ai"))).toBe(false);
  } finally { globalThis.fetch = realFetch; }
});
