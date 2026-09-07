import { describe, expect, it, beforeEach } from "bun:test";
import {
  _clearProcessResolutionForTests,
  bindActHooks,
  buildCapabilityLayers,
  defaultActSettled,
  documentEscalationSettled,
  executeResultLayer,
  processResolutionLayer,
  resolutionMemoryLayer,
  softOkQualityScore,
  walkCapabilityLayers,
  walkDocumentEscalationLayers,
} from "../src/values/layer-adapters.js";
import { DEFAULT_LAYER_COSTS } from "../src/values/semantic-layer-walk.js";
import {
  _clearExecuteResultCacheForTests,
  executeCacheKey,
  setCachedExecuteResult,
} from "../src/execution/execute-result-cache.js";

describe("layer adapters", () => {
  beforeEach(() => {
    _clearExecuteResultCacheForTests();
    _clearProcessResolutionForTests();
  });

  it("executeResultLayer hits TTL cache before act", async () => {
    const keyInput = () => ({
      skillId: "s1",
      endpointId: "e1",
      params: { q: "x" },
    });
    setCachedExecuteResult(executeCacheKey(keyInput()), { rows: [1] });

    let acts = 0;
    const layer = executeResultLayer<{ rows: number[] }>({
      keyInput,
      act: async () => {
        acts += 1;
        return { rows: [2] };
      },
    });

    const hit = await layer.get({ intent: "list", context: { skillId: "s1", endpointId: "e1", params: { q: "x" } } });
    expect(hit?.value).toEqual({ rows: [1] });
    expect(acts).toBe(0);
  });

  it("walkCapabilityLayers prefers resolution warm over browser act", async () => {
    const res = resolutionMemoryLayer<string>();
    res.put({ intent: "get weather", key: "weather" }, "warm");

    // rebuild stack manually to inject pre-warmed resolution
    let browserActs = 0;
    const layers = [
      res,
      ...buildCapabilityLayers<string>({
        sharedResolution: false,
        browser: async () => {
          browserActs += 1;
          return "browser";
        },
      }).filter((l) => l.id !== "resolution"),
    ];

    const { walkLayers } = await import("../src/values/semantic-layer-walk.js");
    const r = await walkLayers(layers, { intent: "get weather", key: "weather" });
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("resolution");
    expect(r.value).toBe("warm");
    expect(browserActs).toBe(0);
  });

  it("walkCapabilityLayers acts free rescue before paid", async () => {
    const order: string[] = [];
    const r = await walkCapabilityLayers<string>(
      { intent: "hard site", key: "https://example.com", context: { url: "https://example.com" } },
      {
        rescueFree: async () => {
          order.push("free");
          return "cleared";
        },
        rescuePaid: async () => {
          order.push("paid");
          return "paid-cleared";
        },
        browser: async () => {
          order.push("browser");
          return "dom";
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("rescue_free");
    expect(order).toEqual(["free"]);
  });

  it("act_hooks_bind: free act warms process resolution for the next walk", async () => {
    const query = {
      intent: "hard site warm",
      key: "https://warm.example",
      context: { url: "https://warm.example" },
    };
    let freeActs = 0;
    const hooks = {
      rescueFree: async () => {
        freeActs += 1;
        return "cleared-once";
      },
      rescuePaid: async () => "should-not-run",
      browser: async () => "should-not-run",
    };

    const first = await walkCapabilityLayers<string>(query, hooks);
    expect(first.ok).toBe(true);
    expect(first.layer).toBe("rescue_free");
    expect(first.via).toBe("act");
    expect(freeActs).toBe(1);

    const second = await walkCapabilityLayers<string>(query, hooks);
    expect(second.ok).toBe(true);
    expect(second.layer).toBe("resolution");
    expect(second.via).toBe("hit");
    expect(second.value).toBe("cleared-once");
    expect(freeActs).toBe(1); // no second free egress
  });

  it("bindActHooks does not warm soft-green (settled false) values", async () => {
    let freeActs = 0;
    const query = { intent: "soft", key: "https://soft.example", context: { url: "https://soft.example" } };

    // Soft free alone must not settle and must not warm process resolution.
    const softOnly = bindActHooks<{ ok: boolean; task_ok: boolean }>({
      settled: (_q, v) => v.task_ok !== false,
      rescueFree: async () => {
        freeActs += 1;
        return { ok: true, task_ok: false };
      },
    });
    const miss = await walkCapabilityLayers(query, softOnly);
    expect(miss.ok).toBe(false);
    expect(freeActs).toBe(1);
    expect(processResolutionLayer<{ ok: boolean; task_ok: boolean }>().get(query)).toBeNull();

    // Soft free then hard paid: escalate, paid may warm, soft free must not stick.
    freeActs = 0;
    _clearProcessResolutionForTests();
    const hooks = bindActHooks<{ ok: boolean; task_ok: boolean }>({
      settled: (_q, v) => v.task_ok !== false,
      rescueFree: async () => {
        freeActs += 1;
        return { ok: true, task_ok: false };
      },
      rescuePaid: async () => {
        freeActs += 10;
        return { ok: true, task_ok: true };
      },
    });

    const r = await walkCapabilityLayers(query, hooks);
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("rescue_paid");
    expect(freeActs).toBe(11);

    const warm = processResolutionLayer<{ ok: boolean; task_ok: boolean }>().get(query);
    expect(warm?.value).toEqual({ ok: true, task_ok: true });
    expect(warm?.value.task_ok).not.toBe(false);
  });

  it("buildCapabilityLayers orders by DEFAULT costs", () => {
    const layers = buildCapabilityLayers({
      rescueFree: async () => null,
      rescuePaid: async () => null,
      browser: async () => null,
      execute: async () => null,
    });
    const ids = layers.map((l) => l.id);
    expect(ids.indexOf("resolution")).toBeLessThan(ids.indexOf("execute"));
    expect(ids.indexOf("execute")).toBeLessThan(ids.indexOf("rescue_free"));
    expect(ids.indexOf("rescue_free")).toBeLessThan(ids.indexOf("rescue_paid"));
    expect(ids.indexOf("rescue_paid")).toBeLessThan(ids.indexOf("browser"));
  });

  it("walkDocumentEscalationLayers settles free before paid/browser", async () => {
    const order: string[] = [];
    const r = await walkDocumentEscalationLayers<{ ok: true; text: string }>(
      { intent: "read page", key: "https://hard.example", context: { url: "https://hard.example" } },
      {
        freeHtml: async () => {
          order.push("free");
          return { html: "<html>free body content here</html>", via: "fetch-ladder:direct", bytes: 40 };
        },
        paidHtml: async () => {
          order.push("paid");
          return { html: "<html>paid</html>", via: "x402-unblocker", bytes: 20 };
        },
        browserHtml: async () => {
          order.push("browser");
          return { html: "<html>browser</html>", via: "browser-render", bytes: 30 };
        },
        accept: (html, via) => ({ ok: true as const, text: `${via}:${html.length}` }),
      },
    );
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("rescue_free");
    expect(r.value?.via).toBe("fetch-ladder:direct");
    expect(order).toEqual(["free"]);
  });

  it("walkDocumentEscalationLayers rejects free HTML and escalates to paid", async () => {
    const order: string[] = [];
    const r = await walkDocumentEscalationLayers<{ ok: true }>(
      { intent: "read page", key: "https://hard.example", context: { url: "https://hard.example" } },
      {
        freeHtml: async () => {
          order.push("free");
          return { html: "<html>challenge</html>", via: "fetch-ladder:direct", bytes: 20 };
        },
        paidHtml: async () => {
          order.push("paid");
          return { html: "<html>real content</html>", via: "x402-unblocker", bytes: 30 };
        },
        browserHtml: async () => {
          order.push("browser");
          return { html: "<html>dom</html>", via: "browser-render", bytes: 10 };
        },
        accept: (html, via) => {
          if (via.startsWith("fetch-ladder")) return null; // still blocked
          return { ok: true as const };
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("rescue_paid");
    expect(order).toEqual(["free", "paid"]);
  });

  it("soft_green_verdict_gate: task_ok false does not settle; escalates", async () => {
    const order: string[] = [];
    const r = await walkDocumentEscalationLayers<{ rejected: false; task_ok: boolean }>(
      { intent: "list items", key: "https://soft-doc.example", context: { url: "https://soft-doc.example" } },
      {
        freeHtml: async () => {
          order.push("free");
          return { html: "<html>thin chrome only</html>", via: "fetch-ladder:direct", bytes: 30 };
        },
        paidHtml: async () => {
          order.push("paid");
          return { html: "<html>full content with rows</html>", via: "x402-unblocker", bytes: 40 };
        },
        accept: (_html, via) => {
          if (via.startsWith("fetch-ladder")) {
            return { rejected: false as const, task_ok: false };
          }
          return { rejected: false as const, task_ok: true };
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("rescue_paid");
    expect(r.value?.document.task_ok).toBe(true);
    expect(order).toEqual(["free", "paid"]);
    expect(
      documentEscalationSettled(
        { intent: "x" },
        { document: { rejected: false, task_ok: false }, via: "x", bytes: 1 },
      ),
    ).toBe(false);
  });

  it("softOkQualityScore: soft-green markers score 0; hard settle scores 1", () => {
    expect(softOkQualityScore(null)).toBe(0);
    expect(softOkQualityScore({ rejected: true })).toBe(0);
    expect(softOkQualityScore({ task_ok: false })).toBe(0);
    expect(softOkQualityScore({ ok: false })).toBe(0);
    expect(softOkQualityScore({ error: "no_endpoints" })).toBe(0);
    expect(softOkQualityScore({ error: "origin_ssl:ssl handshake failed" })).toBe(0);
    expect(softOkQualityScore({ error: "origin_dns enotfound" })).toBe(0);
    expect(softOkQualityScore({ document: { task_ok: false }, via: "x", bytes: 1 })).toBe(0);
    expect(softOkQualityScore({ ok: true, rows: [1] })).toBe(1);
    expect(softOkQualityScore({ document: { task_ok: true }, via: "rescue_free", bytes: 10 })).toBe(1);
    expect(softOkQualityScore("plain-string-settle")).toBe(1);
    expect(defaultActSettled({ intent: "x" }, { task_ok: false })).toBe(false);
    expect(defaultActSettled({ intent: "x" }, { ok: true })).toBe(true);
    // settled gate aligns with quality score
    expect(
      documentEscalationSettled(
        { intent: "x" },
        { document: { rejected: true }, via: "browser", bytes: 0 },
      ),
    ).toBe(false);
    expect(
      documentEscalationSettled(
        { intent: "x" },
        { document: { ok: true }, via: "rescue_free", bytes: 20 },
      ),
    ).toBe(true);
  });

  it("default ActHooks settled rejects soft-ok without explicit settled override", async () => {
    const query = { intent: "soft default", key: "https://soft-default.example", context: { url: "https://soft-default.example" } };
    const r = await walkCapabilityLayers(query, {
      rescueFree: async () => ({ ok: true, task_ok: false, error: "no_json" }),
      rescuePaid: async () => ({ ok: true, rows: [1] }),
    });
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("rescue_paid");
    expect(processResolutionLayer().get(query)?.value).toEqual({ ok: true, rows: [1] });
  });

  it("N4 production path: free settle costPaid = resolution+execute+rescue_free; warm is free", async () => {
    const query = {
      intent: "n4 costs",
      key: "https://n4.example/api/items",
      context: { url: "https://n4.example/api/items" },
    };
    let freeActs = 0;
    const hooks = {
      rescueFree: async () => {
        freeActs += 1;
        return { ok: true, items: [1] };
      },
      rescuePaid: async () => {
        freeActs += 100;
        return { ok: true, items: [2] };
      },
      browser: async () => {
        freeActs += 1000;
        return { ok: true, items: [3] };
      },
    };

    const first = await walkCapabilityLayers(query, hooks);
    expect(first.ok).toBe(true);
    expect(first.layer).toBe("rescue_free");
    expect(first.via).toBe("act");
    // resolution miss + execute miss + free act
    expect(first.costPaid).toBe(
      DEFAULT_LAYER_COSTS.resolution + DEFAULT_LAYER_COSTS.execute + DEFAULT_LAYER_COSTS.rescue_free,
    );
    expect(freeActs).toBe(1);

    const second = await walkCapabilityLayers(query, hooks);
    expect(second.ok).toBe(true);
    expect(second.layer).toBe("resolution");
    expect(second.via).toBe("hit");
    expect(second.costPaid).toBe(DEFAULT_LAYER_COSTS.resolution);
    expect(freeActs).toBe(1);
  });
});
