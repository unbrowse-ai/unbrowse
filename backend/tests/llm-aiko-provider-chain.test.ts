import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_AIKO_LLM_MODEL,
  proxyToXgate,
  resolveModelPricing,
} from "../src/services/xgate.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function chatOk(content = "ok") {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: DEFAULT_AIKO_LLM_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Aiko LLM provider chain", () => {
  test("DiffusionGemma has local route pricing even when xgate catalog does not list it", async () => {
    const pricing = await resolveModelPricing(DEFAULT_AIKO_LLM_MODEL, {} as never);
    expect(pricing?.provider).toBe("aiko");
    expect(pricing?.id).toBe(DEFAULT_AIKO_LLM_MODEL);
    expect(pricing?.output_per_1m).toBeGreaterThan(0);
  });

  test("NVIDIA/Aiko primary serves first and does not touch local or xgate", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes("integrate.api.nvidia.com")) return chatOk("primary");
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const out = await proxyToXgate(
      {
        NVIDIA_API_KEY: "nvidia-key",
        UNBROWSE_LOCAL_LLM_URL: "http://127.0.0.1:8000",
      } as never,
      { model: DEFAULT_AIKO_LLM_MODEL, body: { messages: [{ role: "user", content: "hi" }] } },
    );

    expect(out.status).toBe(200);
    expect(out.headers["x-aiko-provider"]).toBe("nvidia");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("integrate.api.nvidia.com");
  });

  test("local OpenAI-compatible endpoint is always the fallback before xgate", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes("integrate.api.nvidia.com")) return new Response("down", { status: 503 });
      if (url.includes("127.0.0.1:8000")) return chatOk("local");
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const out = await proxyToXgate(
      {
        NVIDIA_API_KEY: "nvidia-key",
        UNBROWSE_LOCAL_LLM_URL: "http://127.0.0.1:8000",
      } as never,
      { model: DEFAULT_AIKO_LLM_MODEL, body: { messages: [{ role: "user", content: "hi" }] } },
    );

    expect(out.status).toBe(200);
    expect(out.headers["x-aiko-provider"]).toBe("local");
    expect(out.headers["x-aiko-provider-fallbacks"]).toContain("nvidia: HTTP 503");
    expect(calls[0]).toContain("integrate.api.nvidia.com");
    expect(calls[1]).toContain("127.0.0.1:8000");
  });

  test("xgate remains the final x402-capable upstream fallback", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes("ai.xgate.run")) return chatOk("xgate");
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const out = await proxyToXgate(
      {} as never,
      { model: DEFAULT_AIKO_LLM_MODEL, body: { messages: [{ role: "user", content: "hi" }] } },
    );

    expect(out.status).toBe(200);
    expect(out.headers["x-aiko-provider"]).toBe("xgate");
    expect(calls).toEqual(["https://ai.xgate.run/v1/chat/completions"]);
  });
});
