/**
 * capzy-solve.test — the generalized Capzy solver wired into captcha-solve.ts.
 * Vendor→live-task-type map + createTask/getTaskResult→token, all mocked. Task
 * names verified against capzy.ai/docs (36 enabled types, 2026-06-15).
 */
import { test, expect } from "bun:test";
import { capzyTaskTypeForVendor, solveCaptchaViaCapzy } from "../src/execution/captcha-solve.js";

test("capzyTaskTypeForVendor maps the live-supported vendors to exact Capzy task names", () => {
  expect(capzyTaskTypeForVendor("cloudflare")).toBe("AntiTurnstileTaskProxyLess");
  expect(capzyTaskTypeForVendor("recaptcha")).toBe("ReCaptchaV2TaskProxyLess");
  expect(capzyTaskTypeForVendor("funcaptcha")).toBe("FunCaptchaTaskProxyLess");
  expect(capzyTaskTypeForVendor("geetest")).toBe("GeeTestTaskProxyLess");
  expect(capzyTaskTypeForVendor("yidun")).toBe("YidunSliderTaskProxyLess");
  // Not in Capzy's 36 → null (falls through to paysponge).
  expect(capzyTaskTypeForVendor("hcaptcha")).toBeNull();
  expect(capzyTaskTypeForVendor("tencent_waf")).toBeNull();
});

test("solveCaptchaViaCapzy returns null without a key", async () => {
  const r = await solveCaptchaViaCapzy({ vendor: "cloudflare", body: '<div data-sitekey="0x4AAA"></div>', challengeUrl: "https://x.com", clientKey: "" });
  expect(r).toBeNull();
});

test("solveCaptchaViaCapzy returns no-token evidence for an unsupported vendor (hcaptcha)", async () => {
  const r = await solveCaptchaViaCapzy({ vendor: "hcaptcha", body: '<div data-sitekey="abc"></div>', challengeUrl: "https://x.com", clientKey: "k" });
  // capzyTaskTypeForVendor(hcaptcha) === null → solver returns null (caller → paysponge)
  expect(r).toBeNull();
});

test("solveCaptchaViaCapzy walks createTask→getTaskResult(ready)→token for Turnstile", async () => {
  const calls: any[] = [];
  const mockFetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/createTask")) return new Response(JSON.stringify({ errorId: 0, taskId: "tk", status: "processing" }), { status: 200 });
    return new Response(JSON.stringify({ errorId: 0, status: "ready", solution: { token: "0.eyJhbGci_TOKEN" } }), { status: 200 });
  }) as unknown as typeof fetch;

  const r = await solveCaptchaViaCapzy({
    vendor: "cloudflare",
    body: '<div class="cf-turnstile" data-sitekey="0x4AAAAAxyz"></div>',
    challengeUrl: "https://target.com/login",
    clientKey: "capzy_test",
    fetchImpl: mockFetch,
  });
  expect(r?.token).toBe("0.eyJhbGci_TOKEN");
  expect(r?.inject_key).toBe("cf-turnstile-response");
  expect(calls[0].body.task.type).toBe("AntiTurnstileTaskProxyLess");
  expect(calls[0].body.task.websiteKey).toBe("0x4AAAAAxyz");
  expect(calls[0].body.task.websiteURL).toBe("https://target.com/login");
});

test("solveCaptchaViaCapzy surfaces ERROR_TASK_NOT_SUPPORTED as no-token (honest, no fake)", async () => {
  const mockFetch = (async (url: string) => {
    if (String(url).endsWith("/createTask")) return new Response(JSON.stringify({ errorId: 1, errorCode: "ERROR_TASK_NOT_SUPPORTED" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const r = await solveCaptchaViaCapzy({ vendor: "cloudflare", body: '<div data-sitekey="0x4AAA"></div>', challengeUrl: "https://x.com", clientKey: "k", fetchImpl: mockFetch });
  expect(r && r.token).toBe("");
  expect((r as any).evidence.sub_state).toBe("capzy_create_failed");
});
