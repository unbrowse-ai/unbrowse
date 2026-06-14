/**
 * tencent-waf-solve.test — the Capzy-backed Tencent WAF (TCaptcha) solve path.
 * Yoinked from capzy-ai/Tencent-Solver. All network is mocked; these lock the
 * challenge parse, the createTask/getTaskResult protocol, the proxy-variant task
 * shape, and the /WafCaptcha clearance body (Captcha.js join('\n') format).
 */
import { test, expect } from "bun:test";
import {
  extractTencentChallenge,
  solveTencentViaCapzy,
  submitWafClearance,
  parseCapzyProxy,
  mergeCookieHeader,
  clearTencentWafViaCapzy,
} from "../src/execution/tencent-waf-solve.js";

// A faithful slice of rootdata.com's real WAF stub.
const ROOTDATA_STUB = `
  <html><head><script>
    var seqid = "b68b55f16e25f141__captcha"
  </script>
  <script id="CaptchaScript" src="https://sg.captcha.qcloud.com/Captcha.js"></script>
  <script>
    var captcha = new Captcha('188999876', function(res){
      var captchaResult = []
      captchaResult.push(res.ret)
      if(res.ret === 0){ captchaResult.push(res.ticket); captchaResult.push(res.randstr); captchaResult.push(seqid) }
      loadXMLDoc("/WafCaptcha", captchaResult.join('\\n'))
    })
    captcha.show()
  </script></head></html>`;

test("extractTencentChallenge pulls appId + seqid from the real rootdata stub", () => {
  const c = extractTencentChallenge(ROOTDATA_STUB);
  expect(c).not.toBeNull();
  expect(c!.appId).toBe("188999876");
  expect(c!.seqid).toBe("b68b55f16e25f141__captcha");
});

test("extractTencentChallenge returns null on a normal page", () => {
  expect(extractTencentChallenge("<html><body><h1>Investors</h1></body></html>")).toBeNull();
});

test("solveTencentViaCapzy returns null without a key (honest degrade, no fake token)", async () => {
  const r = await solveTencentViaCapzy({ websiteURL: "https://www.rootdata.com/Investors", appId: "188999876", clientKey: "" });
  expect(r).toBeNull();
});

test("solveTencentViaCapzy walks createTask → getTaskResult(ready) → ticket+randstr", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const mockFetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/createTask")) {
      return new Response(JSON.stringify({ taskId: "tk_1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "ready", solution: { ticket: "tdc_RTAAyXfmW9Vy", randstr: "@xC1", appid: "188999876" } }), { status: 200 });
  }) as unknown as typeof fetch;

  const r = await solveTencentViaCapzy({
    websiteURL: "https://www.rootdata.com/Investors",
    appId: "188999876",
    clientKey: "capzy_test",
    fetchImpl: mockFetch,
  });
  expect(r).toEqual({ ticket: "tdc_RTAAyXfmW9Vy", randstr: "@xC1", appid: "188999876" });
  // proxyless task shape when no proxy supplied
  expect(calls[0].body.task.type).toBe("TencentTaskProxyLess");
  expect(calls[0].body.task.websiteKey).toBe("188999876");
  expect(calls[0].body.clientKey).toBe("capzy_test");
});

test("solveTencentViaCapzy uses TencentTask + proxy fields when a proxy is given", async () => {
  let createdBody: any = null;
  const mockFetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/createTask")) { createdBody = body; return new Response(JSON.stringify({ taskId: "tk_2" }), { status: 200 }); }
    return new Response(JSON.stringify({ status: "ready", solution: { ticket: "t", randstr: "r" } }), { status: 200 });
  }) as unknown as typeof fetch;

  await solveTencentViaCapzy({
    websiteURL: "https://www.rootdata.com/Investors",
    appId: "188999876",
    clientKey: "capzy_test",
    proxy: { type: "http", address: "geo.iproyal.com", port: 12321, login: "u", password: "p" },
    fetchImpl: mockFetch,
  });
  expect(createdBody.task.type).toBe("TencentTask");
  expect(createdBody.task.proxyType).toBe("http");
  expect(createdBody.task.proxyAddress).toBe("geo.iproyal.com");
  expect(createdBody.task.proxyPort).toBe(12321);
  expect(createdBody.task.proxyLogin).toBe("u");
});

test("submitWafClearance builds the Captcha.js join('\\n') body and returns Set-Cookie", async () => {
  let seenBody = "";
  const mockFetch = (async (_url: string, init: any) => {
    seenBody = init.body;
    return new Response("ok", { status: 200, headers: { "set-cookie": "TDC_itoken=cleared; Path=/" } });
  }) as unknown as typeof fetch;

  const r = await submitWafClearance({
    wafUrl: "https://www.rootdata.com/WafCaptcha",
    ticket: "tdc_RTAAyXfmW9Vy",
    randstr: "@xC1",
    seqid: "b68b55f16e25f141__captcha",
    fetchImpl: mockFetch,
  });
  expect(seenBody).toBe("0\ntdc_RTAAyXfmW9Vy\n@xC1\nb68b55f16e25f141__captcha");
  expect(r.ok).toBe(true);
  expect(r.setCookies.some((c) => c.includes("TDC_itoken=cleared"))).toBe(true);
});

test("parseCapzyProxy splits a credentialed IProyal URL into the Capzy proxy shape", () => {
  const p = parseCapzyProxy("http://user:pa%40ss@geo.iproyal.com:12321");
  expect(p).toEqual({ type: "http", address: "geo.iproyal.com", port: 12321, login: "user", password: "pa@ss" });
});

test("mergeCookieHeader applies Set-Cookie over the prior jar (last write wins)", () => {
  const merged = mergeCookieHeader("TDC_itoken=old; foo=bar", ["TDC_itoken=cleared; Path=/", "waf=1; HttpOnly"]);
  expect(merged).toContain("TDC_itoken=cleared");
  expect(merged).toContain("foo=bar");
  expect(merged).toContain("waf=1");
  expect(merged).not.toContain("TDC_itoken=old");
});

test("clearTencentWafViaCapzy composes stub→solve→submit→replay into real HTML", async () => {
  const REAL = "<html><body><table><tr><td>Andreessen Horowitz</td><td>portfolio</td></tr></table></body></html>";
  const mockFetch = (async (url: string, init: any) => {
    const s = String(url);
    if (s.endsWith("/createTask")) return new Response(JSON.stringify({ taskId: "tk" }), { status: 200 });
    if (s.endsWith("/getTaskResult")) return new Response(JSON.stringify({ status: "ready", solution: { ticket: "T", randstr: "R" } }), { status: 200 });
    if (s.endsWith("/WafCaptcha")) return new Response("ok", { status: 200, headers: { "set-cookie": "waf_clearance=ok; Path=/" } });
    // the replay GET of the real page
    return new Response(REAL, { status: 200 });
  }) as unknown as typeof fetch;

  const r = await clearTencentWafViaCapzy({
    url: "https://www.rootdata.com/Investors",
    html: ROOTDATA_STUB,
    capzyKey: "capzy_test",
    cookieHeader: "TDC_itoken=pre",
    fetchImpl: mockFetch,
  });
  expect(r).not.toBeNull();
  expect(r!.html).toContain("Andreessen Horowitz");
  expect(r!.cookieHeader).toContain("waf_clearance=ok");
});

test("clearTencentWafViaCapzy returns null when the replay is STILL challenged (no fake clear)", async () => {
  const mockFetch = (async (url: string) => {
    const s = String(url);
    if (s.endsWith("/createTask")) return new Response(JSON.stringify({ taskId: "tk" }), { status: 200 });
    if (s.endsWith("/getTaskResult")) return new Response(JSON.stringify({ status: "ready", solution: { ticket: "T", randstr: "R" } }), { status: 200 });
    if (s.endsWith("/WafCaptcha")) return new Response("ok", { status: 200, headers: { "set-cookie": "x=1" } });
    return new Response(ROOTDATA_STUB, { status: 200 }); // replay still the captcha stub
  }) as unknown as typeof fetch;

  const r = await clearTencentWafViaCapzy({ url: "https://www.rootdata.com/Investors", html: ROOTDATA_STUB, capzyKey: "k", fetchImpl: mockFetch });
  expect(r).toBeNull();
});
