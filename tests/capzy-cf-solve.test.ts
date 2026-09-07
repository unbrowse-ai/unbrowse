import { describe, it, expect } from "bun:test";
import {
  extractCfClearance,
  buildCfTask,
  solveCfViaCapzy,
} from "../src/execution/capzy-cf-solve.js";

describe("extractCfClearance — defensive over solution-envelope variants", () => {
  it("flat cf_clearance field + user_agent", () => {
    expect(extractCfClearance({ cf_clearance: "abc", user_agent: "UA" })).toEqual({
      cf_clearance: "abc",
      user_agent: "UA",
    });
  });
  it("solution.cookies as object", () => {
    expect(extractCfClearance({ cookies: { cf_clearance: "xyz" }, userAgent: "UA2" })).toEqual({
      cf_clearance: "xyz",
      user_agent: "UA2",
    });
  });
  it("solution.cookies as array of {name,value}", () => {
    expect(
      extractCfClearance({ cookies: [{ name: "cf_clearance", value: "arr" }] }),
    ).toEqual({ cf_clearance: "arr", user_agent: undefined });
  });
  it("solution.cookies as array of name=value strings", () => {
    expect(extractCfClearance({ cookies: ["cf_clearance=str; Path=/"] })).toEqual({
      cf_clearance: "str",
      user_agent: undefined,
    });
  });
  it("solution.token (non-turnstile) treated as clearance", () => {
    expect(extractCfClearance({ token: "tok", type: "challenge" })?.cf_clearance).toBe("tok");
  });
  it("turnstile token is NOT a clearance (honest null)", () => {
    expect(extractCfClearance({ token: "tstok", type: "turnstile" })).toBeNull();
  });
  it("no clearance anywhere → null (never fabricates)", () => {
    expect(extractCfClearance({ cookies: { other: "1" } })).toBeNull();
    expect(extractCfClearance(null)).toBeNull();
    expect(extractCfClearance("nope")).toBeNull();
  });
});

describe("buildCfTask — proxied task shape (CF requires a proxy — witnessed)", () => {
  it("always AntiCloudflareTask, carries proxy credentials", () => {
    const t = buildCfTask("https://x.test", {
      type: "http",
      address: "1.2.3.4",
      port: 8080,
      login: "u",
      password: "p",
    });
    expect(t.type).toBe("AntiCloudflareTask");
    expect(t).toMatchObject({ proxyType: "http", proxyAddress: "1.2.3.4", proxyPort: 8080, proxyLogin: "u", proxyPassword: "p" });
  });
});

describe("solveCfViaCapzy — full createTask→poll flow with mocked Capzy", () => {
  const PROXY = { type: "http" as const, address: "p", port: 1, login: "u", password: "p" };

  it("returns cf_clearance when Capzy reports ready", async () => {
    const calls: string[] = [];
    const mock: typeof fetch = (async (url: any) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/createTask")) {
        return new Response(JSON.stringify({ taskId: "T1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ status: "ready", solution: { cf_clearance: "CLR", user_agent: "UA" } }),
        { status: 200 },
      );
    }) as any;
    const out = await solveCfViaCapzy({ websiteURL: "https://x.test", clientKey: "k", proxy: PROXY, fetchImpl: mock });
    expect(out).toEqual({ cf_clearance: "CLR", user_agent: "UA" });
    expect(calls.some((c) => c.endsWith("/createTask"))).toBe(true);
    expect(calls.some((c) => c.endsWith("/getTaskResult"))).toBe(true);
  });

  it("honest null when no key configured", async () => {
    const prev = process.env.UNBROWSE_CAPZY_KEY;
    delete process.env.UNBROWSE_CAPZY_KEY;
    try {
      expect(await solveCfViaCapzy({ websiteURL: "https://x.test", proxy: PROXY })).toBeNull();
    } finally {
      if (prev !== undefined) process.env.UNBROWSE_CAPZY_KEY = prev;
    }
  });

  it("honest null when no proxy (CF requires a proxy — witnessed)", async () => {
    let called = false;
    const mock: typeof fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as any;
    expect(await solveCfViaCapzy({ websiteURL: "https://x.test", clientKey: "k", fetchImpl: mock })).toBeNull();
    expect(called).toBe(false); // returns before any network call
  });

  it("honest null on Capzy errorId", async () => {
    const mock: typeof fetch = (async (url: any) => {
      if (String(url).endsWith("/createTask")) {
        return new Response(JSON.stringify({ errorId: 1, errorCode: "ERROR_WRONG_TASK_TYPE" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as any;
    expect(await solveCfViaCapzy({ websiteURL: "https://x.test", clientKey: "k", proxy: PROXY, fetchImpl: mock })).toBeNull();
  });

  it("honest null + stops polling on terminal 'failed' (ERROR_CAPTCHA_UNSOLVABLE)", async () => {
    let polls = 0;
    const mock: typeof fetch = (async (url: any) => {
      if (String(url).endsWith("/createTask")) return new Response(JSON.stringify({ taskId: "T1" }), { status: 200 });
      polls++;
      return new Response(JSON.stringify({ status: "failed", errorId: 1, errorCode: "ERROR_CAPTCHA_UNSOLVABLE", solution: null }), { status: 200 });
    }) as any;
    expect(await solveCfViaCapzy({ websiteURL: "https://x.test", clientKey: "k", proxy: PROXY, fetchImpl: mock })).toBeNull();
    expect(polls).toBe(1); // terminal — does not poll to deadline
  });

  it("honest null when ready but solution carries no clearance", async () => {
    const mock: typeof fetch = (async (url: any) => {
      if (String(url).endsWith("/createTask")) return new Response(JSON.stringify({ taskId: "T1" }), { status: 200 });
      return new Response(JSON.stringify({ status: "ready", solution: { token: "x", type: "turnstile" } }), { status: 200 });
    }) as any;
    expect(await solveCfViaCapzy({ websiteURL: "https://x.test", clientKey: "k", proxy: PROXY, fetchImpl: mock })).toBeNull();
  });
});
